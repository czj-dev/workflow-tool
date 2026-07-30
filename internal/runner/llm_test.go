package runner

import "testing"

func TestParseLLMLineAssistantText(t *testing.T) {
	// 真实 assistant text 事件（简化）
	line := `{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"OK"}]}}`
	got, ok := parseLLMLine(line)
	if !ok || got != "OK" {
		t.Fatalf("want (OK,true)，got (%q,%v)", got, ok)
	}
}

func TestParseLLMLineAssistantMultipleTextBlocks(t *testing.T) {
	// 多个 text 块拼接
	line := `{"type":"assistant","message":{"content":[{"type":"text","text":"你好"},{"type":"text","text":"世界"}]}}`
	got, ok := parseLLMLine(line)
	if !ok || got != "你好世界" {
		t.Fatalf("want 拼接 你好世界，got (%q,%v)", got, ok)
	}
}

func TestParseLLMLineAssistantThinkingSkipped(t *testing.T) {
	// thinking 块（无 text）应跳过
	line := `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"思考中..."}]}}`
	got, ok := parseLLMLine(line)
	if ok || got != "" {
		t.Fatalf("thinking 行应跳过，got (%q,%v)", got, ok)
	}
}

func TestParseLLMLineSystemSkipped(t *testing.T) {
	line := `{"type":"system","subtype":"thinking_tokens","estimated_tokens":5}`
	got, ok := parseLLMLine(line)
	if ok || got != "" {
		t.Fatalf("system 行应跳过，got (%q,%v)", got, ok)
	}
}

func TestParseLLMLineResultSkipped(t *testing.T) {
	line := `{"type":"result","subtype":"success","result":"OK","duration_ms":8585}`
	got, ok := parseLLMLine(line)
	if ok || got != "" {
		t.Fatalf("result 行应跳过，got (%q,%v)", got, ok)
	}
}

func TestParseLLMLineGarbageSkipped(t *testing.T) {
	// 非 JSON 行（claude 偶发输出）不崩溃、跳过
	got, ok := parseLLMLine("这不是 JSON")
	if ok || got != "" {
		t.Fatalf("非 JSON 行应跳过，got (%q,%v)", got, ok)
	}
}
