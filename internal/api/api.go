package api

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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
	cfgPath  string // config.yaml 路径
	fragPath string // fragments.yaml 路径
	global   map[string]string
	gMu      sync.Mutex // 保护 global 的读写
	fragments []registry.Fragment
	fMu       sync.Mutex // 保护 fragments 的读写
	mu        sync.Mutex
	running   map[string]context.CancelFunc // actionID -> cancel
}

// New 创建 service。cfgPath 是全局配置 config.yaml 路径，fragPath 是 fragments.yaml 路径。
// app 通过 SetApp 在 main 里注入（打破循环依赖）。
func New(reg *registry.Registry, baseDir, cfgPath, fragPath string) *Service {
	g, _ := registry.LoadGlobal(cfgPath)
	if g == nil {
		g = map[string]string{}
	}
	frags, _ := registry.LoadFragments(fragPath)
	if frags == nil {
		frags = []registry.Fragment{}
	}
	return &Service{
		reg:       reg,
		baseDir:   baseDir,
		cfgPath:   cfgPath,
		fragPath:  fragPath,
		global:    g,
		fragments: frags,
		running:   map[string]context.CancelFunc{},
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
	Stream      string               `json:"stream"`
}

// ListResult 包装 ListActions 的多返回值，便于前端绑定。
type ListResult struct {
	Actions []ActionItem `json:"actions"`
	Errors  []string     `json:"errors"`
}

// ListActions 返回全部已加载动作 + 加载错误。
func (s *Service) ListActions() ListResult {
	return s.buildListResult()
}

// buildListResult 从当前 registry 构造前端可见列表（ListActions 与 SetActionYaml 末尾共用）。
func (s *Service) buildListResult() ListResult {
	items := make([]ActionItem, 0, len(s.reg.Actions))
	for _, la := range s.reg.Actions {
		items = append(items, ActionItem{
			ID:          la.Def.ID,
			Title:       la.Def.Title,
			Icon:        la.Def.Icon,
			Description: la.Def.Description,
			Params:      la.Def.Params,
			Presets:     la.Def.Presets,
			Stream:      la.Def.Command.Stream,
		})
	}
	errs := make([]string, 0, len(s.reg.Errors))
	for _, e := range s.reg.Errors {
		errs = append(errs, fmt.Sprintf("%s: %s", e.File, e.Error))
	}
	return ListResult{Actions: items, Errors: errs}
}

// Reload 重扫 actions 目录重建 registry（编辑保存后调用）。
// 低频操作：整体替换 reg 指针；正在运行的 action 持有旧 LoadedAction 副本，不受影响。
func (s *Service) Reload() {
	s.reg = registry.Load(filepath.Join(s.baseDir, "actions"), s.baseDir)
}

// GetActionYaml 返回指定 action 源文件原文（含注释与格式）。
func (s *Service) GetActionYaml(id string) (string, error) {
	la, ok := s.reg.Actions[id]
	if !ok {
		return "", fmt.Errorf("未知动作 %q", id)
	}
	data, err := os.ReadFile(la.File)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// SetActionYaml 校验并写回 action 源文件，随后重载 registry，返回最新列表。
// 禁止改 id（id 为文件锚点）；解析/校验失败时不写盘。
func (s *Service) SetActionYaml(id string, text string) (ListResult, error) {
	la, ok := s.reg.Actions[id]
	if !ok {
		return ListResult{}, fmt.Errorf("未知动作 %q", id)
	}
	def, err := registry.ParseAction([]byte(text))
	if err != nil {
		return ListResult{}, fmt.Errorf("YAML 解析失败: %w", err)
	}
	if def.ID != id {
		return ListResult{}, fmt.Errorf("id 不可修改（原 %q，现 %q）", id, def.ID)
	}
	if err := registry.Validate(def); err != nil {
		return ListResult{}, err
	}
	if err := os.WriteFile(la.File, []byte(text), 0644); err != nil {
		return ListResult{}, err
	}
	s.Reload()
	return s.buildListResult(), nil
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

// AddPreset 给指定动作新增/覆盖一个 preset（同名覆盖），写回 yaml 并重载，返回最新列表。
func (s *Service) AddPreset(actionID, name, description string, values map[string]string) (ListResult, error) {
	la, ok := s.reg.Actions[actionID]
	if !ok {
		return ListResult{}, fmt.Errorf("未知动作 %q", actionID)
	}
	raw, err := os.ReadFile(la.File)
	if err != nil {
		return ListResult{}, err
	}
	updated, err := registry.AddPresetToYAML(raw, name, description, values)
	if err != nil {
		return ListResult{}, err
	}
	if err := os.WriteFile(la.File, updated, 0644); err != nil {
		return ListResult{}, err
	}
	s.Reload()
	return s.buildListResult(), nil
}

// OpenActionsDir 用系统文件管理器打开 actions 目录（Windows: explorer / macOS: open / 其他: xdg-open）。
func (s *Service) OpenActionsDir() error {
	dir := filepath.Join(s.baseDir, "actions")
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", dir)
	case "darwin":
		cmd = exec.Command("open", dir)
	default:
		cmd = exec.Command("xdg-open", dir)
	}
	return cmd.Start()
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

// GetFragments 返回当前指令片段列表（副本）。
func (s *Service) GetFragments() []registry.Fragment {
	s.fMu.Lock()
	defer s.fMu.Unlock()
	out := make([]registry.Fragment, len(s.fragments))
	copy(out, s.fragments)
	return out
}

// SetFragments 替换指令片段并写回 fragments.yaml。
func (s *Service) SetFragments(list []registry.Fragment) error {
	s.fMu.Lock()
	defer s.fMu.Unlock()
	if err := registry.SaveFragments(s.fragPath, list); err != nil {
		return err
	}
	s.fragments = list
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
		Stream:  la.Def.Command.Stream,
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
