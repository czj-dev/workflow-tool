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
	def := &WorkflowDef{ID: "x", Title: "X", Steps: []Step{{Action: "a", Shell: "ls"}}}
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
			Steps: []Step{{Shell: "echo hi"}},
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
			{ID: "a", Shell: "echo 1"},
			{ID: "a", Shell: "echo 2"},
		},
	}
	if err := Validate(def); err == nil {
		t.Error("重复 step id 应报错")
	}
}

func TestValidate_StepIDPattern(t *testing.T) {
	def := &WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{{ID: "Bad_ID", Shell: "echo 1"}},
	}
	if err := Validate(def); err == nil {
		t.Error("step id 不合法应报错")
	}
}

func TestValidate_StepIDOptional(t *testing.T) {
	def := &WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{{Shell: "echo 1"}, {Shell: "echo 2"}},
	}
	if err := Validate(def); err != nil {
		t.Errorf("未写 step id 应合法（索引兜底），got %v", err)
	}
}
