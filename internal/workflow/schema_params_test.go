package workflow

import (
	"strings"
	"testing"

	"workflow-tool/internal/registry"
)

func TestValidateWorkflowParamTypes(t *testing.T) {
	for _, paramType := range []string{"list", "arguments", "textarea", "file", "text"} {
		t.Run(paramType, func(t *testing.T) {
			def := &WorkflowDef{ID: "a", Title: "A", Steps: []Step{{Run: "echo hi"}},
				Params: []registry.ParamSpec{{ID: "ARGS", Type: paramType}}}
			if err := Validate(def); err != nil {
				t.Fatalf("type %s should be accepted: %v", paramType, err)
			}
		})
	}
	def := &WorkflowDef{ID: "a", Title: "A", Steps: []Step{{Run: "echo hi"}},
		Params: []registry.ParamSpec{{ID: "ARGS", Type: "object"}}}
	if err := Validate(def); err == nil || !strings.Contains(err.Error(), "object") {
		t.Fatalf("unknown parameter type should be rejected: %v", err)
	}
}
