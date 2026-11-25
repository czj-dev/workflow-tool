package runstore

import (
	"sync/atomic"
	"time"
)

// LogEmitter 把一次运行的输出整理成运行日志行。它给出的 payload 是运行日志与前端事件的
// **共同契约**——每条先落进运行日志（Sink），调用方再把同一个对象推给前端：
//
//	output  {stream, line, seq}          工作流另带 step（步骤归属）
//	done    {exitCode, err, duration, readout?}   动作与 AI 任务另带 seq
//
// 应用内的运行经 api 的事件封装落盘后推送；执行器的运行只有落盘。两边写出的日志同构，
// 运行详情用同一份归约器回放。
//
// 顺序协议：每条 output 自带递增 seq，done 若取号则**独占**一个号（output 号段里留下
// 一个永久的洞）。取号不受 Sink 是否在场影响。
type LogEmitter struct {
	// Sink 是本次运行的记录会话；nil（运行记录不可用）时落盘为空操作。
	Sink *Session
	// Workflow 为 true 时每条 output 带当前步骤归属（见 Output）。
	Workflow bool

	// curStep 是当前的步骤归属；写发生在 executor 的 step 边界，读发生在 runner 的输出
	// 协程，runner.Run 返回前已 join 全部输出协程，二者有序不重叠。
	curStep string
	seq     atomic.Int64
}

func NewLogEmitter(workflow bool) *LogEmitter {
	return &LogEmitter{Workflow: workflow}
}

// Output 落一条 output 并返回它的 payload。
// stream 契约：stdout/stderr=文本行；progress=单行进度；ai/ai-thinking/ai-tool=AI 回复增量/
// 思考增量/工具调用对；tree=树帧；工作流另有 step-start/step-skip/step-done 等步骤帧——
// step-start / step-skip 把 line 记为当前步骤，之后的输出都归属它。
func (e *LogEmitter) Output(stream, line string) map[string]any {
	if e.Workflow && (stream == "step-start" || stream == "step-skip") {
		e.curStep = line
	}
	payload := map[string]any{"stream": stream, "line": line, "seq": e.seq.Add(1)}
	if e.Workflow {
		payload["step"] = e.curStep
	}
	e.Sink.Output(payload)
	return payload
}

// Done 落一条 done 事件并返回它的 payload。takeSeq 为 true 时独占一个序号：取号必须独占——
// logcat-stream 的控制协程与 pidRefresher 未被 join，其告警/重放帧可能在 Done 之后才 emit，
// 若 Done 只读不占号，那条迟到 emit 会拿到同一个号（消费侧的 seq 帧门依赖 seq 唯一）。
// readout 为 nil 时不带该字段。
func (e *LogEmitter) Done(exitCode int, errMsg string, d time.Duration, readout map[string]any, takeSeq bool) map[string]any {
	payload := map[string]any{"exitCode": exitCode, "err": errMsg, "duration": d.String()}
	if readout != nil {
		payload["readout"] = readout
	}
	if takeSeq {
		payload["seq"] = e.seq.Add(1)
	}
	e.Sink.Done(payload)
	return payload
}
