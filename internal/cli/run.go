package cli

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"workflow-tool/internal/actionrun"
	"workflow-tool/internal/apphome"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
	"workflow-tool/internal/workflow"
)

// cmdRun 执行 action 或 workflow。id 必须是 args[0]，flags 跟其后。
// AI 任务与含 AI 步骤的 workflow 一律 ai_blocked（见 runTarget/runWorkflow）：无人值守
// 的 AI 运行只走 GUI（目标锁、会话续接、流式视图都在那里）。
func cmdRun(args []string) int {
	if len(args) < 1 || args[0] == "" || args[0][0] == '-' {
		fmt.Fprintln(os.Stderr, "用法: workflow-tool run <id> [--json] [--params <json>|@file|@-] [--kind ..] [--device ..] [--base-dir ..] [--timeout ..]")
		return exitCLIError
	}
	id := args[0]

	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	jsonMode := fs.Bool("json", false, "NDJSON 流式输出")
	paramsRaw := fs.String("params", "", "参数 JSON / @file / @-")
	baseDir := fs.String("base-dir", "", "")
	deviceSerial := fs.String("device", "", "adb 设备 serial")
	kind := fs.String("kind", "", "action|workflow|ai（撞名消歧）")
	timeout := fs.Duration("timeout", 0, "整次运行超时，如 30s/5m，默认不限")
	if err := fs.Parse(args[1:]); err != nil {
		return exitCLIError
	}

	enc := ndjsonEncoder()
	e := loadEnv(apphome.ResolveBaseDir(*baseDir))

	tgt, cerr := e.resolve(id, *kind)
	if cerr != nil {
		return fail(*jsonMode, enc, cerr)
	}
	rawParams, cerr := parseParamsFlag(*paramsRaw)
	if cerr != nil {
		return fail(*jsonMode, enc, cerr)
	}

	// 信号 → ctx 取消（子进程清理复用 runner 的 pgid 逻辑）；可选 --timeout 封顶。
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, *timeout)
		defer cancel()
	}

	return e.runTarget(ctx, tgt, rawParams, *deviceSerial, *jsonMode, enc)
}

// runTarget 按解析结果的种类分发；AI 任务在 CLI 不可运行，直接 ai_blocked。
func (e *env) runTarget(ctx context.Context, tgt target, rawParams map[string]any, deviceSerial string, jsonMode bool, enc *jsonEnc) int {
	switch tgt.kind {
	case "action":
		return e.runAction(ctx, tgt.la, rawParams, deviceSerial, jsonMode, enc)
	case "ai":
		return fail(jsonMode, enc, &cliError{"ai_blocked", fmt.Sprintf("AI 任务 %q 不能在 CLI 里运行（用 GUI 跑）", tgt.lt.Task.ID)})
	}
	return e.runWorkflow(ctx, tgt.lw, rawParams, deviceSerial, jsonMode, enc)
}

// runAction 跑单个 action：参数校验 → 设备预检 → 展开 → cwd 校验 → Build → Run。
// 镜像 api.execute，但无 Wails。
func (e *env) runAction(ctx context.Context, la registry.LoadedAction, rawParams map[string]any, deviceSerial string, jsonMode bool, enc *jsonEnc) int {
	params, cerr := coerceParams(la.Def.Params, rawParams)
	if cerr != nil {
		return fail(jsonMode, enc, cerr)
	}
	merged := e.merge(params)
	if deviceSerial != "" {
		merged["ADB_SERIAL"] = deviceSerial
	}
	// adb 形态且未指定设备：无可用 ready 设备则给清晰 CLI 错误，而非让 adb 盲等。
	if la.Def.Command.Adb.Operation != "" && deviceSerial == "" {
		if serial, _ := e.dev.ResolveActive(ctx); serial == "" {
			return fail(jsonMode, enc, &cliError{"no_device", "没有可用的 adb 设备；用 --device 指定或先连接设备"})
		}
	}

	expanded := runner.ExpandParams(ctx, merged, e.builtins)
	cwd := runner.Expand(ctx, la.Cwd, expanded, e.builtins)
	if cwd != "" {
		if _, err := os.Stat(cwd); err != nil {
			return finish(jsonMode, enc, runner.Result{ExitCode: -1, Err: fmt.Errorf("工作目录不存在: %s", cwd)})
		}
	}

	r, err := actionrun.Build(ctx, la, e.deps, actionrun.Options{Params: expanded})
	if err != nil {
		return finish(jsonMode, enc, runner.Result{ExitCode: -1, Err: err})
	}
	res := r.Run(ctx, expanded, pickEmit(jsonMode, enc))
	return finish(jsonMode, enc, res)
}

// runWorkflow 跑 workflow：预扫 steps 挡掉 AI 步骤 → 参数校验 → 复用 actionrun.WorkflowCallbacks。
// AI 步骤的回调传 nil：预扫已保证执行器走不到 AI 步骤（nil 只是兜底，走到即该步失败）。
func (e *env) runWorkflow(ctx context.Context, lw workflow.LoadedWorkflow, rawParams map[string]any, deviceSerial string, jsonMode bool, enc *jsonEnc) int {
	for _, step := range lw.Def.Steps {
		if step.AI != "" {
			return fail(jsonMode, enc, &cliError{"ai_blocked", fmt.Sprintf("workflow 含 AI 步骤（任务 %q），CLI 不支持运行（用 GUI 跑）", step.AI)})
		}
	}
	params, cerr := coerceParams(lw.Def.Params, rawParams)
	if cerr != nil {
		return fail(jsonMode, enc, cerr)
	}
	merged := e.merge(params)
	if deviceSerial != "" {
		merged["ADB_SERIAL"] = deviceSerial
	}

	actionRun, shellRun := actionrun.WorkflowCallbacks(e.reg, e.deps, merged)
	res := (&workflow.Executor{}).Execute(ctx, lw, actionRun, shellRun, nil, merged, pickEmit(jsonMode, enc))
	return finish(jsonMode, enc, res)
}
