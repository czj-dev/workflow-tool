package api

import (
	"context"
	"fmt"
	"os"
	"strings"
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
	mu      sync.Mutex
	running map[string]context.CancelFunc // actionID -> cancel
}

// New 创建 service。app 通过 SetApp 在 main 里注入（打破循环依赖）。
func New(reg *registry.Registry, baseDir string) *Service {
	return &Service{reg: reg, baseDir: baseDir, running: map[string]context.CancelFunc{}}
}

// SetApp 注入 Wails app 引用（用于 emit 事件）。
func (s *Service) SetApp(app *application.App) { s.app = app }

// ActionItem 是前端可见的动作描述。
type ActionItem struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Icon        string `json:"icon"`
	Description string `json:"description"`
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
			ID: la.Def.ID, Title: la.Def.Title, Icon: la.Def.Icon, Description: la.Def.Description,
		})
	}
	errs := make([]string, 0, len(s.reg.Errors))
	for _, e := range s.reg.Errors {
		errs = append(errs, fmt.Sprintf("%s: %s", e.File, e.Error))
	}
	return ListResult{Actions: items, Errors: errs}
}

// RunAction 按 id 启动动作，立即返回；输出通过事件流推送。
func (s *Service) RunAction(id string) error {
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

	go s.execute(ctx, id, la)
	return nil
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

func (s *Service) execute(ctx context.Context, id string, la registry.LoadedAction) {
	defer func() {
		s.mu.Lock()
		delete(s.running, id)
		s.mu.Unlock()
	}()

	if la.Cwd != "" {
		if _, err := os.Stat(la.Cwd); err != nil {
			msg := fmt.Sprintf("工作目录不存在: %s", la.Cwd)
			if strings.Contains(la.Cwd, "${") {
				msg = fmt.Sprintf("工作目录的环境变量未设置（仍为 %s）——该动作需要参数输入，属 Phase 3 场景", la.Cwd)
			}
			s.emitDone(id, -1, msg, 0)
			return
		}
	}

	emit := func(stream, line string) {
		s.app.Event.Emit(eventName(id, "output"), map[string]string{
			"stream": stream, "line": line,
		})
	}

	r := &runner.ShellRunner{Cfg: runner.ShellConfig{
		Shell:   la.Def.Command.Shell,
		Script:  la.Def.Command.Script,
		Cwd:     la.Cwd,
		Timeout: la.Timeout,
		Env:     la.Def.Command.Env,
		BaseDir: s.baseDir,
	}}

	res := r.Run(ctx, nil, emit)
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
