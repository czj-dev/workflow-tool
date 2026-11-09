package api

import (
	"strings"
	"testing"

	"workflow-tool/internal/registry"
)

func TestResolveTreeClickMapsExplicitParams(t *testing.T) {
	svc := &Service{reg: &registry.Registry{Actions: map[string]registry.LoadedAction{
		"source": {Def: registry.ActionDef{HMI: &registry.HMI{Tree: &registry.TreeHMI{Click: &registry.TreeClick{
			Action: "target", Params: map[string]string{
				"FILE": "${{ node.path }}", "ZIP": "${{ params.ZIP_NAME }}",
			},
		}}}}},
		"target": {Def: registry.ActionDef{ID: "target"}},
	}}}
	result, err := svc.ResolveTreeClick("source", map[string]any{"path": "a/b.log"}, map[string]any{"ZIP_NAME": "logs.zip", "EXTRA": "unused"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "target" || result.Params["FILE"] != "a/b.log" || result.Params["ZIP"] != "logs.zip" || len(result.Params) != 2 {
		t.Fatalf("unexpected click mapping: %+v", result)
	}
}

func TestResolveTreeClickRejectsSecondVariableExpansion(t *testing.T) {
	svc := &Service{reg: &registry.Registry{Actions: map[string]registry.LoadedAction{
		"source": {Def: registry.ActionDef{HMI: &registry.HMI{Tree: &registry.TreeHMI{Click: &registry.TreeClick{
			Action: "target", Params: map[string]string{"FILE": "${{ node.path }}"},
		}}}}},
		"target": {Def: registry.ActionDef{ID: "target"}},
	}}}
	_, err := svc.ResolveTreeClick("source", map[string]any{"path": "${SECRET}.log"}, nil)
	if err == nil || !strings.Contains(err.Error(), "FILE") {
		t.Fatalf("expected unexpanded variable error, got %v", err)
	}
}

func TestResolveTreeClickRejectsMissingTarget(t *testing.T) {
	svc := &Service{reg: &registry.Registry{Actions: map[string]registry.LoadedAction{
		"source": {Def: registry.ActionDef{HMI: &registry.HMI{Tree: &registry.TreeHMI{Click: &registry.TreeClick{Action: "missing"}}}}},
	}}}
	_, err := svc.ResolveTreeClick("source", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("expected missing target error, got %v", err)
	}
}
