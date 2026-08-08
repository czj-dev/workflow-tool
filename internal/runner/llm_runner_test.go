package runner

import (
	"context"
	"runtime"
	"testing"
	"time"
)

func skipLLMWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix 专属 shell 行为")
	}
}

func TestLLMRunner_ParsesAssistantText(t *testing.T) {
	skipLLMWindows(t)
	// 模拟 claude stream-json：一行 assistant text 事件
	line := `{"type":"assistant","message":{"content":[{"type":"text","text":"hello world"}]}}`
	cmdStr := "echo '" + line + "'"
	r := &LLMRunner{Cfg: LLMConfig{Shell: cmdStr, Timeout: 5 * time.Second}}

	var llmEvents []string
	res := r.Run(context.Background(), nil, func(stream, l string) {
		if stream == "llm" {
			llmEvents = append(llmEvents, l)
		}
	})

	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit=%d want 0", res.ExitCode)
	}
	if res.Stdout != "hello world" {
		t.Fatalf("Stdout=%q want %q", res.Stdout, "hello world")
	}
	if len(llmEvents) == 0 || llmEvents[0] != "hello world" {
		t.Fatalf("llm events=%v want [\"hello world\"]", llmEvents)
	}
}

func TestLLMRunner_NonJSONLineSkipped(t *testing.T) {
	skipLLMWindows(t)
	r := &LLMRunner{Cfg: LLMConfig{Shell: "echo 'not json'", Timeout: 5 * time.Second}}
	res := r.Run(context.Background(), nil, func(stream, l string) {})
	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if res.Stdout != "" {
		t.Fatalf("Stdout=%q want empty（非法 JSON 应跳过）", res.Stdout)
	}
}

func TestLLMRunner_StderrEmittedNotCaptured(t *testing.T) {
	skipLLMWindows(t)
	r := &LLMRunner{Cfg: LLMConfig{Shell: "echo 'diagnostic' 1>&2", Timeout: 5 * time.Second}}
	var stderrLines []string
	res := r.Run(context.Background(), nil, func(stream, l string) {
		if stream == "stderr" {
			stderrLines = append(stderrLines, l)
		}
	})
	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if len(stderrLines) != 1 || stderrLines[0] != "diagnostic" {
		t.Fatalf("stderr lines=%v want [\"diagnostic\"]", stderrLines)
	}
	if res.Stderr != "" {
		t.Fatalf("Result.Stderr=%q want empty（stderr 只 emit，不进 Result）", res.Stderr)
	}
}

// TestLLMRunner_StructuredOutputs 验证 session_id/thinking/cost_usd/total_tokens
// 等结构化字段仍被累积进 Result.Outputs（迁移自旧 pumpLLM 测试）。
func TestLLMRunner_StructuredOutputs(t *testing.T) {
	skipLLMWindows(t)
	lines := []string{
		`{"type":"system","subtype":"init","session_id":"sess-abc-123"}`,
		`{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"思考中"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"，世界"}]}}`,
		`{"type":"result","total_cost_usd":0.0123,"usage":{"input_tokens":100,"output_tokens":50}}`,
	}
	cmdStr := ""
	for _, l := range lines {
		cmdStr += "echo '" + l + "'; "
	}
	r := &LLMRunner{Cfg: LLMConfig{Shell: cmdStr, Timeout: 5 * time.Second}}
	res := r.Run(context.Background(), nil, func(string, string) {})

	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if res.Outputs["session_id"] != "sess-abc-123" {
		t.Fatalf("session_id = %q, want sess-abc-123", res.Outputs["session_id"])
	}
	if res.Outputs["text"] != "你好，世界" {
		t.Fatalf("text = %q, want 你好，世界", res.Outputs["text"])
	}
	if res.Outputs["thinking"] != "思考中" {
		t.Fatalf("thinking = %q, want 思考中", res.Outputs["thinking"])
	}
	if res.Outputs["cost_usd"] != "0.0123" {
		t.Fatalf("cost_usd = %q, want 0.0123", res.Outputs["cost_usd"])
	}
	if res.Outputs["total_tokens"] != "150" {
		t.Fatalf("total_tokens = %q, want 150", res.Outputs["total_tokens"])
	}
}
