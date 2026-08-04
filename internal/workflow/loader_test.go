// internal/workflow/loader_test.go
package workflow

import (
	"os"
	"path/filepath"
	"testing"
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
