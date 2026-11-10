package api

import (
	"context"
	"encoding/json"
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

func TestResolveTreeClickPreservesLiteralVariableInNodePath(t *testing.T) {
	svc := &Service{reg: &registry.Registry{Actions: map[string]registry.LoadedAction{
		"source": {Def: registry.ActionDef{HMI: &registry.HMI{Tree: &registry.TreeHMI{Click: &registry.TreeClick{
			Action: "target", Params: map[string]string{"FILE": "${{ node.path }}"},
		}}}}},
		"target": {Def: registry.ActionDef{ID: "target"}},
	}}}
	result, err := svc.ResolveTreeClick("source", map[string]any{"path": "${SECRET}.log"}, nil)
	if err != nil || result.Params["FILE"] != "${SECRET}.log" {
		t.Fatalf("expected literal node path, got %+v, %v", result, err)
	}
}

func TestPrepareActionParamsPreservesOnlyLiteralKeys(t *testing.T) {
	t.Setenv("DATE", "expanded")
	var params map[string]any
	if err := json.Unmarshal([]byte(`{"FILE":{"$literal":"${DATE}.gz"},"OUT":"${DATE}/out","COPY":"${FILE}"}`), &params); err != nil {
		t.Fatal(err)
	}
	decoded, literalKeys, err := decodeLiteralParams(params)
	if err != nil {
		t.Fatal(err)
	}
	got := expandDirectParams(context.Background(), decoded, nil, literalKeys)
	if got["FILE"] != "${DATE}.gz" || got["OUT"] != "expanded/out" || got["COPY"] != "${DATE}.gz" {
		t.Fatalf("literal and regular expansion diverged: %#v", got)
	}
	if _, ok := params["FILE"].(map[string]any); !ok {
		t.Fatal("must not mutate original params")
	}
}

func TestPrepareActionParamsRejectsMalformedLiteral(t *testing.T) {
	for _, value := range []any{map[string]any{"$literal": 1}, map[string]any{"$literal": "a", "extra": true}, map[string]any{"unexpected": "value"}} {
		_, _, err := decodeLiteralParams(map[string]any{"FILE": value})
		if err == nil || !strings.Contains(err.Error(), "FILE") {
			t.Fatalf("expected FILE validation error for %#v, got %v", value, err)
		}
	}
}

func TestRunActionRejectsLiteralInterpolationIntoInlineShell(t *testing.T) {
	err := rejectLiteralShellSubstitution(`printf '%s' "${FILE}"`, map[string]bool{"FILE": true})
	if err == nil || !strings.Contains(err.Error(), "FILE") {
		t.Fatalf("literal shell substitution must be rejected: %v", err)
	}
	if err := rejectLiteralShellSubstitution(`printf '%s' "$FILE"`, map[string]bool{"FILE": true}); err != nil {
		t.Fatalf("environment variable reference must be allowed: %v", err)
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
