// internal/workflow/schema.go
package workflow

import (
	"fmt"
	"regexp"
)

var idPattern = regexp.MustCompile(`^[a-z0-9-]+$`)

// WorkflowDef 是 workflow YAML 的原始结构。
type WorkflowDef struct {
	ID          string `yaml:"id"`
	Title       string `yaml:"title"`
	Icon        string `yaml:"icon"`
	Description string `yaml:"description"`
	Steps       []Step `yaml:"steps"`
}

// Step 是 workflow 中的一步。action / sleep / shell 三者互斥。
type Step struct {
	Action          string            `yaml:"action"`          // 引用已有 action id
	Params          map[string]string `yaml:"params"`          // 覆盖 action 的参数
	Sleep           int               `yaml:"sleep"`           // sleep N 秒
	Shell           string            `yaml:"shell"`           // 直接执行 shell 命令
	Timeout         string            `yaml:"timeout"`         // 仅 shell step 有效
	Retry           int               `yaml:"retry"`           // 可选重试次数
	ContinueOnError bool              `yaml:"continue_on_error"` // 失败时继续
}

// LoadedWorkflow 是已校验的 workflow。
type LoadedWorkflow struct {
	Def  WorkflowDef
	File string // 源文件绝对路径
}

// Validate 校验 WorkflowDef 合法性。
func Validate(def *WorkflowDef) error {
	if !idPattern.MatchString(def.ID) {
		return fmt.Errorf("id 必须匹配 ^[a-z0-9-]+$，got %q", def.ID)
	}
	if def.Title == "" {
		return fmt.Errorf("title 必填")
	}
	if len(def.Steps) == 0 {
		return fmt.Errorf("steps 不能为空")
	}
	for i, s := range def.Steps {
		count := 0
		if s.Action != "" {
			count++
		}
		if s.Sleep > 0 {
			count++
		}
		if s.Shell != "" {
			count++
		}
		if count == 0 {
			return fmt.Errorf("steps[%d]: 必须指定 action、sleep 或 shell 之一", i)
		}
		if count > 1 {
			return fmt.Errorf("steps[%d]: action、sleep、shell 三者互斥", i)
		}
	}
	return nil
}
