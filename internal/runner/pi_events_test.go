package runner

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// feedLines 依次喂入若干行（emit 传 nil，只收集不推送）。
func feedLines(p *piEventParser, lines ...string) {
	for _, l := range lines {
		p.feed(l, nil)
	}
}

// 真实事件流回放（阶段 0 用真实端点录制：/tmp/pi-spike/raw.jsonl 迁移而来）。
// 覆盖 session 头、user 回显（块数组形态）、thinking/text 增量与 end 权威块、
// message_end 收口、usage 逐帧刷新（中途 0 帧不能覆盖真实值）。
func TestPiEventParserRealStreamFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/pi_stream.jsonl")
	if err != nil {
		t.Fatalf("读 fixture: %v", err)
	}
	var aiText, aiThink, aiTool []string
	emit := func(stream, line string) {
		switch stream {
		case "ai":
			aiText = append(aiText, line)
		case "ai-thinking":
			aiThink = append(aiThink, line)
		case "ai-tool":
			aiTool = append(aiTool, line)
		default:
			t.Errorf("意外的流类型 %q: %q", stream, line)
		}
	}
	p := newPiEventParser()
	for _, ln := range strings.Split(string(raw), "\n") {
		p.feed(ln, emit)
	}

	outputs := map[string]string{}
	p.writeOutputs(outputs)
	if outputs["session_id"] != "01a21c1f-8456-7696-b1e9-36b0f88eeb77" {
		t.Errorf("session_id = %q", outputs["session_id"])
	}
	// usage 取 message_end 收口的权威值，不是中途的 0 帧
	if outputs["input_tokens"] != "1298" || outputs["output_tokens"] != "36" {
		t.Errorf("分项 tokens = %q / %q", outputs["input_tokens"], outputs["output_tokens"])
	}
	if outputs["total_tokens"] != "1334" {
		t.Errorf("total_tokens = %q", outputs["total_tokens"])
	}
	if outputs["cost_usd"] != "0" {
		t.Errorf("cost_usd = %q（网关不回价是常态，应为 0）", outputs["cost_usd"])
	}

	// 终值：text 为权威块「收到」；thinking 为完整思考块
	if got := p.text(); got != "收到" {
		t.Errorf("text = %q", got)
	}
	if got := p.thinking(); !strings.Contains(got, `My previous reply was "收到"`) {
		t.Errorf("thinking 应为完整块，got %q", got)
	}

	// 流式 emit：增量原样推送
	if got := strings.Join(aiText, ""); got != "收到" {
		t.Errorf("ai 增量拼接 = %q", got)
	}
	if got := strings.Join(aiThink, ""); !strings.Contains(got, "The user is asking") {
		t.Errorf("ai-thinking 增量拼接异常: %q", got)
	}
	if len(aiTool) != 0 {
		t.Errorf("本流无工具调用，却 emit 了 %d 条 ai-tool", len(aiTool))
	}
	if msg, bad := p.streamError(); bad {
		t.Errorf("不应有流内错误: %q", msg)
	}
}

func TestPiEventParserEndReplacesDeltas(t *testing.T) {
	p := newPiEventParser()
	feedLines(p,
		`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"草稿"}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":1,"content":"定稿"}}`,
	)
	if got := p.text(); got != "定稿" {
		t.Fatalf("*_end 权威值应替换 delta 累计，got %q", got)
	}
}

func TestPiEventParserRunTextAcrossMessages(t *testing.T) {
	// 两条 assistant 消息（模拟工具调用回合）：text 跨消息拼接；
	// 第二条只写 contentIndex 0，不能残留第一条的块（thinking idx0 + text idx1）
	p := newPiEventParser()
	feedLines(p,
		`{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"想"}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"A"}}`,
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"想"},{"type":"text","text":"A"}],"stopReason":"stop"}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"B"}}`,
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"B"}],"stopReason":"stop"}}`,
	)
	if got := p.text(); got != "AB" {
		t.Fatalf("run 级拼接 = %q，应为 AB（且不残留上一条的块）", got)
	}
	if got := p.thinking(); got != "想" {
		t.Fatalf("thinking = %q", got)
	}
}

func TestPiEventParserUnsettledKeepsPartialText(t *testing.T) {
	// 流中断（无 message_end）：半截增量计入最终 text，不丢
	p := newPiEventParser()
	feedLines(p,
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"已收口"}],"stopReason":"stop"}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"半截"}}`,
	)
	if got := p.text(); got != "已收口半截" {
		t.Fatalf("流中断不应丢半截增量，got %q", got)
	}
}

func TestPiEventParserSkipsNonAssistantAndStart(t *testing.T) {
	p := newPiEventParser()
	var emitted []string
	emit := func(stream, line string) { emitted = append(emitted, stream) }
	// 阶段 0 实测：system/user 的 content 可能是纯字符串；message_start 是占位
	// （assistant 的 start 也带 stopReason=pending 与 0 帧 usage，不能当真）
	p.feed(`{"type":"message_start","message":{"role":"user","content":"用户原文"}}`, emit)
	p.feed(`{"type":"message_end","message":{"role":"user","content":"用户原文"}}`, emit)
	p.feed(`{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"占位"}],"stopReason":"pending","usage":{"input":0,"output":0,"totalTokens":0,"cost":{"total":0}}}}`, emit)
	if got := p.text(); got != "" {
		t.Errorf("非 assistant 消息 / message_start 不参与重组，got %q", got)
	}
	if _, bad := p.streamError(); bad {
		t.Error("不应误判失败（pending 不是 error）")
	}
	if len(emitted) != 0 {
		t.Errorf("不应有 emit，got %v", emitted)
	}
	outputs := map[string]string{}
	p.writeOutputs(outputs)
	if _, ok := outputs["total_tokens"]; ok {
		t.Error("message_start 的 usage 不应写入 outputs")
	}
	p.writeOutputs(nil) // nil 容器不炸
}

func TestPiEventParserStreamErrorFromStopReason(t *testing.T) {
	// 阶段 0 实测：错误模型 id → pi exit 0 + stopReason=error + errorMessage 透传
	p := newPiEventParser()
	feedLines(p, `{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"503: {\"message\":\"当前分组 default 下对于模型 GLM-5.3-Flash-内部[1m] 无可用渠道\",\"type\":\"one_api_error\"}"}}`)
	msg, bad := p.streamError()
	if !bad {
		t.Fatal("stopReason=error 应判流内失败")
	}
	if !strings.Contains(msg, "无可用渠道") {
		t.Fatalf("errorMessage 应透传，got %q", msg)
	}
}

func TestPiEventParserStreamErrorFallbackText(t *testing.T) {
	p := newPiEventParser()
	feedLines(p,
		`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"报错前的半截"}}`,
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"报错前的半截"}],"stopReason":"error"}}`,
	)
	if msg, _ := p.streamError(); msg != "报错前的半截" {
		t.Fatalf("无 errorMessage 时退回消息文本，got %q", msg)
	}
}

func TestPiEventParserStreamErrorGenericFallback(t *testing.T) {
	p := newPiEventParser()
	feedLines(p, `{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"aborted"}}`)
	if msg, _ := p.streamError(); msg != "assistant message aborted" {
		t.Fatalf("文本与 errorMessage 皆空时的兜底文案，got %q", msg)
	}
}

func TestPiEventParserAborted(t *testing.T) {
	p := newPiEventParser()
	feedLines(p, `{"type":"agent_settled","aborted":false}`)
	if _, bad := p.streamError(); bad {
		t.Fatal("aborted=false 不算失败")
	}

	p2 := newPiEventParser()
	feedLines(p2,
		`{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"先行错误"}}`,
		`{"type":"agent_settled","aborted":true}`,
	)
	if msg, _ := p2.streamError(); msg != "先行错误" {
		t.Fatalf("message_end 的错误优先，agent_settled 不覆盖，got %q", msg)
	}

	p3 := newPiEventParser()
	feedLines(p3, `{"type":"agent_settled","aborted":true}`)
	if msg, bad := p3.streamError(); !bad || msg != "agent aborted" {
		t.Fatalf("中止兜底，got (%q,%v)", msg, bad)
	}
}

func TestPiEventParserToolEvents(t *testing.T) {
	var tools []string
	emit := func(stream, line string) {
		if stream != "ai-tool" {
			t.Errorf("应为 ai-tool 流，got %q", stream)
			return
		}
		tools = append(tools, line)
	}
	p := newPiEventParser()
	feedWithEmit := func(l string) { p.feed(l, emit) }
	feedWithEmit(`{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","contentIndex":0,"toolCall":{"id":"call_1","name":"Read","arguments":{"file_path":"package.json"}}}}`)
	feedWithEmit(`{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","contentIndex":1,"toolCall":{"id":"call_2","name":"Bash","arguments":{}}}}`)
	feedWithEmit(`{"type":"tool_execution_end","toolCallId":"call_1","result":{"content":"1\tname: frontend","isError":false}}`)
	feedWithEmit(`{"type":"tool_execution_end","toolCallId":"call_2","result":{"content":"boom","isError":true}}`)
	// 无 id 的调用与结果跳过（防配对悬挂）
	feedWithEmit(`{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","toolCall":{"name":"NoID"}}}`)
	feedWithEmit(`{"type":"tool_execution_end","result":{"content":"x"}}`)

	if len(tools) != 4 {
		t.Fatalf("应 emit 4 条 ai-tool，got %d: %v", len(tools), tools)
	}
	var call struct {
		ID    string            `json:"id"`
		Name  string            `json:"name"`
		Input map[string]string `json:"input"`
	}
	if err := json.Unmarshal([]byte(tools[0]), &call); err != nil {
		t.Fatalf("tool_use payload 不是合法 JSON: %v", err)
	}
	if call.ID != "call_1" || call.Name != "Read" || call.Input["file_path"] != "package.json" {
		t.Errorf("tool_use 字段: %+v", call)
	}
	var call2 struct {
		ID    string            `json:"id"`
		Name  string            `json:"name"`
		Input map[string]string `json:"input"`
	}
	if err := json.Unmarshal([]byte(tools[1]), &call2); err != nil {
		t.Fatalf("tool_use payload 不是合法 JSON: %v", err)
	}
	if call2.ID != "call_2" || call2.Name != "Bash" || len(call2.Input) != 0 {
		t.Errorf("空 arguments 应透传 {}，got %+v", call2)
	}
	var res struct {
		ID      string          `json:"id"`
		Content json.RawMessage `json:"content"`
		IsError bool            `json:"isError"`
	}
	if err := json.Unmarshal([]byte(tools[2]), &res); err != nil {
		t.Fatalf("tool_result payload 不是合法 JSON: %v", err)
	}
	var content string
	if err := json.Unmarshal(res.Content, &content); err != nil || !strings.Contains(content, "frontend") {
		t.Errorf("content 应为字符串透传，got %s (err=%v)", res.Content, err)
	}
	if res.ID != "call_1" || res.IsError {
		t.Errorf("tool_result 字段: %+v", res)
	}
	if err := json.Unmarshal([]byte(tools[3]), &res); err != nil {
		t.Fatalf("tool_result payload 不是合法 JSON: %v", err)
	}
	if res.ID != "call_2" || !res.IsError {
		t.Errorf("isError 应透传，got %+v", res)
	}
}

func TestPiEventParserUsageFromUpdateOnly(t *testing.T) {
	// 流中断（无 message_end）时 usage 仍取最后见到的 message_update 帧
	p := newPiEventParser()
	feedLines(p,
		`{"type":"message_update","usage":{"input":0,"output":0,"totalTokens":0,"cost":{"total":0}},"assistantMessageEvent":{"type":"thinking_start","contentIndex":0}}`,
		`{"type":"message_update","usage":{"input":11,"output":22,"totalTokens":33,"cost":{"total":0.129653}},"assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"x"}}`,
	)
	outputs := map[string]string{}
	p.writeOutputs(outputs)
	if outputs["input_tokens"] != "11" || outputs["output_tokens"] != "22" || outputs["total_tokens"] != "33" {
		t.Fatalf("tokens = %v", outputs)
	}
	if outputs["cost_usd"] != "0.129653" {
		t.Fatalf("cost_usd = %q", outputs["cost_usd"])
	}
}

func TestPiEventParserSkipsGarbageLines(t *testing.T) {
	p := newPiEventParser()
	emitted := 0
	emit := func(stream, line string) { emitted++ }
	p.feed("", emit)
	p.feed("   ", emit)
	p.feed("不是 JSON", emit)
	p.feed(`{"type":"unknown_event","payload":123}`, emit)
	if emitted != 0 {
		t.Errorf("杂质行不应 emit，got %d", emitted)
	}
	if _, bad := p.streamError(); bad {
		t.Error("杂质行不应误判失败")
	}
}

func TestPiEventParserBlockOrder(t *testing.T) {
	// 块按 contentIndex 排序拼接（与到达顺序无关）
	p := newPiEventParser()
	feedLines(p,
		`{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":1,"content":"B"}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"A"}}`,
	)
	if got := p.text(); got != "AB" {
		t.Fatalf("按 contentIndex 排序拼接，got %q", got)
	}
}
