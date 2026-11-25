package airun

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"workflow-tool/internal/ai"
	"workflow-tool/internal/runner"
	"workflow-tool/internal/workflow"
)

// Run 构造并执行一次 AI 任务：应用内的手动运行、CLI 的 --allow-ai 运行与独立执行器共用。
// 输入原样交给 Build，模板展开、必填与未知参数校验都在那里完成；早于进程启动的失败也向
// stderr 推一行原因，让事件流与运行日志里都看得到。
//
// 第二个返回值是本次注入的无人值守守则全文（构造失败时为空），运行记录据此留档。
func Run(ctx context.Context, lt ai.LoadedTask, deps Deps, opts Options, emit runner.EmitFunc) (runner.Result, string) {
	if emit == nil {
		emit = func(string, string) {}
	}
	r, err := Build(ctx, lt, deps, opts)
	if err != nil {
		emit("stderr", err.Error())
		return runner.Result{ExitCode: -1, Err: err,
			Outputs: map[string]string{"exit_code": "-1", "success": "false"}}, ""
	}
	res := r.Run(ctx, nil, emit)
	// 超时被杀时把裸的 context deadline exceeded 换成可行动的提示：会话 id 已在
	// outputs 里（session_id），后续运行用保留参数 resume 续接，不必从头再来。
	if errors.Is(res.Err, context.DeadlineExceeded) {
		res.Err = &TimeoutError{Limit: lt.Timeout, Cause: res.Err}
	}
	return res, r.Cfg.Rules
}

// Step 执行工作流里的一个 AI 步骤。不含目标锁——占用与取消由调用方负责（ctx 取消即终止
// 这一步）。
//
//   - req.Params 原样交给 Build：executor 只做了 ${{ }} 替换，${VAR} 留给 Build 展开；
//   - step 的 workflow+step env（req.Env）先用 merged 展开 ${VAR}，再作为 ExtraEnv 覆盖
//     任务定义里的同名 env。
func Step(ctx context.Context, lt ai.LoadedTask, deps Deps, opts Options, req workflow.AIRequest, merged map[string]any, emit runner.EmitFunc) runner.Result {
	opts.Params = req.Params
	opts.ExtraEnv = make(map[string]string, len(req.Env))
	for k, v := range req.Env {
		opts.ExtraEnv[k] = runner.Expand(req.Ctx, v, merged, deps.Builtins)
	}
	res, _ := Run(ctx, lt, deps, opts, emit)
	return res
}

// TimeoutError 是 AI 运行超时的对外错误：文案给出续接办法，Unwrap 仍指向底层原因
// （簿记与调用方继续用 errors.Is 判定 context.DeadlineExceeded）。
type TimeoutError struct {
	Limit time.Duration
	Cause error
}

func (e *TimeoutError) Error() string {
	return fmt.Sprintf("AI 运行超时（上限 %s），进程已终止；可用 resume 续接该会话重跑", e.Limit)
}

func (e *TimeoutError) Unwrap() error { return e.Cause }

// Readout 从一次 AI 运行的产出里挑出终点读数：会话 id、费用与分项 token（数值化），
// 外加本次运行的精确时长。done 事件与运行日志的 done 行带着它，工序段面板据此结算。
// 仅当既无成本读数也无会话 id 时返回 nil（durationMs 单独不算，done 的 payload 本身
// 已带 duration）。
//
// 会话 id 单独也撑起读数：失败/超时杀进程时 result 事件不会到达（无 cost/tokens），
// 但 system/init 的 session_id 已写入——此刻恰恰是最需要会话 id（续接）的时候。
func Readout(outputs map[string]string, d time.Duration) map[string]any {
	r := map[string]any{"durationMs": d.Milliseconds()}
	if sid := outputs["session_id"]; sid != "" {
		r["sessionId"] = sid
	}
	if v, err := strconv.ParseFloat(outputs["cost_usd"], 64); err == nil {
		r["costUsd"] = v
	}
	in, errIn := strconv.Atoi(outputs["input_tokens"])
	out, errOut := strconv.Atoi(outputs["output_tokens"])
	if errIn == nil && errOut == nil {
		r["inputTokens"], r["outputTokens"] = in, out
	}
	if _, ok := r["sessionId"]; ok {
		return r
	}
	if _, ok := r["costUsd"]; ok {
		return r
	}
	if _, ok := r["inputTokens"]; !ok {
		return nil
	}
	return r
}
