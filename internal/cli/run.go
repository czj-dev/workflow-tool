package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"workflow-tool/internal/actionrun"
	"workflow-tool/internal/ai"
	"workflow-tool/internal/airun"
	"workflow-tool/internal/apphome"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
	targetkind "workflow-tool/internal/target"
	"workflow-tool/internal/targetlock"
	"workflow-tool/internal/workflow"
)

// cmdRun 执行 action / workflow / AI 任务。args[0] 是目标 id，flags 跟其后；执行器模式
// （--record）没有位置参数，目标与输入取自运行记录。
//
// AI 任务与含 AI 步骤的 workflow 默认 ai_blocked：无人值守的 AI 运行无审批门控（pi
// --no-approve，ADR-0008），必须用 --allow-ai 显式放行（调度与立即运行经执行器发起，应用替它们给出这个标志）。
func cmdRun(args []string) int {
	rest := args
	if len(args) > 0 && args[0] != "" && args[0][0] != '-' {
		rest = args[1:]
	}
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	jsonMode := fs.Bool("json", false, "NDJSON 流式输出")
	paramsRaw := fs.String("params", "", "参数 JSON / @file / @-")
	baseDir := fs.String("base-dir", "", "")
	deviceSerial := fs.String("device", "", "adb 设备 serial")
	kind := fs.String("kind", "", "action|workflow|ai（撞名消歧）")
	timeout := fs.Duration("timeout", 0, "整次运行超时，如 30s/5m，默认不限")
	allowAI := fs.Bool("allow-ai", false, "放行 AI 任务与含 AI 步骤的 workflow（无人值守，无审批门控）")
	record := fs.String("record", "", "执行器模式：接手这条运行记录（run-id），目标与输入取自记录")
	if err := fs.Parse(rest); err != nil {
		return exitCLIError
	}

	// 信号 → ctx 取消（子进程清理复用 runner 的 pgid 逻辑）；可选 --timeout 封顶。
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, *timeout)
		defer cancel()
	}

	base := apphome.ResolveBaseDir(*baseDir)
	// 执行器模式：先接手记录再加载目标（见 internal/cli/executor.go 的说明），loadEnv
	// 不能放在它前面——加载耗时会让应用侧的核对循环在执行器接手之前把运行判成中断。
	if *record != "" {
		return ExecuteRecord(ctx, base, *record, *allowAI)
	}

	e := loadEnv(base)
	e.allowAI = *allowAI
	if len(rest) == len(args) {
		fmt.Fprintln(os.Stderr, "用法: workflow-tool run <id> [--json] [--params <json>|@file|@-] [--kind ..] [--device ..] [--allow-ai] [--base-dir ..] [--timeout ..]")
		return exitCLIError
	}
	id := args[0]

	enc := ndjsonEncoder()
	tgt, cerr := e.resolve(id, *kind)
	if cerr != nil {
		return fail(*jsonMode, enc, cerr)
	}
	rawParams, cerr := parseParamsFlag(*paramsRaw)
	if cerr != nil {
		return fail(*jsonMode, enc, cerr)
	}
	res, _ := e.runTarget(ctx, tgt, rawParams, *deviceSerial, pickEmit(*jsonMode, enc))
	return finish(*jsonMode, enc, res)
}

// runTarget 按解析结果的种类分发，并占住目标锁（跨进程互斥，与应用内的运行、别的执行器
// 都互斥；跑完释放）。第二个返回值仅 AI 任务有：本次注入的守则全文，供运行记录留档。
// 调用错误（参数不合法、目标被占、AI 未放行）以 *cliError 放进 Result.Err。
func (e *env) runTarget(ctx context.Context, tgt target, rawParams map[string]any, deviceSerial string, emit runner.EmitFunc) (runner.Result, string) {
	// 放行检查在占锁之前：它是调用错误，不值得占一下目标。
	if blocked := e.aiBlocked(tgt); blocked != nil {
		return cliFailure(blocked), ""
	}
	release, err := e.locks.Acquire(targetkind.Kind(tgt.kind), tgt.id())
	if err != nil {
		if errors.Is(err, targetlock.ErrBusy) {
			return cliFailure(&cliError{"target_locked", fmt.Sprintf("%s %q 正在运行，未发起这次运行", tgt.kind, tgt.id())}), ""
		}
		return cliFailure(&cliError{"target_lock", err.Error()}), ""
	}
	defer release()

	switch tgt.kind {
	case "action":
		return e.runAction(ctx, tgt.la, rawParams, deviceSerial, emit), ""
	case "ai":
		return e.runAi(ctx, tgt.lt, rawParams, emit)
	}
	return e.runWorkflow(ctx, tgt.lw, rawParams, deviceSerial, emit), ""
}

// aiBlocked 在未放行（--allow-ai）时报告这次运行为什么会碰 AI：直接跑 AI 任务，或
// workflow 含 AI 步骤。放行了或与 AI 无关返回 nil。
func (e *env) aiBlocked(tgt target) *cliError {
	if e.allowAI {
		return nil
	}
	switch tgt.kind {
	case "ai":
		return &cliError{"ai_blocked", fmt.Sprintf("AI 任务 %q 不能在 CLI 里运行（用 GUI 跑，或加 --allow-ai 放行）", tgt.lt.Task.ID)}
	case "workflow":
		for _, step := range tgt.lw.Def.Steps {
			if step.AI != "" {
				return &cliError{"ai_blocked", fmt.Sprintf("workflow 含 AI 步骤（任务 %q），CLI 不支持运行（用 GUI 跑，或加 --allow-ai 放行）", step.AI)}
			}
		}
	}
	return nil
}

// cliFailure 把调用错误包成 Result：cmdRun 据此报 CLI 级错误（退出码 2），执行器据此落失败记录。
func cliFailure(err *cliError) runner.Result {
	return runner.Result{ExitCode: -1, Err: err}
}

// id 返回目标 id。
func (t target) id() string {
	switch t.kind {
	case "action":
		return t.la.Def.ID
	case "ai":
		return t.lt.Task.ID
	}
	return t.lw.Def.ID
}

// runAction 跑单个 action：参数校验 → 设备预检 → 展开 → cwd 校验 → Build → Run。
// 镜像 api.execute，但无 Wails。
func (e *env) runAction(ctx context.Context, la registry.LoadedAction, rawParams map[string]any, deviceSerial string, emit runner.EmitFunc) runner.Result {
	params, cerr := coerceParams(la.Def.Params, rawParams)
	if cerr != nil {
		return cliFailure(cerr)
	}
	merged := e.merge(params)
	if deviceSerial != "" {
		merged["ADB_SERIAL"] = deviceSerial
	}
	// adb 形态且未指定设备：无可用 ready 设备则给清晰 CLI 错误，而非让 adb 盲等。
	if la.Def.Command.Adb.Operation != "" && deviceSerial == "" {
		if serial, _ := e.dev.ResolveActive(ctx); serial == "" {
			return cliFailure(&cliError{"no_device", "没有可用的 adb 设备；用 --device 指定或先连接设备"})
		}
	}

	expanded := runner.ExpandParams(ctx, merged, e.builtins)
	cwd := runner.Expand(ctx, la.Cwd, expanded, e.builtins)
	if cwd != "" {
		if _, err := os.Stat(cwd); err != nil {
			return runner.Result{ExitCode: -1, Err: fmt.Errorf("工作目录不存在: %s", cwd)}
		}
	}

	r, err := actionrun.Build(ctx, la, e.deps, actionrun.Options{Params: expanded})
	if err != nil {
		return runner.Result{ExitCode: -1, Err: err}
	}
	return r.Run(ctx, expanded, emit)
}

// runAi 跑单个 AI 任务：输入原样交给 airun.Run（模板展开与校验在那里）。
// 第二个返回值是本次注入的守则全文。
func (e *env) runAi(ctx context.Context, lt ai.LoadedTask, rawParams map[string]any, emit runner.EmitFunc) (runner.Result, string) {
	return airun.Run(ctx, lt, e.aiDeps, airun.Options{Params: rawParams, Global: e.global}, emit)
}

// runWorkflow 跑 workflow：参数校验 → 复用 actionrun.WorkflowCallbacks；AI 步骤的回调是
// airun.Step（与 GUI 同一份执行段）。
func (e *env) runWorkflow(ctx context.Context, lw workflow.LoadedWorkflow, rawParams map[string]any, deviceSerial string, emit runner.EmitFunc) runner.Result {
	params, cerr := coerceParams(lw.Def.Params, rawParams)
	if cerr != nil {
		return cliFailure(cerr)
	}
	merged := e.merge(params)
	if deviceSerial != "" {
		merged["ADB_SERIAL"] = deviceSerial
	}

	actionRun, shellRun := actionrun.WorkflowCallbacks(e.reg, e.deps, merged)
	// 动作步骤占它自己的目标锁（规格：工作流的动作步骤与 AI 步骤同样占锁）。
	actionRun = actionrun.LockActionStep(actionRun, e.locks)
	aiRun := e.aiStep(merged)
	return (&workflow.Executor{}).Execute(ctx, lw, actionRun, shellRun, aiRun, merged, emit)
}

// aiStep 构造 workflow 中 ai step 的执行回调（对标 api.aiStepRun，但不含进程内簿记：
// 取消随 workflow 的 ctx）。与动作步骤同样占目标锁：撞上立即失败、不等待。
func (e *env) aiStep(merged map[string]any) workflow.AIRunFunc {
	return func(req workflow.AIRequest) runner.Result {
		return actionrun.LockStep(req.TaskID, req.Emit, e.locks, targetkind.AI, func() runner.Result {
			lt, ok := e.aiReg.Get(req.TaskID)
			if !ok {
				err := fmt.Errorf("未知 AI 任务 %q", req.TaskID)
				req.Emit("stderr", err.Error())
				return runner.Result{ExitCode: -1, Err: err, Outputs: map[string]string{"exit_code": "-1", "success": "false"}}
			}
			return airun.Step(req.Ctx, lt, e.aiDeps, airun.Options{Global: e.global}, req, merged, req.Emit)
		})
	}
}
