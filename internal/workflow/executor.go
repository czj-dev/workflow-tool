// internal/workflow/executor.go
package workflow

import (
	"context"
	"fmt"
	"time"

	"workflow-tool/internal/runner"
)

// ActionRunFunc 执行已有 action（api 层负责查 registry + 合并 params + 构造 ShellRunner）。
type ActionRunFunc func(actionID string, params map[string]any, emit runner.EmitFunc) runner.Result

// ShellRunFunc 执行 inline shell（api 层负责构造 ShellRunner）。
type ShellRunFunc func(shell, timeout string, emit runner.EmitFunc) runner.Result

// Executor 按顺序执行 workflow 的 steps。
type Executor struct{}

// Execute 串行执行 wf 的每个 step，支持 retry 和 continue_on_error。
func (e *Executor) Execute(
	ctx context.Context,
	wf LoadedWorkflow,
	actionRun ActionRunFunc,
	shellRun ShellRunFunc,
	emit runner.EmitFunc,
) runner.Result {
	start := time.Now()
	for i, step := range wf.Def.Steps {
		emit("step-start", fmt.Sprintf("%d", i))

		res := e.runStep(ctx, step, actionRun, shellRun, emit)

		emit("step-done", fmt.Sprintf("%d:%d", i, res.ExitCode))

		if res.ExitCode != 0 {
			if step.ContinueOnError {
				emit("stderr", "continue_on_error: 跳过失败继续")
				continue
			}
			res.Duration = time.Since(start)
			return res
		}
	}
	return runner.Result{ExitCode: 0, Duration: time.Since(start)}
}

// runStep 执行单个 step，含 retry 逻辑。
func (e *Executor) runStep(
	ctx context.Context,
	step Step,
	actionRun ActionRunFunc,
	shellRun ShellRunFunc,
	emit runner.EmitFunc,
) runner.Result {
	res := e.dispatch(ctx, step, actionRun, shellRun, emit)
	if res.ExitCode == 0 || step.Retry <= 0 {
		return res
	}
	for attempt := 1; attempt <= step.Retry; attempt++ {
		emit("stdout", fmt.Sprintf("retry %d/%d", attempt, step.Retry))
		res = e.dispatch(ctx, step, actionRun, shellRun, emit)
		if res.ExitCode == 0 {
			return res
		}
	}
	return res
}

// dispatch 根据 step kind 分发一次执行。
func (e *Executor) dispatch(
	ctx context.Context,
	step Step,
	actionRun ActionRunFunc,
	shellRun ShellRunFunc,
	emit runner.EmitFunc,
) runner.Result {
	switch {
	case step.Sleep > 0:
		return (&runner.SleepRunner{Seconds: step.Sleep}).Run(ctx, nil, emit)
	case step.Action != "":
		return actionRun(step.Action, toAnyMap(step.Params), emit)
	case step.Shell != "":
		return shellRun(step.Shell, step.Timeout, emit)
	default:
		return runner.Result{ExitCode: -1, Err: fmt.Errorf("step 无有效 kind")}
	}
}

// toAnyMap 将 map[string]string 转为 map[string]any。
func toAnyMap(m map[string]string) map[string]any {
	if m == nil {
		return nil
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
