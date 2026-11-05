package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
	"workflow-tool/internal/workflow"
)

func TestParseParamsFlag(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		wantErr bool
		wantKey string
	}{
		{"空输入", "", false, ""},
		{"合法对象", `{"a":"x","n":1}`, false, "a"},
		{"非法 JSON", `not json`, true, ""},
		{"空白", "   ", false, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m, cerr := parseParamsFlag(tt.raw)
			if tt.wantErr {
				if cerr == nil || cerr.Kind != "bad_params" {
					t.Fatalf("期望 bad_params，得到 %v", cerr)
				}
				return
			}
			if cerr != nil {
				t.Fatalf("意外错误 %v", cerr)
			}
			if tt.wantKey != "" {
				if _, ok := m[tt.wantKey]; !ok {
					t.Fatalf("缺少 key %q", tt.wantKey)
				}
			}
		})
	}
}

func TestCoerceParams(t *testing.T) {
	specs := []registry.ParamSpec{
		{ID: "name", Type: "text", Required: true},
		{ID: "flag", Type: "bool"},
		{ID: "mode", Type: "select", Options: []string{"a", "b"}},
		{ID: "opt", Type: "text", Default: "dft"},
	}

	t.Run("缺必填报 validation", func(t *testing.T) {
		_, cerr := coerceParams(specs, map[string]any{})
		if cerr == nil || cerr.Kind != "validation" {
			t.Fatalf("期望 validation，得到 %v", cerr)
		}
	})
	t.Run("bool 非布尔报 validation", func(t *testing.T) {
		_, cerr := coerceParams(specs, map[string]any{"name": "x", "flag": "true"})
		if cerr == nil || cerr.Kind != "validation" {
			t.Fatalf("期望 validation，得到 %v", cerr)
		}
	})
	t.Run("select 越界报 validation", func(t *testing.T) {
		_, cerr := coerceParams(specs, map[string]any{"name": "x", "mode": "z"})
		if cerr == nil || cerr.Kind != "validation" {
			t.Fatalf("期望 validation，得到 %v", cerr)
		}
	})
	t.Run("happy path 归一 + 默认值", func(t *testing.T) {
		out, cerr := coerceParams(specs, map[string]any{"name": "x", "flag": true, "mode": "a"})
		if cerr != nil {
			t.Fatalf("意外错误 %v", cerr)
		}
		if out["flag"] != true {
			t.Fatalf("flag 应为 bool true，得到 %T %v", out["flag"], out["flag"])
		}
		if out["opt"] != "dft" {
			t.Fatalf("opt 应补默认值 dft，得到 %v", out["opt"])
		}
	})
}

func TestJSONEmitAndFinish(t *testing.T) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)

	emit := jsonEmit(enc)
	emit("stdout", "building...")
	emit("step-done", "0:0")
	finish(true, enc, runner.Result{
		ExitCode: 0, Duration: 5 * time.Millisecond,
		Outputs: map[string]string{"exit_code": "0", "myKey": "v"},
	})

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("期望 3 行 NDJSON，得到 %d:\n%s", len(lines), buf.String())
	}

	var out outputLine
	if err := json.Unmarshal([]byte(lines[0]), &out); err != nil {
		t.Fatal(err)
	}
	if out.Type != "output" || out.Stream != "stdout" || out.Line != "building..." {
		t.Fatalf("output 行镜像错误: %+v", out)
	}

	var res resultLine
	if err := json.Unmarshal([]byte(lines[2]), &res); err != nil {
		t.Fatal(err)
	}
	if res.Type != "result" || res.ExitCode != 0 || !res.Success || res.Error != nil {
		t.Fatalf("result 行错误: %+v", res)
	}
	if res.Outputs["myKey"] != "v" {
		t.Fatalf("result.outputs 丢失自定义键: %+v", res.Outputs)
	}
}

func TestResolveAmbiguous(t *testing.T) {
	e := &env{
		reg: &registry.Registry{Actions: map[string]registry.LoadedAction{
			"dup": {Def: registry.ActionDef{ID: "dup"}},
		}},
		wfReg: &workflow.WorkflowRegistry{Workflows: map[string]workflow.LoadedWorkflow{
			"dup": {Def: workflow.WorkflowDef{ID: "dup"}},
		}},
	}
	if _, cerr := e.resolve("dup", ""); cerr == nil || cerr.Kind != "ambiguous_id" {
		t.Fatalf("期望 ambiguous_id，得到 %v", cerr)
	}
	// 加 --kind 消歧后应成功
	if tgt, cerr := e.resolve("dup", "action"); cerr != nil || tgt.kind != "action" {
		t.Fatalf("--kind 消歧失败: %v / %+v", cerr, tgt)
	}
	if _, cerr := e.resolve("missing", ""); cerr == nil || cerr.Kind != "unknown_id" {
		t.Fatalf("期望 unknown_id，得到 %v", cerr)
	}
}

func TestLLMBlocked(t *testing.T) {
	llmAction := registry.LoadedAction{Def: registry.ActionDef{
		ID: "ai", Command: registry.Command{LLM: registry.LLMCommand{Prompt: "p"}},
	}}

	t.Run("直接 run llm 动作被拒", func(t *testing.T) {
		e := &env{}
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		code := e.runAction(context.Background(), llmAction, map[string]any{}, "", true, enc)
		assertBlocked(t, code, &buf)
	})

	t.Run("workflow 引用 llm step 被拒", func(t *testing.T) {
		e := &env{reg: &registry.Registry{Actions: map[string]registry.LoadedAction{"ai": llmAction}}}
		lw := workflow.LoadedWorkflow{Def: workflow.WorkflowDef{
			ID: "wf", Steps: []workflow.Step{{Action: "ai"}},
		}}
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		code := e.runWorkflow(context.Background(), lw, map[string]any{}, "", true, enc)
		assertBlocked(t, code, &buf)
	})
}

func assertBlocked(t *testing.T, code int, buf *bytes.Buffer) {
	t.Helper()
	if code != exitCLIError {
		t.Fatalf("期望退出码 %d，得到 %d", exitCLIError, code)
	}
	var e errorLine
	if err := json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &e); err != nil {
		t.Fatalf("error 行解析失败: %v (%q)", err, buf.String())
	}
	if e.Type != "error" || e.Kind != "llm_blocked" {
		t.Fatalf("期望 kind=llm_blocked，得到 %+v", e)
	}
}
