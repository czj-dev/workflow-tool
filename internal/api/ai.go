// ai.go：AI 任务的列表、YAML 编辑与预设（对标 actions.go 之于动作）。执行在 run.go：
// 手动运行与 workflow 的 ai step 共用同一把目标锁（Service.aiRunning）与同一条构造
// 路径（airun.Build）。
package api

import (
	"fmt"
	"os"

	"workflow-tool/internal/ai"
	"workflow-tool/internal/registry"
)

// AiTaskItem 是前端可见的 AI 任务描述。
type AiTaskItem struct {
	ID          string               `json:"id"`
	Title       string               `json:"title"`
	Icon        string               `json:"icon"`
	Description string               `json:"description"`
	Color       string               `json:"color"`
	Params      []registry.ParamSpec `json:"params"`
	Presets     []registry.Preset    `json:"presets"`
	// Prompt 与 System 是定义里的模板原文，对话页草稿的初值；prompt 为空串表示
	// 提示词必须由调用方给入（运行前须填，或改走对话页）。
	Prompt string `json:"prompt"`
	System string `json:"system"`
	// Timeout 是生效的运行上限（任务未写时为缺省值），如 "30m0s"。
	Timeout string `json:"timeout"`
}

// AiListResult 是 ListAiTasks 的返回值。
type AiListResult struct {
	Tasks  []AiTaskItem `json:"tasks"`
	Errors []string     `json:"errors"`
}

// ListAiTasks 返回全部已加载 AI 任务（id 升序）+ 加载错误。
func (s *Service) ListAiTasks() AiListResult {
	reg := s.aiRegistry()
	items := make([]AiTaskItem, 0, len(reg.Tasks))
	for _, id := range reg.Order {
		lt := reg.Tasks[id]
		items = append(items, AiTaskItem{
			ID:          lt.Task.ID,
			Title:       lt.Task.Title,
			Icon:        lt.Task.Icon,
			Description: lt.Task.Description,
			Color:       lt.Task.Color,
			Params:      lt.Task.Params,
			Presets:     lt.Task.Presets,
			Prompt:      lt.Task.PromptText(),
			System:      lt.Task.System,
			Timeout:     lt.Timeout.String(),
		})
	}
	errs := make([]string, 0, len(reg.Errors))
	for _, e := range reg.Errors {
		errs = append(errs, fmt.Sprintf("%s: %s", e.File, e.Error))
	}
	return AiListResult{Tasks: items, Errors: errs}
}

// GetAiYaml 返回指定 AI 任务源文件原文（含注释与格式）。
func (s *Service) GetAiYaml(id string) (string, error) {
	lt, ok := s.aiRegistry().Get(id)
	if !ok {
		return "", fmt.Errorf("未知 AI 任务 %q", id)
	}
	data, err := os.ReadFile(lt.File)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// SetAiYaml 校验并写回任务源文件，随后重载，返回最新列表。
// 禁止改 id（id 为文件锚点）；解析/校验失败时不写盘。
func (s *Service) SetAiYaml(id string, text string) (AiListResult, error) {
	lt, ok := s.aiRegistry().Get(id)
	if !ok {
		return AiListResult{}, fmt.Errorf("未知 AI 任务 %q", id)
	}
	task, err := ai.Parse([]byte(text), s.actionRegistry().Skills)
	if err != nil {
		return AiListResult{}, err
	}
	if task.ID != id {
		return AiListResult{}, fmt.Errorf("id 不可修改（原 %q，现 %q）", id, task.ID)
	}
	if err := os.WriteFile(lt.File, []byte(text), 0o644); err != nil {
		return AiListResult{}, err
	}
	s.Reload()
	return s.ListAiTasks(), nil
}

// AddAiPreset 给指定 AI 任务新增/覆盖一个预设（同名覆盖），写回 yaml 并重载，返回最新列表。
// 预设值的键必须是已声明的 param 或保留运行参数 prompt/system/resume（ai.Validate）。
func (s *Service) AddAiPreset(taskID, name, description string, values map[string]string) (AiListResult, error) {
	lt, ok := s.aiRegistry().Get(taskID)
	if !ok {
		return AiListResult{}, fmt.Errorf("未知 AI 任务 %q", taskID)
	}
	raw, err := os.ReadFile(lt.File)
	if err != nil {
		return AiListResult{}, err
	}
	out, err := registry.AddPresetToYAML(raw, name, description, values)
	if err != nil {
		return AiListResult{}, err
	}
	task, err := ai.Parse(out, s.actionRegistry().Skills)
	if err != nil {
		return AiListResult{}, err
	}
	if task.ID != taskID {
		return AiListResult{}, fmt.Errorf("id 不可修改（原 %q，现 %q）", taskID, task.ID)
	}
	if err := os.WriteFile(lt.File, out, 0o644); err != nil {
		return AiListResult{}, err
	}
	s.Reload()
	return s.ListAiTasks(), nil
}
