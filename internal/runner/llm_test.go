package runner

import (
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

