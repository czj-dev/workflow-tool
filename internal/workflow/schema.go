// internal/workflow/schema.go
package workflow

import (
	"fmt"
	"regexp"

	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
)

var idPattern = regexp.MustCompile(`^[a-z0-9-]+$`)

// 合法的参数类型（与 action 的 ParamSpec 保持一致）。
var validParamTypes = map[string]bool{
	"text": true, "bool": true, "select": true, "path": true, "file": true,
}

// reservedParamIDs 是 params[].id 不能占用的保留字（用于 expr 表达式的扁平顶层命名空间）。
var reservedParamIDs = map[string]bool{
	"steps": true, "env": true, "params": true, "config": true,
}

// WorkflowDef 是 workflow YAML 的原始结构。
// Params 由 workflow 自行声明（不从 step 引用的 action 聚合），运行时作为全局变量注入各 step。
type WorkflowDef struct {
	ID          string               `yaml:"id"`
	Title       string               `yaml:"title"`
	Icon        string               `yaml:"icon"`
	Description string               `yaml:"description"`
	Env         map[string]string    `yaml:"env"` // workflow 级默认环境变量
	Params      []registry.ParamSpec `yaml:"params"`
	Steps       []Step               `yaml:"steps"`
}

// Step 是 workflow 中的一步。action / run / sleep 三者互斥。
type Step struct {
	ID              string            `yaml:"id"`                // 可选；未写用 steps[i] 索引兜底
	Name            string            `yaml:"name"`              // 可选；Pipeline Spine 显示用
	If              string            `yaml:"if"`                // 可选；expr 表达式，false → SKIPPED
	Action          string            `yaml:"action"`            // 引用已有 action id
	Params          map[string]string `yaml:"params"`            // 覆盖 action 的参数
	Sleep           int               `yaml:"sleep"`             // sleep N 秒
	Run             string            `yaml:"run"`               // 直接执行的内联命令（GHA run）
	Shell           string            `yaml:"shell"`             // 可选修饰：解释器（默认 bash），只搭配 run
	Timeout         string            `yaml:"timeout"`           // 仅 run step 有效
	Env             map[string]string `yaml:"env"`               // step 级 env，覆盖 workflow.env 同名 key
	CaptureOutput   *bool             `yaml:"capture_output"`    // nil/true=默认；false=关闭
	Retry           int               `yaml:"retry"`             // 可选重试次数
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
	for i, p := range def.Params {
		if p.ID == "" {
			return fmt.Errorf("params[%d]: id 必填", i)
		}
		if reservedParamIDs[p.ID] {
			return fmt.Errorf("params[%d]: id %q 为保留字（steps/env/params/config 不可用作 param id）", i, p.ID)
		}
		if p.Type != "" && !validParamTypes[p.Type] {
			return fmt.Errorf("params[%d]: type 非法 %q（text|bool|select|path）", i, p.Type)
		}
		if p.Type == "select" && len(p.Options) == 0 {
			return fmt.Errorf("params[%d]: select 必须提供 options", i)
		}
	}
	seenStepID := map[string]int{}
	for i, s := range def.Steps {
		count := 0
		if s.Action != "" {
			count++
		}
		if s.Sleep > 0 {
			count++
		}
		if s.Run != "" {
			count++
		}
		if count == 0 {
			return fmt.Errorf("steps[%d]: 必须指定 action、run 或 sleep 之一", i)
		}
		if count > 1 {
			return fmt.Errorf("steps[%d]: action、run、sleep 三者互斥", i)
		}
		if s.ID != "" {
			if !idPattern.MatchString(s.ID) {
				return fmt.Errorf("steps[%d].id 必须匹配 ^[a-z0-9-]+$，got %q", i, s.ID)
			}
			if prev, ok := seenStepID[s.ID]; ok {
				return fmt.Errorf("steps[%d].id 重复（与 steps[%d] 冲突）: %q", i, prev, s.ID)
			}
			seenStepID[s.ID] = i
		}
		if s.If != "" {
			for _, refID := range referencedStepIDs(s.If) {
				if _, ok := seenStepID[refID]; !ok {
					return fmt.Errorf("steps[%d].if 引用了不存在或尚未执行的 step id %q", i, refID)
				}
			}
		}
		if s.Shell != "" {
			if s.Run == "" {
				return fmt.Errorf("steps[%d]: shell 只能搭配 run 形态", i)
			}
			if !runner.IsValidShellName(s.Shell) {
				return fmt.Errorf("steps[%d].shell 非法 %q：应为 %s 之一或含 {0} 的自定义模板", i, s.Shell, runner.KnownShellNames())
			}
		}
	}
	return nil
}
