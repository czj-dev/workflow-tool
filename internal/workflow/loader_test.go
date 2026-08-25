// internal/workflow/loader_test.go
package workflow

import (
	"os"
	"path/filepath"
	"testing"

	"workflow-tool/internal/registry"
)

func TestLoad_ValidWorkflow(t *testing.T) {
	dir := t.TempDir()
	yaml := `id: test-wf
title: Test
steps:
  - action: some-action
  - sleep: 2
`
	os.WriteFile(filepath.Join(dir, "test.yaml"), []byte(yaml), 0644)

	reg := Load(dir)
	if len(reg.Errors) != 0 {
		t.Fatalf("unexpected errors: %v", reg.Errors)
	}
	if _, ok := reg.Workflows["test-wf"]; !ok {
		t.Fatal("workflow not loaded")
	}
	wf := reg.Workflows["test-wf"]
	if len(wf.Def.Steps) != 2 {
		t.Fatalf("expected 2 steps, got %d", len(wf.Def.Steps))
	}
}

func TestLoad_InvalidYAML(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "bad.yaml"), []byte("{{invalid"), 0644)

	reg := Load(dir)
	if len(reg.Errors) == 0 {
		t.Fatal("expected errors for invalid yaml")
	}
}

func TestValidate_EmptySteps(t *testing.T) {
	def := &WorkflowDef{ID: "x", Title: "X", Steps: nil}
	if err := Validate(def); err == nil {
		t.Fatal("expected error for empty steps")
	}
}

func TestValidate_MutualExclusive(t *testing.T) {
	def := &WorkflowDef{ID: "x", Title: "X", Steps: []Step{{Action: "a", Sleep: 2}}}
	if err := Validate(def); err == nil {
		t.Fatal("expected error for action+sleep")
	}
}

func TestValidate_ThreeKindsMutualExclusion(t *testing.T) {
	// action + shell 同时出现
	def := &WorkflowDef{ID: "x", Title: "X", Steps: []Step{{Action: "a", Run: "ls"}}}
	if err := Validate(def); err == nil {
		t.Fatal("expected error for action+shell")
	}
	// 全部为空
	def = &WorkflowDef{ID: "x", Title: "X", Steps: []Step{{}}}
	if err := Validate(def); err == nil {
		t.Fatal("expected error for empty step")
	}
}

func TestValidate_ReservedParamID(t *testing.T) {
	for _, reserved := range []string{"steps", "env", "params", "config"} {
		def := &WorkflowDef{
			ID:    "wf-1",
			Title: "t",
			Params: []registry.ParamSpec{
				{ID: reserved, Type: "text"},
			},
			Steps: []Step{{Run: "echo hi"}},
		}
		if err := Validate(def); err == nil {
			t.Errorf("param id %q 应因保留字被拒", reserved)
		}
	}
}

func TestValidate_StepIDUniqueness(t *testing.T) {
	def := &WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{ID: "a", Run: "echo 1"},
			{ID: "a", Run: "echo 2"},
		},
	}
	if err := Validate(def); err == nil {
		t.Error("重复 step id 应报错")
	}
}

func TestValidate_StepIDPattern(t *testing.T) {
	def := &WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{{ID: "Bad_ID", Run: "echo 1"}},
	}
	if err := Validate(def); err == nil {
		t.Error("step id 不合法应报错")
	}
}

func TestValidate_StepIDOptional(t *testing.T) {
	def := &WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{{Run: "echo 1"}, {Run: "echo 2"}},
	}
	if err := Validate(def); err != nil {
		t.Errorf("未写 step id 应合法（索引兜底），got %v", err)
	}
}

func TestValidate_IfReferencesUnknownStepID(t *testing.T) {
	def := &WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{ID: "build", Run: "echo 1"},
			{Run: "echo 2", If: `steps.notexist.outputs.success == 'true'`},
		},
	}
	if err := Validate(def); err == nil {
		t.Error("if 引用不存在的 step id 应报错")
	}
}

func TestValidate_IfReferencesForwardStepID(t *testing.T) {
	def := &WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{Run: "echo 1", If: `steps.later.outputs.success == 'true'`},
			{ID: "later", Run: "echo 2"},
		},
	}
	if err := Validate(def); err == nil {
		t.Error("if 引用尚未执行（后面才声明）的 step id 应报错")
	}
}

func TestValidate_IfReferencesValidPriorStepID(t *testing.T) {
	def := &WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{ID: "build", Run: "echo 1"},
			{Run: "echo 2", If: `steps.build.outputs.exit_code == '0'`},
		},
	}
	if err := Validate(def); err != nil {
		t.Errorf("if 引用前面已声明的 step id 应合法，got %v", err)
	}
}

func TestValidate_IfWithoutStepsRef_Unaffected(t *testing.T) {
	def := &WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{Run: "echo 1", If: `env.LOG_LEVEL == 'debug'`},
		},
	}
	if err := Validate(def); err != nil {
		t.Errorf("if 只用 env/params 不应受影响，got %v", err)
	}
}

func TestValidate_IfSyntaxError_NotFalselyReportedAsUnknownRef(t *testing.T) {
	def := &WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{ID: "build", Run: "echo 1"},
			{Run: "echo 2", If: `steps.build.outputs.`}, // 语法错误
		},
	}
	// referencedStepIDs 对语法错误返回 nil，Validate 本次不新增 if 语法预检，
	// 因此这里应该"不因引用校验报错"（语法错误由运行时 EvalCondition 兜底）。
	if err := Validate(def); err != nil {
		t.Errorf("语法错误的 if 不应在引用校验阶段报错，got %v", err)
	}
}

// TestValidate_StepShellModifier 校验 step.shell 修饰字段：只搭配 run 形态、值合法。
func TestValidate_StepShellModifier(t *testing.T) {
	base := func(mutate func(*Step)) *WorkflowDef {
		def := &WorkflowDef{ID: "w", Title: "W", Steps: []Step{{Run: "echo hi"}}}
		mutate(&def.Steps[0])
		return def
	}
	if err := Validate(base(func(s *Step) { s.Shell = "pwsh" })); err != nil {
		t.Fatalf("run + shell:pwsh 应合法: %v", err)
	}
	if err := Validate(base(func(s *Step) { s.Shell = "zsh" })); err == nil {
		t.Fatal("非法工具名应报错")
	}
	if err := Validate(base(func(s *Step) { s.Shell = "perl {0}" })); err != nil {
		t.Fatalf("自定义模板应合法: %v", err)
	}
	// shell 配 action 形态应报错
	def := &WorkflowDef{ID: "w", Title: "W", Steps: []Step{{Action: "demo-echo", Shell: "bash"}}}
	if err := Validate(def); err == nil {
		t.Fatal("action step 配 shell 应报错")
	}
}
