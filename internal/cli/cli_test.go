package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"workflow-tool/internal/ai"
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

func TestResolveAiTask(t *testing.T) {
	// 不加 --kind：只有 AI 任务命中时直接解析为 ai
	e := &env{
		reg:   &registry.Registry{},
		wfReg: &workflow.WorkflowRegistry{},
		aiReg: &ai.Registry{Tasks: map[string]ai.LoadedTask{"t-ask": {Task: ai.Task{ID: "t-ask"}}}},
	}
	if tgt, cerr := e.resolve("t-ask", ""); cerr != nil || tgt.kind != "ai" {
		t.Fatalf("AI 任务应解析为 ai: %v / %+v", cerr, tgt)
	}
	// --kind 指定到没有该种类的 id → unknown_id
	if _, cerr := e.resolve("t-ask", "action"); cerr == nil || cerr.Kind != "unknown_id" {
		t.Fatalf("期望 unknown_id，得到 %v", cerr)
	}
	// 与 action 撞名：无 --kind 报歧义，--kind ai 消歧
	e.reg = &registry.Registry{Actions: map[string]registry.LoadedAction{"t-ask": {Def: registry.ActionDef{ID: "t-ask"}}}}
	if _, cerr := e.resolve("t-ask", ""); cerr == nil || cerr.Kind != "ambiguous_id" {
		t.Fatalf("期望 ambiguous_id，得到 %v", cerr)
	}
	if tgt, cerr := e.resolve("t-ask", "ai"); cerr != nil || tgt.kind != "ai" {
		t.Fatalf("--kind ai 消歧失败: %v / %+v", cerr, tgt)
	}
	if _, cerr := e.resolve("t-ask", "nope"); cerr == nil || cerr.Kind != "bad_params" {
		t.Fatalf("期望 bad_params，得到 %v", cerr)
	}
}

func TestAiBlocked(t *testing.T) {
	t.Run("直接 run AI 任务被拒", func(t *testing.T) {
		var buf bytes.Buffer
		tgt := target{kind: "ai", lt: ai.LoadedTask{Task: ai.Task{ID: "t-ask"}}}
		code := (&env{}).runTarget(context.Background(), tgt, nil, "", true, json.NewEncoder(&buf))
		assertBlocked(t, code, &buf)
	})

	t.Run("workflow 含 ai step 被拒", func(t *testing.T) {
		lw := workflow.LoadedWorkflow{Def: workflow.WorkflowDef{
			ID: "wf", Steps: []workflow.Step{{Run: "echo hi"}, {ID: "analyze", AI: "t-ask"}},
		}}
		var buf bytes.Buffer
		code := (&env{}).runWorkflow(context.Background(), lw, map[string]any{}, "", true, json.NewEncoder(&buf))
		assertBlocked(t, code, &buf)
	})
}

func TestListAndDescribeAiTask(t *testing.T) {
	prompt := "介绍一下 ${TOPIC}"
	e := &env{
		reg:   &registry.Registry{Actions: map[string]registry.LoadedAction{"z-act": {Def: registry.ActionDef{ID: "z-act", Title: "Act"}}}},
		wfReg: &workflow.WorkflowRegistry{},
		aiReg: &ai.Registry{Tasks: map[string]ai.LoadedTask{
			"t-ask": {Task: ai.Task{
				ID: "t-ask", Title: "Ask",
				Params:  []registry.ParamSpec{{ID: "TOPIC", Type: "text", Required: true}},
				Presets: []registry.Preset{{Name: "问 Go", Values: map[string]string{"TOPIC": "Go"}}},
				Prompt:  &prompt,
				System:  "你是助手",
			}},
		}},
	}
	// list：AI 任务以 kind: ai 入列，与 action/workflow 一起按 id 排序
	want := []listItem{
		{ID: "t-ask", Title: "Ask", Kind: "ai"},
		{ID: "z-act", Title: "Act", Kind: "action"},
	}
	if items := listItems(e); !slices.Equal(items, want) {
		t.Fatalf("list = %+v，want %+v", items, want)
	}

	// describe：参数契约之外多出 prompt/system 与保留运行参数
	tgt, cerr := e.resolve("t-ask", "")
	if cerr != nil {
		t.Fatal(cerr)
	}
	m := describeJSON(t, describeOf("t-ask", tgt))
	if m["kind"] != "ai" || m["prompt"] != "介绍一下 ${TOPIC}" || m["system"] != "你是助手" {
		t.Fatalf("describe 输出不符: %v", m)
	}
	if rp, _ := m["reservedRunParams"].([]any); !slices.Equal(rp, []any{"prompt", "system", "resume"}) {
		t.Fatalf("reservedRunParams = %v", m["reservedRunParams"])
	}
	if ps, _ := m["params"].([]any); len(ps) != 1 {
		t.Fatalf("params 应原样带回: %v", m["params"])
	}

	// prompt 键必须出现（空串 = 提示词由调用方给入）；system 为空时省略
	empty := ""
	e.aiReg = &ai.Registry{Tasks: map[string]ai.LoadedTask{"t-ask": {Task: ai.Task{ID: "t-ask", Prompt: &empty}}}}
	tgt, _ = e.resolve("t-ask", "")
	m = describeJSON(t, describeOf("t-ask", tgt))
	if v, ok := m["prompt"]; !ok || v != "" {
		t.Fatalf("空 prompt 也应输出 prompt 键: %v", m)
	}
	if _, ok := m["system"]; ok {
		t.Fatalf("system 为空时应省略: %v", m)
	}
}

// describeJSON 把 describe 输出对象按 JSON 往返一遍：验证可编码，并便于按键断言。
func describeJSON(t *testing.T, v any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
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
	if e.Type != "error" || e.Kind != "ai_blocked" {
		t.Fatalf("期望 kind=ai_blocked，得到 %+v", e)
	}
}
