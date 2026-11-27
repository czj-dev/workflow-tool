package runner

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// pi 事件流解析（设计 §2，阶段 0 原型 /tmp/pi-spike 用真实端点验证后移植）。
//
// pi --mode json 的 stdout 是逐行 JSONL 事件：session / agent_start / turn_start /
// message_start / message_update / message_end / turn_end / agent_end /
// agent_settled / tool_execution_end。本文件是纯解析层：不 spawn 进程、不做 I/O，
// 由 AIRunner 把 stdout 逐行喂进来（ai_runner.go）。真实事件流样本在
// testdata/pi_stream.jsonl。emit 契约与前端 reduceStream.parseToolEvent /
// OutputEventData 的流联合类型对齐（前端零改动）：
//   - assistant 文本增量 → emit("ai", delta)
//   - assistant 思考增量 → emit("ai-thinking", delta)
//   - 工具调用与结果     → emit("ai-tool", payload JSON，见 emitToolCall/emitToolResult)
//
// 重组规则（阶段 0 实测，区别于 CC stream-json）：
//   - 只有 role=="assistant" 的消息参与重组与失败判定；system/user 的
//     message_start/message_end 是回显，content 还可能是纯字符串（非块数组）。
//   - message_update 的 *_delta 按 contentIndex 增量累加；*_end 携带权威整块。
//   - message_end 的 content 是本条消息的权威块数组：把 text/thinking 累入 run 级
//     输出（跨多条 assistant 消息拼接，最终成为 Result.Stdout / outputs["text"]）
//     后清空当前消息的增量缓冲——下一条消息可能只写部分 contentIndex，不清会
//     残留上一条的块造成重复拼接。
//   - usage 逐帧刷新、message_end 收口，最后见到的为准。
//   - stopReason=="error"/"aborted"（或 agent_settled.aborted==true）是「流内失败」：
//     pi 进程此时通常仍 exit 0（阶段 0 实测：错误模型 id → pi exit 0 + 流内 error），
//     runner 层必须据此单独判失败（设计 §3）。

// ---- pi JSONL 事件结构（文档化子集：只声明关心的字段，未知字段忽略）----

// piUsage 是 usage 对象：message_update 逐帧刷新、message_end 收口权威值。
type piUsage struct {
	Input       int64 `json:"input"`
	Output      int64 `json:"output"`
	TotalTokens int64 `json:"totalTokens"`
	Cost        struct {
		Total float64 `json:"total"`
	} `json:"cost"`
}

// piToolCall 是 toolcall_end 事件携带的工具调用（arguments 原样透传不拆）。
type piToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

// piMessageEvent 是 message_update 的 assistantMessageEvent：流式增量。
type piMessageEvent struct {
	Type         string      `json:"type"` // text_delta / text_end / thinking_delta / thinking_end / toolcall_end / *_start
	ContentIndex int         `json:"contentIndex"`
	Delta        string      `json:"delta"`
	Content      string      `json:"content"`
	ToolCall     *piToolCall `json:"toolCall"`
}

// piContentBlock 是 message.content 块数组里的块（text / thinking / toolCall …）。
type piContentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

// piMessage 是 message_start / message_end 携带的消息。assistant 的 content 是块
// 数组；system/user 的 content 可能是纯字符串，故用 RawMessage 承接、解析时探测。
type piMessage struct {
	Role         string          `json:"role"`
	Content      json.RawMessage `json:"content"`
	StopReason   string          `json:"stopReason"`
	ErrorMessage string          `json:"errorMessage"`
	Usage        *piUsage        `json:"usage"`
}

// piToolResult 是 tool_execution_end 的 result（content 为字符串或块数组，原样透传）。
type piToolResult struct {
	Content json.RawMessage `json:"content"`
	IsError bool            `json:"isError"`
}

// piLine 是一行 JSONL 事件：所有事件类型复用同一结构，未出现的字段为零值，
// 按 type 分派；要关心新字段时在此追加。
type piLine struct {
	Type string `json:"type"`
	// session 头
	ID string `json:"id"`
	// message_update
	Usage             *piUsage        `json:"usage"`
	AssistantMsgEvent *piMessageEvent `json:"assistantMessageEvent"`
	// message_end
	Message *piMessage `json:"message"`
	// agent_settled
	Aborted *bool `json:"aborted"`
	// tool_execution_end
	ToolCallID string        `json:"toolCallId"`
	Result     *piToolResult `json:"result"`
}

// piEventParser 是一次 pi 运行的重组状态机（阶段 0 原型 state.feed 的 runner 形态）。
type piEventParser struct {
	sessionID string
	// 当前消息的增量缓冲：contentIndex → 已累计文本。消息收口（assistant
	// message_end）后清空、inflight=false；流中断时半截增量计入最终 text/thinking。
	textBlocks  map[int]string
	thinkBlocks map[int]string
	inflight    bool
	runText     strings.Builder // 跨多条 assistant 消息累计，最终即 Result.Stdout
	runThinking strings.Builder
	usage       *piUsage
	streamErr   string
	hasErr      bool
}

func newPiEventParser() *piEventParser {
	return &piEventParser{
		textBlocks:  map[int]string{},
		thinkBlocks: map[int]string{},
	}
}

// feed 喂入一行 stdout 原文：解析、重组，并把可流式展示的增量经 emit 推出
// （emit 可为 nil，只收集不推送）。空行/非 JSON 行跳过不报错（CLI 偶发杂质
// 输出不污染 AI 输出）。
func (p *piEventParser) feed(raw string, emit EmitFunc) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return
	}
	var l piLine
	if err := json.Unmarshal([]byte(raw), &l); err != nil {
		return
	}
	switch l.Type {
	case "session":
		p.sessionID = l.ID
	case "message_update":
		if l.Usage != nil {
			p.usage = l.Usage
		}
		if l.AssistantMsgEvent != nil {
			p.feedMessageEvent(l.AssistantMsgEvent, emit)
		}
	case "message_end":
		p.feedMessageEnd(l.Message)
	case "tool_execution_end":
		p.emitToolResult(l.ToolCallID, l.Result, emit)
	case "agent_settled":
		// agent 中止：pi 仍 exit 0 的另一条流内失败路径；已有更早的错误时不覆盖
		if l.Aborted != nil && *l.Aborted && !p.hasErr {
			p.setStreamError("agent aborted")
		}
	}
}

func (p *piEventParser) feedMessageEvent(ev *piMessageEvent, emit EmitFunc) {
	switch ev.Type {
	case "text_delta":
		p.textBlocks[ev.ContentIndex] += ev.Delta
		p.inflight = true
		if emit != nil && ev.Delta != "" {
			emit("ai", ev.Delta)
		}
	case "thinking_delta":
		p.thinkBlocks[ev.ContentIndex] += ev.Delta
		p.inflight = true
		if emit != nil && ev.Delta != "" {
			emit("ai-thinking", ev.Delta)
		}
	case "text_end":
		// 权威整块替换本 index 的累计值（delta 流可能缺席或与之重复）
		p.textBlocks[ev.ContentIndex] = ev.Content
		p.inflight = true
	case "thinking_end":
		p.thinkBlocks[ev.ContentIndex] = ev.Content
		p.inflight = true
	case "toolcall_end":
		if ev.ToolCall != nil && ev.ToolCall.ID != "" {
			p.emitToolCall(ev.ToolCall, emit)
		}
	}
}

func (p *piEventParser) feedMessageEnd(m *piMessage) {
	if m == nil {
		return
	}
	if m.Usage != nil {
		p.usage = m.Usage
	}
	if m.Role != "assistant" {
		return // system/user 回显：不参与重组与失败判定
	}
	// 本条消息文本：优先 message_end 的权威块数组；content 非块数组（assistant 下
	// 罕见）时退回已累计的增量
	msgText := p.currentText()
	if blocks, err := parsePiBlocks(m.Content); err == nil {
		tb, kb := map[int]string{}, map[int]string{}
		for i, b := range blocks {
			switch b.Type {
			case "text":
				tb[i] = b.Text
			case "thinking":
				kb[i] = b.Thinking
			}
		}
		msgText = joinPiBlocks(tb)
		p.runText.WriteString(msgText)
		p.runThinking.WriteString(joinPiBlocks(kb))
		// 收口：清空当前消息的增量缓冲，见文件头重组规则
		p.textBlocks, p.thinkBlocks, p.inflight = map[int]string{}, map[int]string{}, false
	}
	if m.StopReason == "error" || m.StopReason == "aborted" {
		msg := m.ErrorMessage
		if msg == "" {
			msg = msgText
		}
		if msg == "" {
			msg = "assistant message " + m.StopReason
		}
		p.setStreamError(msg)
	}
}

// emitToolCall 推送工具调用：payload 形如 {"id","name","input"}，前端
// reduceStream.parseToolEvent 靠 id+name 识别 tool_use。arguments 原样透传，
// 空时补 {}。
func (p *piEventParser) emitToolCall(tc *piToolCall, emit EmitFunc) {
	if emit == nil {
		return
	}
	input := tc.Arguments
	if len(input) == 0 {
		input = json.RawMessage("{}")
	}
	b, err := json.Marshal(map[string]any{"id": tc.ID, "name": tc.Name, "input": input})
	if err != nil {
		return
	}
	emit("ai-tool", string(b))
}

// emitToolResult 推送工具结果：payload 形如 {"id","content","isError"}。
// content 原样透传（字符串或块数组，前端 extractContent 兼容两种）；无 id 时
// 跳过（防配对悬挂）。
func (p *piEventParser) emitToolResult(id string, res *piToolResult, emit EmitFunc) {
	if emit == nil || id == "" {
		return
	}
	var content json.RawMessage
	isErr := false
	if res != nil {
		content = res.Content
		isErr = res.IsError
	}
	b, err := json.Marshal(map[string]any{"id": id, "content": content, "isError": isErr})
	if err != nil {
		return
	}
	emit("ai-tool", string(b))
}

// streamError 返回流内失败。runner 据此把 exit 0 的失败映射为 Result{ExitCode:-1}。
func (p *piEventParser) streamError() (string, bool) {
	return p.streamErr, p.hasErr
}

// text 返回 run 级累计的 assistant 文本（跨多条消息拼接）。最后一条消息未收口
// （流中断/超时被杀）时把已累计的半截增量一并计入，不丢输出。
func (p *piEventParser) text() string {
	s := p.runText.String()
	if p.inflight {
		s += p.currentText()
	}
	return s
}

// thinking 同理。
func (p *piEventParser) thinking() string {
	s := p.runThinking.String()
	if p.inflight {
		s += joinPiBlocks(p.thinkBlocks)
	}
	return s
}

func (p *piEventParser) currentText() string { return joinPiBlocks(p.textBlocks) }

// writeOutputs 把结构化字段写进 outputs（键名即前端终点读数与 airun.Readout
// 读的契约）：session_id、cost_usd、total_tokens、input_tokens、output_tokens。
// outputs 为 nil 时跳过。
func (p *piEventParser) writeOutputs(outputs map[string]string) {
	if outputs == nil {
		return
	}
	if p.sessionID != "" {
		outputs["session_id"] = p.sessionID
	}
	if u := p.usage; u != nil {
		outputs["cost_usd"] = fmt.Sprint(u.Cost.Total)
		outputs["total_tokens"] = fmt.Sprint(u.TotalTokens)
		outputs["input_tokens"] = fmt.Sprint(u.Input)
		outputs["output_tokens"] = fmt.Sprint(u.Output)
	}
}

func (p *piEventParser) setStreamError(msg string) {
	p.streamErr, p.hasErr = msg, true
}

// parsePiBlocks 解析 message.content：assistant 为块数组；system/user 可能是纯
// 字符串（阶段 0 实测），非数组返回错误由调用方跳过。
func parsePiBlocks(raw json.RawMessage) ([]piContentBlock, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if raw[0] != '[' {
		return nil, fmt.Errorf("pi content is not a block array")
	}
	var blocks []piContentBlock
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return nil, err
	}
	return blocks, nil
}

// joinPiBlocks 把 {index: 文本} 按块序拼接（contentIndex 顺序即输出顺序）。
func joinPiBlocks(m map[int]string) string {
	if len(m) == 0 {
		return ""
	}
	idx := make([]int, 0, len(m))
	for k := range m {
		idx = append(idx, k)
	}
	sort.Ints(idx)
	var b strings.Builder
	for _, i := range idx {
		b.WriteString(m[i])
	}
	return b.String()
}
