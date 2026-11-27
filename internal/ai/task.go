// Package ai 定义 AI 任务：与动作、工作流并列的第三种可执行物（ADR-0004）。
// 一任务一文件，位于 ai/<id>.yaml。本包只管 schema、严格解析、校验与加载，
// 不依赖 runner 与 api；把一份定义构造成运行器是 internal/airun 的职责。
//
// 设计规格：docs/superpowers/specs/2026-11-24-ai-system-and-schedules-design.md
package ai

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"workflow-tool/internal/registry"
)

// 保留运行参数：所有 AI 任务无需声明即接受（ADR-0004）。
const (
	ParamPrompt = "prompt" // 出现即替换定义里的 prompt 模板
	ParamSystem = "system" // 出现即替换定义里的 system 模板
	ParamResume = "resume" // 非空时以 --session 续接该会话，否则新开会话
)

// DefaultTimeout 是任务未写 timeout 时的运行上限。
const DefaultTimeout = 30 * time.Minute

// ReservedRunParams 返回保留运行参数名（固定顺序，供 CLI describe 与文档引用）。
func ReservedRunParams() []string {
	return []string{ParamPrompt, ParamSystem, ParamResume}
}

// IsReservedRunParam 判断 id 是否是保留运行参数。
func IsReservedRunParam(id string) bool {
	return id == ParamPrompt || id == ParamSystem || id == ParamResume
}

// reservedFields 是只在 schema 中约定、暂未实现的顶层字段。出现在 YAML 里即加载
// 失败并报「已预留、暂未实现」：提前占住名字，避免将来启用时与用户自造的字段撞车。
var reservedFields = []string{
	"model", "effort", "permission", "budget", "add_dir",
	"cli", "tools", "mcp", "session", "outputs",
}

// fieldOrder 是合法顶层键的声明顺序（严格解析的报错提示按它列出）。
var fieldOrder = []string{
	"id", "title", "icon", "description", "color", "params", "presets",
	"system", "prompt", "timeout", "cwd", "env", "skills",
}

// Task 是 AI 任务的 YAML 定义。
type Task struct {
	ID          string `yaml:"id"`
	Title       string `yaml:"title"`
	Icon        string `yaml:"icon"`
	Description string `yaml:"description"`
	// Color 可选，卡片氛围色名（registry.ValidAmbColors）；空 = 按分组序循环（ADR-0003）。
	Color   string               `yaml:"color"`
	Params  []registry.ParamSpec `yaml:"params"`
	Presets []registry.Preset    `yaml:"presets"`
	// System 可选，模板：只写角色与纪律。运行时与无人值守守则合成系统提示（ADR-0007）。
	System string `yaml:"system"`
	// Prompt 必须出现的键，模板。nil = 键缺失（校验报错）；非 nil 的空串合法，
	// 表示提示词由调用方给入。
	Prompt *string `yaml:"prompt"`
	// Timeout 可选，Go duration 字符串；空 = DefaultTimeout，非法直接报错（不回落）。
	Timeout string            `yaml:"timeout"`
	Cwd     string            `yaml:"cwd"`    // 可选，模板；空则为应用目录
	Env     map[string]string `yaml:"env"`    // 可选，值为模板
	Skills  []string          `yaml:"skills"` // 可选，skill id，须存在于 skills/
}

// LoadedTask 是已校验、字段已解析的 AI 任务。
type LoadedTask struct {
	Task    Task
	Timeout time.Duration // 解析后的运行上限
	File    string        // 源文件绝对路径（编辑器读写锚点）
}

// PromptText 返回 prompt 模板原文（键缺失时为空串，仅校验前的中间态会出现）。
func (t *Task) PromptText() string {
	if t.Prompt == nil {
		return ""
	}
	return *t.Prompt
}

// TimeoutDuration 解析 timeout；空为 DefaultTimeout。
func (t *Task) TimeoutDuration() (time.Duration, error) {
	s := strings.TrimSpace(t.Timeout)
	if s == "" {
		return DefaultTimeout, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("timeout 非法 %q（应为 Go duration，如 30s/5m/1h）", t.Timeout)
	}
	if d <= 0 {
		return 0, fmt.Errorf("timeout 必须大于 0，got %q", t.Timeout)
	}
	return d, nil
}

// Parse 严格解析并校验一份 AI 任务定义：未知顶层键与预留字段都是错误，
// 嵌套层（params/presets 的条目）同样拒绝未知键。
// skills 非 nil 时一并校验 skills 引用（nil = 不校验，仅测试与无 skills 来源的场景）。
func Parse(data []byte, skills map[string]registry.SkillMeta) (*Task, error) {
	promptSeen, err := checkTopLevelKeys(data)
	if err != nil {
		return nil, err
	}
	var t Task
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&t); err != nil {
		return nil, fmt.Errorf("YAML 解析失败: %w", err)
	}
	if promptSeen && t.Prompt == nil {
		// `prompt:`（null）与 `prompt: ""` 同义：提示词由调用方给入。
		empty := ""
		t.Prompt = &empty
	}
	if err := Validate(&t); err != nil {
		return nil, err
	}
	if skills != nil {
		if err := registry.ValidateSkillRefs(t.Skills, skills); err != nil {
			return nil, fmt.Errorf("skills: %w", err)
		}
	}
	return &t, nil
}

// checkTopLevelKeys 检查 YAML 根节点的顶层键：根必须是 mapping，每个键要么是合法字段，
// 要么报「未知字段」（列出全部合法键）或「已预留、暂未实现」。返回 prompt 键是否出现。
// 先走 Node 再解码，是为了给出带合法键清单的提示，并区分「键缺失」与「键存在但值为 null」。
func checkTopLevelKeys(data []byte) (promptSeen bool, err error) {
	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return false, fmt.Errorf("YAML 解析失败: %w", err)
	}
	if root.Kind == yaml.DocumentNode && len(root.Content) > 0 {
		root = *root.Content[0]
	}
	if root.Kind == 0 {
		return false, fmt.Errorf("YAML 内容为空")
	}
	if root.Kind != yaml.MappingNode {
		return false, fmt.Errorf("YAML 根节点应为 mapping")
	}
	for i := 0; i+1 < len(root.Content); i += 2 {
		key := root.Content[i].Value
		if key == ParamPrompt {
			promptSeen = true
		}
		if slices.Contains(fieldOrder, key) {
			continue
		}
		if slices.Contains(reservedFields, key) {
			return false, fmt.Errorf("字段 %q 已预留、暂未实现，请从任务定义中删除", key)
		}
		return false, fmt.Errorf("未知字段 %q（合法字段：%s）", key, strings.Join(fieldOrder, "/"))
	}
	return promptSeen, nil
}

// Validate 校验任务定义合法（不含 skills 引用，那需要 skills 扫描结果，见 Parse）。
func Validate(t *Task) error {
	if !registry.ValidID(t.ID) {
		return fmt.Errorf("id 必须匹配 ^[a-z0-9-]+$，got %q", t.ID)
	}
	if t.Title == "" {
		return fmt.Errorf("title 必填")
	}
	if t.Color != "" && !registry.ValidAmbColors[t.Color] {
		return fmt.Errorf("color 非法 %q（应为 amber/green/blue/violet，不写则按分组序循环）", t.Color)
	}
	if t.Prompt == nil {
		return fmt.Errorf("缺少必填字段 prompt（提示词由调用方给入时写 prompt: \"\"）")
	}
	if _, err := t.TimeoutDuration(); err != nil {
		return err
	}
	seen := map[string]bool{}
	for i, p := range t.Params {
		if p.ID == "" {
			return fmt.Errorf("params[%d]: id 必填", i)
		}
		if IsReservedRunParam(p.ID) {
			return fmt.Errorf("params[%d]: id %q 是保留运行参数，不能在 params 里声明", i, p.ID)
		}
		if seen[p.ID] {
			return fmt.Errorf("params[%d]: id %q 重复", i, p.ID)
		}
		seen[p.ID] = true
	}
	if err := registry.ValidateParamSpecs(t.Params); err != nil {
		return err
	}
	for _, preset := range t.Presets {
		// 预设值的键必须是已声明的 param 或保留运行参数，否则报错（防拼写错误静默落空）。
		for key := range preset.Values {
			if !seen[key] && !IsReservedRunParam(key) {
				return fmt.Errorf("preset %q 引用了未声明的参数 %q（应为 params 里的 id 或 prompt/system/resume）", preset.Name, key)
			}
		}
		if err := registry.ValidatePresetArrayValues(t.Params, preset.Values, preset.Name); err != nil {
			return err
		}
	}
	return nil
}

// Registry 是所有已加载 AI 任务的集合。
type Registry struct {
	Tasks  map[string]LoadedTask
	Order  []string // id 升序，列表输出稳定
	Errors []registry.FileError
}

// Get 按 id 取任务；nil registry 视为空集合。
func (r *Registry) Get(id string) (LoadedTask, bool) {
	if r == nil {
		return LoadedTask{}, false
	}
	t, ok := r.Tasks[id]
	return t, ok
}

// Load 扫描 dir 下所有 *.yaml。skills 是动作加载时扫出的可用 skill 集，用于校验
// skills 引用；nil 表示不校验。目录不存在返回空集合，不算错误（尚未创建 ai/ 时）。
// 单个文件的错误逐个收集进 Errors，不中断其余文件。
func Load(dir string, skills map[string]registry.SkillMeta) *Registry {
	reg := &Registry{Tasks: map[string]LoadedTask{}}
	files, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil {
		reg.Errors = append(reg.Errors, registry.FileError{File: dir, Error: err.Error()})
		return reg
	}
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			reg.Errors = append(reg.Errors, registry.FileError{File: filepath.Base(f), Error: err.Error()})
			continue
		}
		t, err := Parse(data, skills)
		if err != nil {
			reg.Errors = append(reg.Errors, registry.FileError{File: filepath.Base(f), Error: err.Error()})
			continue
		}
		if _, exists := reg.Tasks[t.ID]; exists {
			reg.Errors = append(reg.Errors, registry.FileError{File: filepath.Base(f), Error: fmt.Sprintf("重复 id %q", t.ID)})
			continue
		}
		timeout, _ := t.TimeoutDuration() // Validate 已保证可解析
		reg.Tasks[t.ID] = LoadedTask{Task: *t, Timeout: timeout, File: f}
	}
	for id := range reg.Tasks {
		reg.Order = append(reg.Order, id)
	}
	sort.Strings(reg.Order)
	return reg
}
