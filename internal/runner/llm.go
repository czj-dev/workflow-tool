package runner

import (
	"encoding/json"
	"fmt"
	"strings"
)

// llmStreamEvent 是 claude stream-json 一行事件的通用结构（只取关心字段）。
type llmStreamEvent struct {
	Type      string `json:"type"`
	SessionID string `json:"session_id"`
	Message   struct {
		Content []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Thinking string `json:"thinking"`
		} `json:"content"`
	} `json:"message"`
	TotalCostUSD float64 `json:"total_cost_usd"`
	Usage        struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
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

// recordStructuredFields 解析 system/init 的 session_id 与 result 的 cost/tokens，写入 outputs。
// outputs 为 nil 时跳过。
func recordStructuredFields(line string, outputs map[string]string) {
	if outputs == nil {
		return
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	var ev llmStreamEvent
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		return
	}
	if ev.SessionID != "" {
		outputs["session_id"] = ev.SessionID
	}
	if ev.Type == "result" {
		outputs["cost_usd"] = fmt.Sprint(ev.TotalCostUSD)
		outputs["total_tokens"] = fmt.Sprint(ev.Usage.InputTokens + ev.Usage.OutputTokens)
	}
}
