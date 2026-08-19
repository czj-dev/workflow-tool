// internal/workflow/executor.go
package workflow

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"workflow-tool/internal/runner"
)

// ActionRequest 是 executor 对单个 action step 的执行请求。
type ActionRequest struct {
	Ctx           context.Context
	ActionID      string
	Params        map[string]any    // step.params（已 ${{ }} 替换；剩余 ${VAR} 由回调方用变量源展开）
	Env           map[string]string // workflow+step env（已展开），覆盖 action 定义同名 env
	CaptureOutput *bool             // step 显式覆盖 action 的 capture_output；nil=用 action 定义
	Emit          runner.EmitFunc
}

// ActionRunFunc 执行已有 action。
type ActionRunFunc func(ActionRequest) runner.Result

// ShellRequest 是 executor 对单个 inline shell step 的执行请求。
type ShellRequest struct {
	Ctx           context.Context
	Shell         string // 已 ${{ }} 替换
	Timeout       string // 原始字符串，回调方解析（缺省 60s）
	Env           map[string]string
	CaptureOutput *bool
	Params        map[string]any // 变量源（=StepCtx.Params）
	Emit          runner.EmitFunc
}

// ShellRunFunc 执行 inline shell step。
type ShellRunFunc func(ShellRequest) runner.Result

// Executor 按顺序执行 workflow 的 steps。
type Executor struct{}

// Execute 串行执行 wf 的每个 step。
// baseParams 是 config.yaml 合并 workflow 表单参数的结果（api 层构造）。
func (e *Executor) Execute(
	ctx context.Context,
	wf LoadedWorkflow,
	actionRun ActionRunFunc,
	shellRun ShellRunFunc,
	baseParams map[string]any,
	emit runner.EmitFunc,
) runner.Result {
	start := time.Now()
	stepCtx := &StepContext{
		Steps:  map[string]StepOutput{},
		Env:    resolveEnv(wf.Def.Env, baseParams),
		Params: baseParams,
	}

	for i, step := range wf.Def.Steps {
		key := stepKey(step, i)

		// if 求值
		shouldRun, err := EvalCondition(step.If, stepCtx)
		if err != nil {
			emit("stderr", err.Error())
			return runner.Result{ExitCode: -1, Err: err, Duration: time.Since(start)}
		}
		if !shouldRun {
			emit("step-skip", fmt.Sprintf("%d", i))
			stepCtx.Steps[key] = StepOutput{Outputs: map[string]string{
				"exit_code": "-1", "success": "false", "skipped": "true",
			}}
			continue
		}

		emit("step-start", fmt.Sprintf("%d", i))
		res := e.runStep(ctx, step, actionRun, shellRun, stepCtx, emit)
		emit("step-done", fmt.Sprintf("%d:%d", i, res.ExitCode))

		// 累积 outputs
		if res.Outputs == nil {
			res.Outputs = map[string]string{
				"exit_code": strconv.Itoa(res.ExitCode),
				"success":   fmt.Sprint(res.ExitCode == 0),
			}
		}
		stepCtx.Steps[key] = StepOutput{Outputs: res.Outputs}

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

// runStep 执行单个 step，含 retry 与 ${{ }} 预处理。
func (e *Executor) runStep(
	ctx context.Context,
	step Step,
	actionRun ActionRunFunc,
	shellRun ShellRunFunc,
	stepCtx *StepContext,
	emit runner.EmitFunc,
) runner.Result {
	res := e.dispatch(ctx, step, actionRun, shellRun, stepCtx, emit)
	if res.ExitCode == 0 || step.Retry <= 0 {
		return res
	}
	for attempt := 1; attempt <= step.Retry; attempt++ {
		emit("stdout", fmt.Sprintf("retry %d/%d", attempt, step.Retry))
		res = e.dispatch(ctx, step, actionRun, shellRun, stepCtx, emit)
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
	stepCtx *StepContext,
	emit runner.EmitFunc,
) runner.Result {
	stepEnv, err := substituteMap(mergeEnv(stepCtx.Env, step.Env), stepCtx, "env")
	if err != nil {
		emit("stderr", err.Error())
		return runner.Result{ExitCode: -1, Err: err}
	}
	switch {
	case step.Sleep > 0:
		return (&runner.SleepRunner{Seconds: step.Sleep}).Run(ctx, nil, emit)
	case step.Action != "":
		resolved, err := substituteMap(step.Params, stepCtx, "params")
		if err != nil {
			emit("stderr", err.Error())
			return runner.Result{ExitCode: -1, Err: err}
		}
		return actionRun(ActionRequest{
			Ctx: ctx, ActionID: step.Action, Params: toAnyMap(resolved),
			Env: stepEnv, CaptureOutput: step.CaptureOutput, Emit: emit,
		})
	case step.Shell != "":
		substituted, err := Substitute(step.Shell, stepCtx)
		if err != nil {
			emit("stderr", err.Error())
			return runner.Result{ExitCode: -1, Err: err}
		}
		return shellRun(ShellRequest{
			Ctx: ctx, Shell: substituted, Timeout: step.Timeout,
			Env: stepEnv, CaptureOutput: step.CaptureOutput,
			Params: stepCtx.Params, Emit: emit,
		})
	default:
		return runner.Result{ExitCode: -1, Err: fmt.Errorf("step 无有效 kind")}
	}
}

// stepKey 返回 step 在 context 中的键：有 id 用 id，否则用索引字符串。
func stepKey(s Step, i int) string {
	if s.ID != "" {
		return s.ID
	}
	return strconv.Itoa(i)
}

// resolveEnv 用 baseParams 对 workflow.Env 的值做 ${VAR} 展开。
// 内置变量在此层不接入（builtins=nil）：这只是 StepContext.Env 的初始化，
// 真正下发给 Runner 执行的 env 由 api 层的 makeShellRun/buildActionRunParams 用
// s.builtins 重新展开一次（见 internal/api/workflows.go），此处结果仅供 if 表达式等读取。
func resolveEnv(rawEnv map[string]string, baseParams map[string]any) map[string]string {
	if len(rawEnv) == 0 {
		return map[string]string{}
	}
	return runner.ExpandMap(context.Background(), rawEnv, baseParams, nil)
}

// mergeEnv 合并 workflow.env 与 step.env（step 覆盖同名）。
func mergeEnv(wfEnv, stepEnv map[string]string) map[string]string {
	if len(wfEnv) == 0 && len(stepEnv) == 0 {
		return nil
	}
	out := make(map[string]string, len(wfEnv)+len(stepEnv))
	for k, v := range wfEnv {
		out[k] = v
	}
	for k, v := range stepEnv {
		out[k] = v
	}
	return out
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

// substituteMap 对 step 的 map（params 或 env）每个 value 做 ${{ }} 表达式展开，
// 使其能引用前置 step 的 outputs（如 ${{ steps.find.outputs.apk_path }}）。
// label 用于错误信息标识（"params"/"env"）。剩余 ${VAR} 交给下游 runner.Expand。
func substituteMap(m map[string]string, ctx *StepContext, label string) (map[string]string, error) {
	if len(m) == 0 {
		return m, nil
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		substituted, err := Substitute(v, ctx)
		if err != nil {
			return nil, fmt.Errorf("step %s %q: %w", label, k, err)
		}
		out[k] = substituted
	}
	return out, nil
}
