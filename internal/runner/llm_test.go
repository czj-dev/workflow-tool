package runner

import (
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

func TestPumpLLM_StructuredOutputs(t *testing.T) {
	input := strings.Join([]string{
		`{"type":"system","subtype":"init","session_id":"sess-abc-123"}`,
		`{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"思考中"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"，世界"}]}}`,
		`{"type":"result","total_cost_usd":0.0123,"usage":{"input_tokens":100,"output_tokens":50}}`,
	}, "\n")

	outputs := map[string]string{}
	done := make(chan struct{})
	pumpLLM(strings.NewReader(input), func(string, string) {}, done, outputs)
	<-done

	if outputs["session_id"] != "sess-abc-123" {
		t.Fatalf("session_id = %q, want sess-abc-123", outputs["session_id"])
	}
	if outputs["text"] != "你好，世界" {
		t.Fatalf("text = %q, want 你好，世界", outputs["text"])
	}
	if outputs["thinking"] != "思考中" {
		t.Fatalf("thinking = %q, want 思考中", outputs["thinking"])
	}
	if outputs["cost_usd"] != "0.0123" {
		t.Fatalf("cost_usd = %q, want 0.0123", outputs["cost_usd"])
	}
	if outputs["total_tokens"] != "150" {
		t.Fatalf("total_tokens = %q, want 150", outputs["total_tokens"])
	}
}
