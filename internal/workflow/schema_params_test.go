package workflow

import (
	"strings"
	"testing"

	"workflow-tool/internal/registry"
)

func TestValidateWorkflowArrayDefaults(t *testing.T) {
	cases := []struct {
		name, kind, value string
		valid             bool
	}{
		{"list missing", "list", "", true},
		{"list empty array", "list", "[]", true},
		{"list unicode", "list", `["中😀"]`, true},
		{"list number", "list", `[1]`, false},
		{"list dynamic", "list", "${TAGS}", false},
		{"arguments missing", "arguments", "", true},
		{"arguments empty array", "arguments", "[]", true},
		{"arguments valid", "arguments", `[{"flag":"--es","values":["a"]}]`, true},
		{"arguments missing values", "arguments", `[{"flag":"--es"}]`, false},
		{"arguments dynamic", "arguments", "${ARGS}", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			def := &WorkflowDef{ID: "a", Title: "A", Steps: []Step{{Run: "echo"}},
				Params: []registry.ParamSpec{{ID: "MY_PARAM", Type: tc.kind, Default: tc.value}}}
			err := Validate(def)
			if tc.valid && err != nil {
				t.Fatalf("expected valid default: %v", err)
			}
			if !tc.valid && (err == nil || !strings.Contains(err.Error(), "MY_PARAM")) {
				t.Fatalf("expected error with param id, got %v", err)
			}
		})
	}
}

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
