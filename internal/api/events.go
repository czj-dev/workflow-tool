package api

import (
	"fmt"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"workflow-tool/internal/runner"
)

// 本文件是 action:<id>:* / workflow:<id>:* 事件契约的唯一权威定义：
// 事件名、payload 形状、到达顺序协议（seq 排序 / step 归桶）全部集中在这里，
// 改事件协议只需改本文件（+前端对应处理）。

// actionEvents 封装单个 action 的事件通道（action:<id>:output / action:<id>:done）。
//
// 顺序协议（前端契约）：Wails 的 Event.Emit 每次调用都各自起一个 goroutine 投递
// （application/events.go），事件到达前端的顺序无保证。action 是单一输出桶，
// 每条 output 自带递增 seq，done 事件带 seq+1 延续同一序号空间，前端按 seq 排序
// 还原真实产出顺序——done 若抢跑到还没到达的 output 前面，退出码行会被插错位置。
type actionEvents struct {
	app *application.App
	id  string
	seq atomic.Int64
}

func newActionEvents(app *application.App, id string) *actionEvents {
	return &actionEvents{app: app, id: id}
}

// nextSeq 取下一个事件序号。必须原子：emit 并非总是串行回调——logcat-stream 从
// flush ticker 协程、控制协程（规则拒绝告警）、pidRefresher（包未运行告警）三处
// 并发 emit（internal/adb/logcat/stream.go:90/189/408），后两处在 core.mu 之外。
// 前端 seqGate 依赖 seq 唯一有序来定 logcat-replace 帧与增量帧的先后。
func (e *actionEvents) nextSeq() int64 { return e.seq.Add(1) }

// EmitFunc 返回 runner 用的 emit：每行 output 自带递增 seq。
func (e *actionEvents) EmitFunc() runner.EmitFunc {
	return func(stream, line string) {
		e.app.Event.Emit(eventName(e.id, "output"), map[string]any{
			"stream": stream, "line": line, "seq": e.nextSeq(),
		})
	}
}

// Done 发送结束事件，seq 接续最后一条 output（seq+1），前端按序应用退出码行。
func (e *actionEvents) Done(exitCode int, errMsg string, d time.Duration, readout map[string]any) {
	e.emitDone(exitCode, errMsg, d, readout, e.seq.Load()+1)
}

// DoneUnordered 发送不参与排序的结束事件（payload 不带 seq，前端直接应用）。
// 用于 runner 启动前早退的场景（如工作目录校验失败），此时尚无 output 序号空间。
func (e *actionEvents) DoneUnordered(exitCode int, errMsg string, d time.Duration) {
	e.emitDone(exitCode, errMsg, d, nil, 0)
}

func (e *actionEvents) emitDone(exitCode int, errMsg string, d time.Duration, readout map[string]any, seq int64) {
	payload := map[string]any{
		"exitCode": exitCode,
		"err":      errMsg,
		"duration": d.String(),
	}
	if readout != nil {
		payload["readout"] = readout
	}
	if seq > 0 {
		payload["seq"] = seq
	}
	e.app.Event.Emit(eventName(e.id, "done"), payload)
}

// workflowEvents 封装单个 workflow 的事件通道（workflow:<id>:output / workflow:<id>:done）。
//
// 归桶协议（前端契约）：Emit 到达顺序无保证——push 末尾的 100% progress 会与
// step-done/下一个 step-start 抢跑，输了就被前端折进下一个 step 的输出里。
// 每条 output 事件带 step 归属（当前 step 索引），前端按索引落桶，与到达顺序无关。
//
// 并发安全：curStep 写发生在 executor goroutine 的 step 边界，读发生在 runner 的
// 输出 goroutine；runner.Run 返回前已 join 全部输出 goroutine，故两者有序不重叠。
type workflowEvents struct {
	app     *application.App
	id      string
	curStep string
}

func newWorkflowEvents(app *application.App, id string) *workflowEvents {
	return &workflowEvents{app: app, id: id}
}

// EmitFunc 返回 runner/executor 用的 emit：step-start/step-skip 更新当前 step 归属。
func (e *workflowEvents) EmitFunc() runner.EmitFunc {
	return func(stream, line string) {
		if stream == "step-start" || stream == "step-skip" {
			e.curStep = line
		}
		e.app.Event.Emit(workflowEventName(e.id, "output"), map[string]string{
			"stream": stream, "line": line, "step": e.curStep,
		})
	}
}

// Done 发送 workflow 结束事件（workflow 无 output 排序协议，done 直接应用）。
func (e *workflowEvents) Done(exitCode int, errMsg string, d time.Duration) {
	e.app.Event.Emit(workflowEventName(e.id, "done"), map[string]any{
		"exitCode": exitCode,
		"err":      errMsg,
		"duration": d.String(),
	})
}

func eventName(id, suffix string) string {
	return fmt.Sprintf("action:%s:%s", id, suffix)
}

func workflowEventName(id, suffix string) string {
	return fmt.Sprintf("workflow:%s:%s", id, suffix)
}

func errStr(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// llmReadout 从 LLM Result.Outputs 挑出终点读数字段（数值化）与会话 id；无可读字段时返回 nil。
// cost/tokens 来自 stream-json 的 result 事件（runner.recordStructuredFields 写入 Outputs），
// duration 用后端精确计时；读数行随 done 事件下发（聊天页终点展示）。
// sessionId 单独也撑起 readout：失败/超时杀进程时 result 事件不会到达（无 cost/tokens），
// 但 system/init 的 session_id 已写入——此刻恰恰是用户最需要会话 id（查现场/--resume）的时候。
func llmReadout(outputs map[string]string, d time.Duration) map[string]any {
	r := map[string]any{"durationMs": d.Milliseconds()}
	// 会话 id（system/init 事件由 runner.recordStructuredFields 写入）：聊天页历史查看态顶部展示
	if sid := outputs["session_id"]; sid != "" {
		r["sessionId"] = sid
	}
	if v, err := strconv.ParseFloat(outputs["cost_usd"], 64); err == nil {
		r["costUsd"] = v
	}
	in, errIn := strconv.Atoi(outputs["input_tokens"])
	out, errOut := strconv.Atoi(outputs["output_tokens"])
	if errIn == nil && errOut == nil {
		r["inputTokens"] = in
		r["outputTokens"] = out
	}
	// 仅当既无成本读数也无会话 id 时才视为无可读字段（durationMs 单独不算，
	// done 事件 payload 本身已带 duration 字符串）。
	if _, ok := r["sessionId"]; !ok {
		if _, ok := r["costUsd"]; !ok {
			if _, ok := r["inputTokens"]; !ok {
				return nil
			}
		}
	}
	return r
}
