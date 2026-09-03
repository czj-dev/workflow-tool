package runner

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseLLMLineAssistantText(t *testing.T) {
	// 真实 assistant text 事件（简化）
	line := `{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"OK"}]}}`
	kind, delta, ok := parseLLMLine(line)
	if !ok || kind != "text" || delta != "OK" {
		t.Fatalf("want (text,OK,true)，got (%q,%q,%v)", kind, delta, ok)
	}
}

func TestParseLLMLineAssistantMultipleTextBlocks(t *testing.T) {
	// 多个 text 块拼接
	line := `{"type":"assistant","message":{"content":[{"type":"text","text":"你好"},{"type":"text","text":"世界"}]}}`
	kind, delta, ok := parseLLMLine(line)
	if !ok || kind != "text" || delta != "你好世界" {
		t.Fatalf("want (text,你好世界,true)，got (%q,%q,%v)", kind, delta, ok)
	}
}

func TestParseLLMLineAssistantThinking(t *testing.T) {
	// thinking 块：提取为 kind=thinking
	line := `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"思考中..."}]}}`
	kind, delta, ok := parseLLMLine(line)
	if !ok || kind != "thinking" || delta != "思考中..." {
		t.Fatalf("want (thinking,思考中...,true)，got (%q,%q,%v)", kind, delta, ok)
	}
}

func TestParseLLMLineSystemSkipped(t *testing.T) {
	line := `{"type":"system","subtype":"thinking_tokens","estimated_tokens":5}`
	kind, delta, ok := parseLLMLine(line)
	if ok || kind != "" || delta != "" {
		t.Fatalf("system 行应跳过，got (%q,%q,%v)", kind, delta, ok)
	}
}

func TestParseLLMLineResultSkipped(t *testing.T) {
	line := `{"type":"result","subtype":"success","result":"OK","duration_ms":8585}`
	kind, delta, ok := parseLLMLine(line)
	if ok || kind != "" || delta != "" {
		t.Fatalf("result 行应跳过，got (%q,%q,%v)", kind, delta, ok)
	}
}

func TestParseLLMLineGarbageSkipped(t *testing.T) {
	// 非 JSON 行（claude 偶发输出）不崩溃、跳过
	kind, delta, ok := parseLLMLine("这不是 JSON")
	if ok || kind != "" || delta != "" {
		t.Fatalf("非 JSON 行应跳过，got (%q,%q,%v)", kind, delta, ok)
	}
}

func TestParseLLMLineToolUse(t *testing.T) {
	// 真实 assistant tool_use 事件（Read 工具）：delta 为 {id,name,input} JSON，input 原样透传
	line := `{"type":"assistant","message":{"content":[{"id":"call_4a83","type":"tool_use","name":"Read","input":{"file_path":"C:\\tmp\\package.json"}}]}}`
	kind, delta, ok := parseLLMLine(line)
	if !ok || kind != "tool_use" {
		t.Fatalf("want kind=tool_use，got (%q,%v)", kind, ok)
	}
	var p struct {
		ID    string            `json:"id"`
		Name  string            `json:"name"`
		Input map[string]string `json:"input"`
	}
	if err := json.Unmarshal([]byte(delta), &p); err != nil {
		t.Fatalf("delta 不是合法 JSON: %v", err)
	}
	if p.ID != "call_4a83" || p.Name != "Read" || p.Input["file_path"] != `C:\tmp\package.json` {
		t.Fatalf("字段不符: %+v", p)
	}
}

func TestParseLLMLineToolUseNoIDSkipped(t *testing.T) {
	// 无 id 的 tool_use 块跳过（防配对悬挂）
	line := `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}`
	kind, _, ok := parseLLMLine(line)
	if ok || kind != "" {
		t.Fatalf("无 id 的 tool_use 应跳过，got (%q,%v)", kind, ok)
	}
}

func TestParseLLMLineToolResult(t *testing.T) {
	// 真实 user tool_result 事件：delta 为 {id,content,isError} JSON，content 原样透传
	line := `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call_4a83","content":"1\t{\n2\t  \"name\": \"frontend\""}]}}`
	kind, delta, ok := parseLLMLine(line)
	if !ok || kind != "tool_result" {
		t.Fatalf("want kind=tool_result，got (%q,%v)", kind, ok)
	}
	var p struct {
		ID      string          `json:"id"`
		Content json.RawMessage `json:"content"`
		IsError bool            `json:"isError"`
	}
	if err := json.Unmarshal([]byte(delta), &p); err != nil {
		t.Fatalf("delta 不是合法 JSON: %v", err)
	}
	if p.ID != "call_4a83" || p.IsError {
		t.Fatalf("字段不符: %+v", p)
	}
	var s string
	if err := json.Unmarshal(p.Content, &s); err != nil || !strings.Contains(s, "frontend") {
		t.Fatalf("content 应为字符串透传，got %s", p.Content)
	}
}

func TestParseLLMLineUserNonToolResultSkipped(t *testing.T) {
	// user 事件但非 tool_result（如真实用户输入）跳过
	line := `{"type":"user","message":{"content":[{"type":"text","text":"用户插话"}]}}`
	kind, _, ok := parseLLMLine(line)
	if ok || kind != "" {
		t.Fatalf("非 tool_result 的 user 行应跳过，got (%q,%v)", kind, ok)
	}
}

func TestRecordStructuredFieldsResultTokens(t *testing.T) {
	// result 事件补记分项 tokens（聊天页终点读数行用）
	line := `{"type":"result","subtype":"success","duration_ms":18878,"total_cost_usd":0.129653,"usage":{"input_tokens":21292,"output_tokens":193}}`
	outputs := map[string]string{}
	recordStructuredFields(line, outputs)
	if outputs["cost_usd"] != "0.129653" {
		t.Fatalf("cost_usd = %q", outputs["cost_usd"])
	}
	if outputs["total_tokens"] != "21485" {
		t.Fatalf("total_tokens = %q", outputs["total_tokens"])
	}
	if outputs["input_tokens"] != "21292" || outputs["output_tokens"] != "193" {
		t.Fatalf("分项 tokens = %q / %q", outputs["input_tokens"], outputs["output_tokens"])
	}
}
