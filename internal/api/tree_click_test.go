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

func TestResolveTreeClickMultiJoinsPathsWithNewline(t *testing.T) {
	svc := &Service{reg: &registry.Registry{Actions: map[string]registry.LoadedAction{
		"source": {Def: registry.ActionDef{HMI: &registry.HMI{Tree: &registry.TreeHMI{Click: &registry.TreeClick{
			Action: "target", Multi: true,
			Params: map[string]string{
				"INNER_PATH": "${{ nodes.paths }}", "ZIP": "${{ params.ZIP_NAME }}",
			},
		}}}}},
		"target": {Def: registry.ActionDef{ID: "target"}},
	}}}
	result, err := svc.ResolveTreeClickMulti("source", []map[string]any{
		{"path": "a/b.gz"}, {"path": "c.txt"},
	}, map[string]any{"ZIP_NAME": "logs.zip"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "target" || result.Params["INNER_PATH"] != "a/b.gz\nc.txt" || result.Params["ZIP"] != "logs.zip" {
		t.Fatalf("unexpected multi click mapping: %+v", result)
	}
}

func TestResolveTreeClickSingleAlsoFillsNodesPaths(t *testing.T) {
	// 单击 = 单元素多选：声明 multi 的动作统一用 ${{ nodes.paths }}，单击路径也能求值。
	svc := &Service{reg: &registry.Registry{Actions: map[string]registry.LoadedAction{
		"source": {Def: registry.ActionDef{HMI: &registry.HMI{Tree: &registry.TreeHMI{Click: &registry.TreeClick{
			Action: "target", Multi: true,
			Params: map[string]string{"INNER_PATH": "${{ nodes.paths }}"},
		}}}}},
		"target": {Def: registry.ActionDef{ID: "target"}},
	}}}
	result, err := svc.ResolveTreeClick("source", map[string]any{"path": "only.gz"}, nil)
	if err != nil || result.Params["INNER_PATH"] != "only.gz" {
		t.Fatalf("expected single node path via nodes.paths, got %+v, %v", result, err)
	}
}

func TestResolveTreeClickMultiGuards(t *testing.T) {
	multiSvc := &Service{reg: &registry.Registry{Actions: map[string]registry.LoadedAction{
		"source": {Def: registry.ActionDef{HMI: &registry.HMI{Tree: &registry.TreeHMI{Click: &registry.TreeClick{
			Action: "target", Multi: true, Params: map[string]string{"F": "${{ nodes.paths }}"},
		}}}}},
		"target": {Def: registry.ActionDef{ID: "target"}},
	}}}
	noMultiSvc := &Service{reg: &registry.Registry{Actions: map[string]registry.LoadedAction{
		"source": {Def: registry.ActionDef{HMI: &registry.HMI{Tree: &registry.TreeHMI{Click: &registry.TreeClick{
			Action: "target", Params: map[string]string{"F": "${{ node.path }}"},
		}}}}},
		"target": {Def: registry.ActionDef{ID: "target"}},
	}}}
	// 空选择拒绝
	if _, err := multiSvc.ResolveTreeClickMulti("source", nil, nil); err == nil || !strings.Contains(err.Error(), "未选中") {
		t.Fatalf("空选择应报错, got %v", err)
	}
	// 缺 path 的节点拒绝
	if _, err := multiSvc.ResolveTreeClickMulti("source", []map[string]any{{"label": "x"}}, nil); err == nil || !strings.Contains(err.Error(), "path") {
		t.Fatalf("缺 path 应报错, got %v", err)
	}
	// 未声明 multi 的动作拒绝批量解析（旧动作只能走单节点路径）
	if _, err := noMultiSvc.ResolveTreeClickMulti("source", []map[string]any{{"path": "a"}}, nil); err == nil || !strings.Contains(err.Error(), "multi") {
		t.Fatalf("未声明 multi 应报错, got %v", err)
	}
	// 未声明 multi 的单击照旧走 node.path（旧路径不受影响）
	result, err := noMultiSvc.ResolveTreeClick("source", map[string]any{"path": "a.gz"}, nil)
	if err != nil || result.Params["F"] != "a.gz" {
		t.Fatalf("legacy single click broken: %+v, %v", result, err)
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
