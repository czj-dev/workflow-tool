package api

import (
	"fmt"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"workflow-tool/internal/runner"
	"workflow-tool/internal/runstore"
	"workflow-tool/internal/target"
)

// 本文件是 action:<id>:* / ai:<id>:* / workflow:<id>:* 事件契约的唯一权威定义：
// 事件名、到达顺序协议（seq 排序 / step 归桶）全部集中在这里，改事件协议只需改本文件
// （+前端对应处理）。payload 的形状与取号在 runstore.LogEmitter——它与运行日志同构，
// 执行器的运行没有前端，只有落盘那一份。emit 与落盘是同一个 payload，所以运行详情
// 回放看到的与前端当时收到的事件一致。

// actionEvents 封装单个目标（action 或 AI 任务）的事件通道
// （<prefix>:<id>:output / <prefix>:<id>:done），prefix 为 action 或 ai。
//
// 顺序协议（前端契约）：Wails 的 Event.Emit 每次调用都各自起一个 goroutine 投递
// （application/events.go），事件到达前端的顺序无保证。action 是单一输出桶，
// 每条 output 自带递增 seq，前端按 seq 排序还原真实产出顺序——done 若抢跑到还没
// 到达的 output 前面，退出码行会被插错位置。
//
// 序号只保证「唯一递增」，不保证「output 号段连续」：done 事件独占一个号（见 Done），
// 该号在 output 号段里就是一个永久空洞。消费侧义务：
//   - 严格逐号 drain 的队列必须把 done 的号登记为已消耗并跨过，否则 done 之后到达的
//     迟到 emit 全部卡死在洞后面（前端 ActionRunnerProvider 的 seqGate consumed 集合）。
//   - 序号是「每次 run 一个实例」的，run 中途重置消费侧队列不能打回 1（后端序号已到
//     几千），必须以首个到达的 seq 为基线重新对齐。
type actionEvents struct {
	app    *application.App
	prefix string // "action" | "ai"
	id     string
	// LogEmitter 构造 payload、取号并落运行日志（Sink 是本次运行的记录会话；nil 时落盘
	// 为空操作）。本类型只负责把同一个 payload 推给前端。
	*runstore.LogEmitter
}

func newActionEvents(app *application.App, id string) *actionEvents {
	return &actionEvents{app: app, prefix: "action", id: id, LogEmitter: runstore.NewLogEmitter(false)}
}

// newAiEvents 封装单个 AI 任务的事件通道（ai:<id>:output / ai:<id>:done）：payload 形状与
// 排序协议和 action:<id>:* 完全相同。workflow 里的 AI 步骤不用它——输出带步骤归属落在
// workflow:<wf-id>:output 上。
func newAiEvents(app *application.App, id string) *actionEvents {
	return &actionEvents{app: app, prefix: "ai", id: id, LogEmitter: runstore.NewLogEmitter(false)}
}

// name 返回该通道某类事件的事件名。
func (e *actionEvents) name(suffix string) string {
	return eventName(e.prefix, e.id, suffix)
}

// EmitFunc 返回 runner 用的 emit：每行 output 自带递增 seq。
// stream 契约：stdout/stderr=文本行；progress=单行进度（前端原地覆盖上一条）；
// ai/ai-thinking/ai-tool=AI 回复增量/思考增量/工具调用对（前两者 line 为增量文本，
// ai-tool 为 JSON 原文）；
// tree=树帧（line=树 JSON 原文，前端 JSON.parse 后原地渲染内联树块；Go 域经
// adb.OpContext.EmitTree 直发，script 动作经 runner.parseTreeLine 的 ##[tree ...]
// 协议行转入同一流）。
// 取号不受 app 是否在场影响：headless 运行没有前端，运行日志仍要与有前端时同构。
func (e *actionEvents) EmitFunc() runner.EmitFunc {
	return func(stream, line string) {
		e.emit(e.name("output"), e.Output(stream, line))
	}
}

// Done 发送结束事件，seq **独占**一个号。代价是 output 号段从此有一个洞：消费侧必须
// 跨过这个号才能继续出队（见 actionEvents 的顺序协议）。前端按序把退出码行落在所有
// output 行之后。为何必须独占见 runstore.LogEmitter.Done。
func (e *actionEvents) Done(exitCode int, errMsg string, d time.Duration, readout map[string]any) {
	e.emit(e.name("done"), e.LogEmitter.Done(exitCode, errMsg, d, readout, true))
}

// DoneUnordered 发送不参与排序的结束事件（payload 不带 seq，前端直接应用）。
// 用于 runner 启动前早退的场景（如工作目录校验失败），此时尚无 output 序号空间。
func (e *actionEvents) DoneUnordered(exitCode int, errMsg string, d time.Duration) {
	e.emit(e.name("done"), e.LogEmitter.Done(exitCode, errMsg, d, nil, false))
}

// emit 推送一个事件；没有前端（headless / 测试）时空操作——落盘已在 LogEmitter 里完成。
func (e *actionEvents) emit(name string, payload map[string]any) {
	if e.app == nil || e.app.Event == nil {
		return
	}
	e.app.Event.Emit(name, payload)
}

// workflowEvents 封装单个 workflow 的事件通道（workflow:<id>:output / workflow:<id>:done）。
//
// 归桶协议（前端契约）：Emit 到达顺序无保证——push 末尾的 100% progress 会与
// step-done/下一个 step-start 抢跑，输了就被前端折进下一个 step 的输出里。
// 每条 output 事件带 step 归属（当前 step 索引），前端按索引落桶，与到达顺序无关。
// 前端的实时归约只按 step 落桶、不依赖 seq；seq（每次运行从 1 递增，done 不取号）
// 供运行日志回放与「运行中的记录」的详情跟踪排序、去重——与 action / ai 事件同一契约。
//
// 并发安全：curStep 写发生在 executor goroutine 的 step 边界，读发生在 runner 的
// 输出 goroutine；runner.Run 返回前已 join 全部输出 goroutine，故两者有序不重叠。
// 取号是原子的：executor 的 step 边界与 runner 的输出协程都会 emit。
type workflowEvents struct {
	app *application.App
	id  string
	// LogEmitter 构造 payload（带步骤归属）、取号并落运行日志；Sink 的 nil 安全同 actionEvents。
	*runstore.LogEmitter
}

func newWorkflowEvents(app *application.App, id string) *workflowEvents {
	return &workflowEvents{app: app, id: id, LogEmitter: runstore.NewLogEmitter(true)}
}

// EmitFunc 返回 runner/executor 用的 emit。
func (e *workflowEvents) EmitFunc() runner.EmitFunc {
	return func(stream, line string) {
		payload := e.Output(stream, line)
		if e.app == nil || e.app.Event == nil {
			return
		}
		e.app.Event.Emit(workflowEventName(e.id, "output"), payload)
	}
}

// Done 发送 workflow 结束事件。done 不取号、不参与排序：前端与回放都直接应用。
func (e *workflowEvents) Done(exitCode int, errMsg string, d time.Duration) {
	payload := e.LogEmitter.Done(exitCode, errMsg, d, nil, false)
	if e.app == nil || e.app.Event == nil {
		return
	}
	e.app.Event.Emit(workflowEventName(e.id, "done"), payload)
}

// 应用级失效通知：payload 只作「有变化」的信号，前端收到后重新向后端取列表，
// 不维护第二份 DTO 状态。
const (
	// eventSchedulesChanged：调度增删改、启停、运行开始/结束/启动失败。
	eventSchedulesChanged = "schedules:changed"
	// eventRunsChanged：一条运行记录被创建或写终态。
	// payload 见 runsChangedPayload。
	eventRunsChanged = "runs:changed"
)

// runsChangedPayload 是 runs:changed 的 payload（唯一权威定义）：{run_id, status,
// target_kind, target_id}。带上目标，订阅方不必重拉就知道是哪个目标在变。
func runsChangedPayload(runID, status string, kind target.Kind, id string) map[string]any {
	return map[string]any{"run_id": runID, "status": status, "target_kind": string(kind), "target_id": id}
}

// eventName 拼目标事件名：<prefix>:<id>:<suffix>。
func eventName(prefix, id, suffix string) string {
	return fmt.Sprintf("%s:%s:%s", prefix, id, suffix)
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
