// Package api 是暴露给前端的 Wails 服务层（唯一依赖 Wails 的包）。
// 按域拆文件：actions.go（动作 CRUD/列表）、run.go（直跑执行）、workflows.go
// （workflow CRUD/执行）、events.go（事件发射器与顺序协议）、devices.go（设备选择）、
// config.go（全局配置/片段）、dialog.go（原生对话框）、runregistry.go（运行簿记）。
package api

import (
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"

	"workflow-tool/internal/actionrun"
	"workflow-tool/internal/adb/binary"
	"workflow-tool/internal/adb/device"
	"workflow-tool/internal/builtinvars"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/workflow"
)

// Service 是暴露给前端的 Wails 服务。
type Service struct {
	app       *application.App
	reg       *registry.Registry
	baseDir   string
	cfgPath   string // config.yaml 路径
	fragPath  string // fragments.yaml 路径
	global    map[string]string
	gMu       sync.Mutex // 保护 global 的读写
	fragments []registry.Fragment
	fMu       sync.Mutex   // 保护 fragments 的读写
	running   *runRegistry // action 运行簿记（拒绝并发/结束清理/取消）
	wfReg     *workflow.WorkflowRegistry
	wfMu      sync.Mutex   // 保护 wfReg 的遍历读（GetVarReferenceCounts）
	wfRunning *runRegistry // workflow 运行簿记

	bin      *binary.Service       // adb/fastboot/scrcpy 路径探测
	dev      *device.Service       // 设备列表 + 激活 serial
	builtins *builtinvars.Registry // 内置变量注册表（CURRENT_DATE/CURRENT_TIME/ADB_SERIAL）
	runDeps  actionrun.Deps        // actionrun.Build 的共享依赖（两条执行路径共用）
}

// New 创建 service。cfgPath 是全局配置 config.yaml 路径，fragPath 是 fragments.yaml 路径。
// app 通过 SetApp 在 main 里注入（打破循环依赖）。
func New(reg *registry.Registry, wfReg *workflow.WorkflowRegistry, baseDir, cfgPath, fragPath string) *Service {
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
	svc := &Service{
		reg:       reg,
		baseDir:   baseDir,
		cfgPath:   cfgPath,
		fragPath:  fragPath,
		global:    g,
		fragments: frags,
		running:   newRunRegistry(),
		wfReg:     wfReg,
		wfRunning: newRunRegistry(),
	}
	svc.bin = binary.NewService()
	svc.dev = device.NewService(svc.binPaths)
	svc.builtins = builtinvars.New(svc.dev)
	svc.runDeps = actionrun.Deps{BaseDir: baseDir, ADBPaths: svc.binPaths, ADBDevice: svc.dev, Builtins: svc.builtins, BashPath: svc.bashOverride}
	return svc
}

// SetApp 注入 Wails app 引用（用于 emit 事件）。
func (s *Service) SetApp(app *application.App) { s.app = app }

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
