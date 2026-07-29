package api

import (
	"context"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
)

// Service 是暴露给前端的 Wails 服务。
type Service struct {
	app     *application.App
	reg     *registry.Registry
	baseDir string
	cfgPath string // config.yaml 路径
	global  map[string]string
	gMu     sync.Mutex // 保护 global 的读写
	mu      sync.Mutex
	running map[string]context.CancelFunc // actionID -> cancel
}

// New 创建 service。cfgPath 是全局配置 config.yaml 路径。
// app 通过 SetApp 在 main 里注入（打破循环依赖）。
func New(reg *registry.Registry, baseDir, cfgPath string) *Service {
	g, _ := registry.LoadGlobal(cfgPath)
	if g == nil {
		g = map[string]string{}
	}
	return &Service{
		reg:     reg,
		baseDir: baseDir,
		cfgPath: cfgPath,
		global:  g,
		running: map[string]context.CancelFunc{},
	}
}

// SetApp 注入 Wails app 引用（用于 emit 事件）。
func (s *Service) SetApp(app *application.App) { s.app = app }

// ActionItem 是前端可见的动作描述。
type ActionItem struct {
	ID          string               `json:"id"`
	Title       string               `json:"title"`
	Icon        string               `json:"icon"`
	Description string               `json:"description"`
	Params      []registry.ParamSpec `json:"params"`
	Presets     []registry.Preset    `json:"presets"`
}

// ListResult 包装 ListActions 的多返回值，便于前端绑定。
type ListResult struct {
	Actions []ActionItem `json:"actions"`
	Errors  []string     `json:"errors"`
}

// ListActions 返回全部已加载动作 + 加载错误。
func (s *Service) ListActions() ListResult {
	items := make([]ActionItem, 0, len(s.reg.Actions))
	for _, la := range s.reg.Actions {
		items = append(items, ActionItem{
			ID:          la.Def.ID,
			Title:       la.Def.Title,
			Icon:        la.Def.Icon,
			Description: la.Def.Description,
			Params:      la.Def.Params,
			Presets:     la.Def.Presets,
		})
	}
	errs := make([]string, 0, len(s.reg.Errors))
	for _, e := range s.reg.Errors {
		errs = append(errs, fmt.Sprintf("%s: %s", e.File, e.Error))
	}
	return ListResult{Actions: items, Errors: errs}
}

// RunAction 按 id 启动动作，params 为运行时参数；输出通过事件流推送。
func (s *Service) RunAction(id string, params map[string]any) error {
	la, ok := s.reg.Actions[id]
	if !ok {
		return fmt.Errorf("未知动作 %q", id)
	}
	s.mu.Lock()
	if _, running := s.running[id]; running {
		s.mu.Unlock()
		return fmt.Errorf("动作 %q 正在运行", id)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.running[id] = cancel
	s.mu.Unlock()

	merged := s.mergeGlobalAndParams(params)
	go s.execute(ctx, id, la, merged)
	return nil
}

// mergeGlobalAndParams 合并全局配置与参数（参数覆盖同名全局），返回 runner 用的 vars。
func (s *Service) mergeGlobalAndParams(params map[string]any) map[string]any {
	s.gMu.Lock()
	defer s.gMu.Unlock()
	out := make(map[string]any, len(s.global)+len(params))
	for k, v := range s.global {
		out[k] = v
	}
	for k, v := range params {
		out[k] = v // 参数优先
	}
	return out
}

// CancelAction 取消正在运行的动作。
func (s *Service) CancelAction(id string) {
	s.mu.Lock()
	cancel, ok := s.running[id]
	s.mu.Unlock()
	if ok {
		cancel()
	}
}

// GetGlobalConfig 返回当前全局配置（返回副本，避免前端误改内部 map）。
func (s *Service) GetGlobalConfig() map[string]string {
	s.gMu.Lock()
	defer s.gMu.Unlock()
	out := make(map[string]string, len(s.global))
	for k, v := range s.global {
		out[k] = v
	}
	return out
}

// SetGlobalConfig 替换全局配置并写回 config.yaml。
func (s *Service) SetGlobalConfig(kv map[string]string) error {
	s.gMu.Lock()
	defer s.gMu.Unlock()
	if err := registry.SaveGlobal(s.cfgPath, kv); err != nil {
		return err
	}
	s.global = kv
	return nil
}

func (s *Service) execute(ctx context.Context, id string, la registry.LoadedAction, params map[string]any) {
	defer func() {
		s.mu.Lock()
		delete(s.running, id)
		s.mu.Unlock()
	}()

	emit := func(stream, line string) {
		s.app.Event.Emit(eventName(id, "output"), map[string]string{
			"stream": stream, "line": line,
		})
	}

	// 运行时替换 cwd（用 merged params），替换后检查存在性
	cwd := runner.Expand(la.Cwd, params)
	if cwd != "" {
		if _, err := os.Stat(cwd); err != nil {
			s.emitDone(id, -1, fmt.Sprintf("工作目录不存在: %s", cwd), 0)
			return
		}
	}

	r := &runner.ShellRunner{Cfg: runner.ShellConfig{
		Shell:   la.Def.Command.Shell,
		Script:  la.Def.Command.Script,
		Cwd:     la.Cwd, // raw，由 runner 用 params 替换
		Timeout: la.Timeout,
		Env:     la.Def.Command.Env,
		BaseDir: s.baseDir,
	}}

	res := r.Run(ctx, params, emit)
	s.emitDone(id, res.ExitCode, errStr(res.Err), res.Duration)
}

func (s *Service) emitDone(id string, exitCode int, errMsg string, d time.Duration) {
	s.app.Event.Emit(eventName(id, "done"), map[string]any{
		"exitCode": exitCode,
		"err":      errMsg,
		"duration": d.String(),
	})
}

func eventName(id, suffix string) string {
	return fmt.Sprintf("action:%s:%s", id, suffix)
}

func errStr(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
