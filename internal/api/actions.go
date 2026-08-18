package api

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"

	"workflow-tool/internal/registry"
)

// ActionItem 是前端可见的动作描述。
type ActionItem struct {
	ID          string               `json:"id"`
	Title       string               `json:"title"`
	Icon        string               `json:"icon"`
	Description string               `json:"description"`
	Params      []registry.ParamSpec `json:"params"`
	Presets     []registry.Preset    `json:"presets"`
	Stream      string               `json:"stream"`
	// LLM 非 nil 表示该动作是 command.llm 形态：前端据此走 LlmForm（system/prompt 主次布局）
	// + LlmView（流式回答视图）；nil 走通用 ParamForm。
	LLM *LLMInfo `json:"llm,omitempty"`
}

// LLMInfo 暴露给前端的 LLM 形态元信息：哪个 param 是 system、哪个是 prompt、哪个是 resume。
// ResumeParam 供聊天页查看历史时把条目的 session id 回填到该输入（续接会话）。
type LLMInfo struct {
	SystemParam string `json:"systemParam"`
	PromptParam string `json:"promptParam"`
	ResumeParam string `json:"resumeParam"`
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
			LLM:         llmInfoOf(la.Def.Command),
		})
	}
	errs := make([]string, 0, len(s.reg.Errors))
	for _, e := range s.reg.Errors {
		errs = append(errs, fmt.Sprintf("%s: %s", e.File, e.Error))
	}
	return ListResult{Actions: items, Errors: errs}
}

// llmInfoOf 若动作是 LLM 形态则返回 LLMInfo 供前端布局，否则 nil。
func llmInfoOf(cmd registry.Command) *LLMInfo {
	if cmd.LLM.Prompt == "" {
		return nil
	}
	return &LLMInfo{SystemParam: cmd.LLM.System, PromptParam: cmd.LLM.Prompt, ResumeParam: cmd.LLM.Resume}
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

// AddPreset 给指定动作新增/覆盖一个 preset（同名覆盖），写回 yaml 并重载，返回最新列表。
// 经 registry.AddPresetToYAML 在 yaml 节点树上操作，保留其余部分的注释与格式。
func (s *Service) AddPreset(actionID, name, description string, values map[string]string) (ListResult, error) {
	la, ok := s.reg.Actions[actionID]
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
// 所有 action 的 shell 命令 + script 脚本文件内容 + 指令片段。
// 同一处（一个 action 或一个片段）内重复引用只计一次，体现「是否被用到」。
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
	// actions：inline shell + cwd + env values + script 脚本文件内容
	for _, la := range s.reg.Actions {
		add(la.Def.Command.Shell)
		add(la.Def.Command.Cwd)
		for _, v := range la.Def.Command.Env {
			add(v)
		}
		if la.Def.Command.Script != "" {
			if data, ok := readScriptBytes(la.Def.Command.Script, s.baseDir); ok {
				add(string(data))
			}
		}
	}
	// workflows：workflow 级 env + 每个 step 的 shell / params / env 值
	// （运行时这些字段都会被 runner.Expand 展开 ${VAR}，故都需统计引用）
	s.wfMu.Lock()
	for _, lw := range s.wfReg.Workflows {
		for _, v := range lw.Def.Env {
			add(v)
		}
		for _, step := range lw.Def.Steps {
			add(step.Shell)
			for _, v := range step.Params {
				add(v)
			}
			for _, v := range step.Env {
				add(v)
			}
		}
	}
	s.wfMu.Unlock()
	// fragments
	s.fMu.Lock()
	for _, f := range s.fragments {
		add(f.Content)
	}
	s.fMu.Unlock()
	return counts
}

// readScriptBytes 读取 script 脚本内容（.sh 与 .ps1 都读并合并），相对路径基于 baseDir。
// 两份都读是为了与运行平台解耦——统计的是「变量名是否被引用」，与实际执行哪个脚本无关。
// 两个后缀都读不到（路径含变量、文件缺失）则返回 false。
func readScriptBytes(script, baseDir string) ([]byte, bool) {
	p := script
	if !filepath.IsAbs(p) {
		p = filepath.Join(baseDir, p)
	}
	var data []byte
	found := false
	for _, ext := range []string{".sh", ".ps1"} {
		if d, err := os.ReadFile(p + ext); err == nil {
			data = append(data, d...)
			found = true
		}
	}
	return data, found
}
