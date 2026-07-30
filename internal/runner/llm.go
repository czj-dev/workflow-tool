package runner

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
)

// llmStreamEvent 是 claude stream-json 一行事件的通用结构（只取关心字段）。
type llmStreamEvent struct {
	Type    string `json:"type"`
	Message struct {
		Content []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Thinking string `json:"thinking"`
		} `json:"content"`
	} `json:"message"`
}

// parseLLMLine 解析 claude stream-json 的一行，提取 assistant 的 text 或 thinking 增量。
// 返回 (kind, delta, true)：kind 为 "text"（回复）或 "thinking"（思考过程）；
// 返回 ok=false 表示该行无内容（system/result/无法解析/tool_use），应跳过。
// 同一事件同时含 text 与 thinking 时优先返回 text（claude 通常分行输出，罕见同事件混存）。
func parseLLMLine(line string) (kind string, delta string, ok bool) {
	line = strings.TrimSpace(line)
	if line == "" {
		return "", "", false
	}
	var ev llmStreamEvent
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		return "", "", false // 无法解析，跳过（不污染 LLM 输出）
	}
	if ev.Type != "assistant" {
		return "", "", false // system/result 等跳过
	}
	var text, thinking strings.Builder
	for _, c := range ev.Message.Content {
		switch c.Type {
		case "text":
			text.WriteString(c.Text)
		case "thinking":
			thinking.WriteString(c.Thinking)
		}
	}
	if text.Len() > 0 {
		return "text", text.String(), true
	}
	if thinking.Len() > 0 {
		return "thinking", thinking.String(), true
	}
	return "", "", false // assistant 但无可显示块（如纯 tool_use）
}

// pumpLLM 逐行读取 r，按 stream-json 解析，把 assistant text/thinking 增量 emit。
// text → emit("llm", delta)；thinking → emit("llm-thinking", delta)。
func pumpLLM(r io.Reader, emit EmitFunc, done chan<- struct{}) {
	defer close(done)
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		kind, delta, ok := parseLLMLine(sc.Text())
		if !ok {
			continue
		}
		if kind == "thinking" {
			emit("llm-thinking", delta)
		} else {
			emit("llm", delta)
		}
	}
}
