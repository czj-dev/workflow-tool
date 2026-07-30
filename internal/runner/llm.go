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
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	} `json:"message"`
}

// parseLLMLine 解析 claude stream-json 的一行，提取 assistant 的 text 增量。
// 返回 (delta, true) 表示有文本要显示；(false) 表示该行无 text（system/thinking/result/无法解析），应跳过。
func parseLLMLine(line string) (string, bool) {
	line = strings.TrimSpace(line)
	if line == "" {
		return "", false
	}
	var ev llmStreamEvent
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		return "", false // 无法解析，跳过（不污染 LLM 输出）
	}
	if ev.Type != "assistant" {
		return "", false // system/result 等跳过
	}
	var sb strings.Builder
	for _, c := range ev.Message.Content {
		if c.Type == "text" {
			sb.WriteString(c.Text)
		}
	}
	if sb.Len() == 0 {
		return "", false // assistant 但只有 thinking 块
	}
	return sb.String(), true
}

// pumpLLM 逐行读取 r，按 stream-json 解析，把 assistant text 增量 emit("llm", delta)。
func pumpLLM(r io.Reader, emit EmitFunc, done chan<- struct{}) {
	defer close(done)
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		if delta, ok := parseLLMLine(sc.Text()); ok {
			emit("llm", delta)
		}
	}
}
