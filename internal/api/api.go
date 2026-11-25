// Package api 是暴露给前端的 Wails 服务层（唯一依赖 Wails 的包）。
// 按域拆文件：actions.go（动作 CRUD/列表）、run.go（直跑执行）、workflows.go
// （workflow CRUD/执行）、ai.go（AI 任务 CRUD/列表）、events.go（事件发射器与顺序
// 协议）、devices.go（设备选择）、
// config.go（全局配置/片段）、dialog.go（原生对话框）、runregistry.go（运行簿记）、
// schedules.go（调度 CRUD 与到点发起）、runs.go（运行记录查询与接入点）。
package api

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"workflow-tool/internal/actionrun"
	"workflow-tool/internal/adb/binary"
	"workflow-tool/internal/adb/device"
	"workflow-tool/internal/ai"
	"workflow-tool/internal/airun"
	"workflow-tool/internal/applog"
	"workflow-tool/internal/builtinvars"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/runstore"
	"workflow-tool/internal/schedule"
	"workflow-tool/internal/target"
	"workflow-tool/internal/targetlock"
	"workflow-tool/internal/workflow"
)

// scheduleStateFile 是调度器「上次评估到的时刻」的持久化文件（可执行文件同级，不入仓库）。
const scheduleStateFile = "schedules.state.json"

// Service 是暴露给前端的 Wails 服务。
type Service struct {
	app       *application.App
	reg       *registry.Registry
	regMu     sync.RWMutex // registry 指针由 Reload 原子替换
	baseDir   string
	cfgPath   string // config.yaml 路径
	fragPath  string // fragments.yaml 路径
	global    map[string]string
	gMu       sync.Mutex // 保护 global 的读写
	fragments []registry.Fragment
	fMu       sync.Mutex // 保护 fragments 的读写
	// locks 是落盘的目标锁：应用内的运行、独立执行器与 CLI 运行对同一目标互斥（跨进程）。
	// 三个 runRegistry 经它占锁；执行器发起时也在这里探测目标是否被占。
	locks     *targetlock.Locks
	running   *runRegistry // action 运行簿记（拒绝并发/结束清理/取消）
	wfReg     *workflow.WorkflowRegistry
	wfMu      sync.RWMutex // registry 指针由 ReloadWorkflows 原子替换
	wfRunning *runRegistry // workflow 运行簿记
	aiReg     *ai.Registry
	aiMu      sync.RWMutex // aiReg 指针由 Reload 原子替换
	// aiRunning 是 AI 任务的目标锁簿记：手动运行与 workflow 的 ai step 共用，
	// 同一任务同一时刻只有一个运行（规格：目标锁与冲突）。
	aiRunning *runRegistry

	schedulePath    string
	scheduleMu      sync.Mutex
	scheduleDefs    []schedule.Definition
	scheduleErrors  []error
	scheduleRuns    map[string]*scheduleRunState
	scheduler       *schedule.Scheduler
	schedulerMu     sync.Mutex
	schedulerCancel context.CancelFunc
	// emitEvent 向前端推应用级事件（schedules:changed / runs:changed）；app 未注入时为 nil。
	emitEvent func(string, any)

	// runs 是运行记录存储（runs/<run-id>/）；打不开时为 nil，运行照常进行只是不留档。
	runs *runstore.Store
	// appLog 是应用日志（logs/app.log），记调度与运行器自身的行迹；nil 时静默。
	appLog *applog.Logger

	bin      *binary.Service       // adb/fastboot/scrcpy 路径探测
	dev      *device.Service       // 设备列表 + 激活 serial
	builtins *builtinvars.Registry // 内置变量注册表（CURRENT_DATE/CURRENT_TIME/ADB_SERIAL）
	runDeps  actionrun.Deps        // actionrun.Build 的共享依赖（两条执行路径共用）
	aiDeps   airun.Deps            // airun.Build 的共享依赖（手动运行与 workflow ai step 共用）
}

// New 创建 service。cfgPath 是全局配置 config.yaml 路径，fragPath 是 fragments.yaml 路径。
// app 通过 SetApp 在 main 里注入（打破循环依赖）。
func New(reg *registry.Registry, wfReg *workflow.WorkflowRegistry, baseDir, cfgPath, fragPath string) *Service {
	if reg == nil {
		reg = &registry.Registry{Actions: map[string]registry.LoadedAction{}, Skills: map[string]registry.SkillMeta{}}
	}
	g, _ := registry.LoadGlobal(cfgPath)
	if g == nil {
		g = map[string]string{}
	}
	frags, _ := registry.LoadFragments(fragPath)
	if frags == nil {
		frags = []registry.Fragment{}
	}
	if wfReg == nil {
		wfReg = &workflow.WorkflowRegistry{Workflows: map[string]workflow.LoadedWorkflow{}}
	}
	locks := targetlock.New(baseDir)
	svc := &Service{
		locks:        locks,
		reg:          reg,
		baseDir:      baseDir,
		cfgPath:      cfgPath,
		fragPath:     fragPath,
		global:       g,
		fragments:    frags,
		running:      newRunRegistry(target.Action, locks),
		wfReg:        wfReg,
		wfRunning:    newRunRegistry(target.Workflow, locks),
		aiReg:        ai.Load(filepath.Join(baseDir, "ai"), reg.Skills),
		aiRunning:    newRunRegistry(target.AI, locks),
		schedulePath: filepath.Join(baseDir, "schedules.yaml"),
		scheduleRuns: make(map[string]*scheduleRunState),
	}
	svc.scheduleDefs, svc.scheduleErrors = schedule.LoadFile(svc.schedulePath, svc.scheduleCatalog())
	svc.scheduleDefs, svc.scheduleErrors = svc.validateLoadedScheduleDefinitions(svc.scheduleDefs, svc.scheduleErrors)
	svc.scheduler = schedule.NewScheduler(svc.scheduleDefs, svc.launchSchedule)
	// 「立即运行」与到点指向同一目标、用同一份参数，但撞上运行中的目标时处置不同：
	// 前者把错误返回给发起人，后者留档为跳过。
	svc.scheduler.SetTriggerNow(svc.launchScheduleNow)
	// 追踪每条调度上次评估到的时刻：应用恢复后把其间溜走的到点逐个留档，按 catch_up 补跑。
	svc.scheduler.TrackMissed(filepath.Join(baseDir, scheduleStateFile), schedule.MissedHandlers{
		Missed: svc.missedInstant, CatchUp: svc.catchUp,
	})
	// 应用日志与运行记录都在可执行文件同级；打不开只是失去留档，不该挡住应用启动。
	if logger, err := applog.Open(baseDir); err != nil {
		log.Printf("app log unavailable: %v", err)
	} else {
		svc.appLog = logger
	}
	if runs, err := runstore.Open(baseDir, svc.appLog); err != nil {
		log.Printf("run records unavailable: %v", err)
	} else {
		svc.runs = runs
	}
	// 上次遗留的执行器运行若还在跑（Open 已按心跳与进程身份认领），登记进进程内簿记：
	// 调度卡知道它们在跑，界面上也能停它们。
	svc.adoptExecutorRuns()
	svc.bin = binary.NewService()
	svc.dev = device.NewService(svc.binPaths)
	svc.builtins = builtinvars.New(svc.dev)
	svc.runDeps = actionrun.Deps{BaseDir: baseDir, ADBPaths: svc.binPaths, ADBDevice: svc.dev, Builtins: svc.builtins, BashPath: svc.bashOverride}
	svc.aiDeps = airun.Deps{BaseDir: baseDir, Builtins: svc.builtins,
		SkillRouter: &airun.SkillRouter{
			// 惰性取当前 registry（热重载后 Skills 随之更新）
			Skills:     func() map[string]registry.SkillMeta { return svc.actionRegistry().Skills },
			HomeDir:    func() string { h, _ := os.UserHomeDir(); return h },
			LedgerPath: filepath.Join(baseDir, "skills.synced.json"),
		}}
	return svc
}

func (s *Service) actionRegistry() *registry.Registry {
	s.regMu.RLock()
	defer s.regMu.RUnlock()
	return s.reg
}

func (s *Service) workflowRegistry() *workflow.WorkflowRegistry {
	s.wfMu.RLock()
	defer s.wfMu.RUnlock()
	return s.wfReg
}

func (s *Service) aiRegistry() *ai.Registry {
	s.aiMu.RLock()
	defer s.aiMu.RUnlock()
	return s.aiReg
}

// SetApp 注入 Wails app 引用（用于 emit 事件）。
func (s *Service) SetApp(app *application.App) {
	s.app = app
	if app == nil || app.Event == nil {
		s.emitEvent = nil
		return
	}
	s.emitEvent = func(name string, data any) {
		app.Event.Emit(name, data)
	}
}

// notify 推一个应用级事件；没有前端（headless / 测试）时空操作。
func (s *Service) notify(name string, data any) {
	if s.emitEvent != nil {
		s.emitEvent(name, data)
	}
}

// ServiceStartup starts the in-process scheduler. Wails invokes this after the
// service has been registered, while tests/headless callers may invoke it directly.
func (s *Service) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	s.schedulerMu.Lock()
	defer s.schedulerMu.Unlock()
	if s.schedulerCancel != nil {
		return nil
	}
	runCtx, cancel := context.WithCancel(ctx)
	s.schedulerCancel = cancel
	ticker := time.NewTicker(30 * time.Second)
	go func() {
		defer ticker.Stop()
		s.scheduler.Run(runCtx, time.Now, ticker.C)
	}()
	// 持续核对在途的执行器运行（认领本身在 New 里，紧跟打开运行记录）。
	go s.watchExecutorRuns(runCtx)
	return nil
}

// ServiceShutdown stops the scheduler goroutine without affecting active runs.
func (s *Service) ServiceShutdown() error {
	s.schedulerMu.Lock()
	if s.schedulerCancel != nil {
		s.schedulerCancel()
		s.schedulerCancel = nil
	}
	s.schedulerMu.Unlock()
	return nil
}

// adbOverrides 返回 config.yaml 里的二进制路径覆盖（ADB_PATH/FASTBOOT_PATH/SCRCPY_PATH）。
func (s *Service) adbOverrides() map[string]string {
	s.gMu.Lock()
	defer s.gMu.Unlock()
	out := map[string]string{}
	for _, k := range []string{"ADB_PATH", "FASTBOOT_PATH", "SCRCPY_PATH"} {
		if v, ok := s.global[k]; ok {
			out[k] = v
		}
	}
	return out
}

// bashOverride 返回 config.yaml 的 BASH_PATH（bash/sh 探测级联第一优先）；未配置为空。
func (s *Service) bashOverride() string {
	s.gMu.Lock()
	defer s.gMu.Unlock()
	return s.global["BASH_PATH"]
}

// binPaths 解析当前三个二进制路径（config 覆盖 -> PATH -> 常见路径）。
// 是路径解析知识的唯一实现：actionrun.Deps.ADBPaths 与 device.Service 共用此函数。
func (s *Service) binPaths() binary.Paths {
	ov := s.adbOverrides()
	return s.bin.Paths(ov["ADB_PATH"], ov["FASTBOOT_PATH"], ov["SCRCPY_PATH"])
}
