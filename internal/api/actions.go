package api

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"

	"workflow-tool/internal/ai"
	"workflow-tool/internal/registry"
)

// ActionItem 是前端可见的动作描述。
type ActionItem struct {
	ID          string               `json:"id"`
	Title       string               `json:"title"`
	Icon        string               `json:"icon"`
	Description string               `json:"description"`
	Color       string               `json:"color"`
	Params      []registry.ParamSpec `json:"params"`
	Presets     []registry.Preset    `json:"presets"`
	Stream      string               `json:"stream"`
	HMI         *registry.HMI        `json:"hmi,omitempty"`
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
	reg := s.actionRegistry()
	items := make([]ActionItem, 0, len(reg.Actions))
	for _, la := range reg.Actions {
		items = append(items, ActionItem{
			ID:          la.Def.ID,
			Title:       la.Def.Title,
			Icon:        la.Def.Icon,
			Description: la.Def.Description,
			Color:       la.Def.Color,
			Params:      la.Def.Params,
			Presets:     la.Def.Presets,
			Stream:      la.Def.Command.Stream,
			HMI:         la.Def.HMI,
		})
	}
	errs := make([]string, 0, len(reg.Errors))
	for _, e := range reg.Errors {
		errs = append(errs, fmt.Sprintf("%s: %s", e.File, e.Error))
	}
	return ListResult{Actions: items, Errors: errs}
}

// Reload 重扫 actions 与 ai 目录重建 registry（编辑保存后调用）。
// 低频操作：整体替换 reg 指针；正在运行的 action 持有旧 LoadedAction 副本，不受影响。
func (s *Service) Reload() {
	loaded := registry.Load(filepath.Join(s.baseDir, "actions"), s.baseDir)
	s.regMu.Lock()
	s.reg = loaded
	s.regMu.Unlock()
	s.reloadAi()
	s.reconcileSchedules()
}

// reloadAi 重扫 ai/ 目录重建 aiReg。skills 取自刚换上的动作 registry；正在运行的
// AI 任务持有旧 LoadedTask 副本，不受影响。
func (s *Service) reloadAi() {
	loaded := ai.Load(filepath.Join(s.baseDir, "ai"), s.actionRegistry().Skills)
	s.aiMu.Lock()
	s.aiReg = loaded
	s.aiMu.Unlock()
}

// GetActionYaml 返回指定 action 源文件原文（含注释与格式）。
func (s *Service) GetActionYaml(id string) (string, error) {
	la, ok := s.actionRegistry().Actions[id]
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
	la, ok := s.actionRegistry().Actions[id]
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

// AddPreset 给指定动作新增/覆盖一个 preset（同名覆盖），写回 yaml 并重载，返回最新列表。
// 经 registry.AddPresetToYAML 在 yaml 节点树上操作，保留其余部分的注释与格式。
func (s *Service) AddPreset(actionID, name, description string, values map[string]string) (ListResult, error) {
	la, ok := s.actionRegistry().Actions[actionID]
	if !ok {
		return ListResult{}, fmt.Errorf("未知动作 %q", actionID)
	}
	raw, err := os.ReadFile(la.File)
	if err != nil {
		return ListResult{}, err
	}
	out, err := registry.AddPresetToYAML(raw, name, description, values)
	if err != nil {
		return ListResult{}, err
	}
	def, err := registry.ParseAction(out)
	if err != nil {
		return ListResult{}, fmt.Errorf("YAML 解析失败: %w", err)
	}
	if def.ID != actionID {
		return ListResult{}, fmt.Errorf("id 不可修改（原 %q，现 %q）", actionID, def.ID)
	}
	if err := registry.Validate(def); err != nil {
		return ListResult{}, err
	}
	if err := os.WriteFile(la.File, out, 0644); err != nil {
		return ListResult{}, err
	}
	s.Reload()
	return s.buildListResult(), nil
}

// OpenActionsDir 用系统文件管理器打开 actions 目录
// （Windows: explorer / macOS: open / 其他: xdg-open）。
func (s *Service) OpenActionsDir() error {
	actionsDir := filepath.Join(s.baseDir, "actions")
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", actionsDir)
	case "windows":
		cmd = exec.Command("explorer", actionsDir)
	default:
		cmd = exec.Command("xdg-open", actionsDir)
	}
	return cmd.Run()
}

// varRefRe 匹配变量引用：${VAR}（runner.Expand / sh）或 $env:VAR（PowerShell）。
var varRefRe = regexp.MustCompile(`\$\{([A-Za-z0-9_]+)\}|\$env:([A-Za-z0-9_]+)`)

// GetVarReferenceCounts 统计每个变量被多少处引用：
// 所有 action 的 shell 命令 + cwd + env 值 + script 脚本文件内容 + params 默认值 +
// preset 值 + AI 任务的 prompt/system/cwd/env/params 默认值 + workflow 的
// env/params 默认值/step 字段 + 指令片段。
// 同一字段内重复引用只计一次，体现「是否被用到」。
// params 默认值与 action preset 值都是模板：动作经 withActionDefaults /
// expandDirectParams、AI 任务经 resolveInputs 的 fromDefault 展开分支、workflow
// 参数经表单预填进 merged 后 ExpandParams——漏扫会让仅被默认值引用的变量
// （如 log-spm-download 的 ${LOGS_DIR}）在全局配置页显示未使用。
func (s *Service) GetVarReferenceCounts() map[string]int {
	counts := map[string]int{}
	add := func(text string) {
		seen := map[string]bool{}
		for _, m := range varRefRe.FindAllStringSubmatch(text, -1) {
			name := m[1]
			if name == "" {
				name = m[2] // $env:VAR 分支
			}
			if !seen[name] {
				seen[name] = true
				counts[name]++
			}
		}
	}
	// actions：inline run + cwd + env values + script 脚本文件内容 + params 默认值 +
	// presets 值（preset 提交后与其他参数一起经 expandDirectParams 展开）
	for _, la := range s.actionRegistry().Actions {
		add(la.Def.Command.Run)
		add(la.Def.Command.Cwd)
		for _, v := range la.Def.Command.Env {
			add(v)
		}
		for _, spec := range la.Def.Params {
			add(spec.Default)
		}
		for _, p := range la.Def.Presets {
			for _, v := range p.Values {
				add(v)
			}
		}
		if la.Def.Command.Script != "" {
			if data, ok := readScriptBytes(la.Def.Command.Script, s.baseDir); ok {
				add(string(data))
			}
		}
	}
	// ai tasks：prompt / system / cwd / env 值 / params 默认值都是模板，运行时经
	// runner.Expand 展开（默认值见 airun 的 fromDefault 展开分支）。AI preset 不扫：
	// 已声明参数的 preset 值是字面输入不做模板展开，仅 prompt/system 覆盖值是模板。
	for _, lt := range s.aiRegistry().Tasks {
		add(lt.Task.PromptText())
		add(lt.Task.System)
		add(lt.Task.Cwd)
		for _, v := range lt.Task.Env {
			add(v)
		}
		for _, spec := range lt.Task.Params {
			add(spec.Default)
		}
	}
	// workflows：workflow 级 env + 声明参数默认值 + 每个 step 的 shell / params / env 值
	// （运行时这些字段都会被 runner.Expand 展开 ${VAR}，故都需统计引用）
	for _, lw := range s.workflowRegistry().Workflows {
		for _, v := range lw.Def.Env {
			add(v)
		}
		for _, spec := range lw.Def.Params {
			add(spec.Default)
		}
		for _, step := range lw.Def.Steps {
			add(step.Run)
			for _, v := range step.Params {
				add(v)
			}
			for _, v := range step.Env {
				add(v)
			}
		}
	}
	// fragments
	s.fMu.Lock()
	for _, f := range s.fragments {
		add(f.Content)
	}
	s.fMu.Unlock()
	return counts
}

// readScriptBytes 读取 script 脚本内容（路径自带扩展名），相对路径基于 baseDir。
// 读不到（路径含变量、文件缺失）返回 false——统计场景容忍缺文件。
func readScriptBytes(script, baseDir string) ([]byte, bool) {
	p := script
	if !filepath.IsAbs(p) {
		p = filepath.Join(baseDir, p)
	}
	d, err := os.ReadFile(p)
	return d, err == nil
}
