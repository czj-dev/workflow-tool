package actionrun

import (
	"context"
	"errors"
	"fmt"
	"time"

	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
	"workflow-tool/internal/target"
	"workflow-tool/internal/targetlock"
	"workflow-tool/internal/workflow"
)

// WorkflowCallbacks 构造 workflow.Executor 执行所需的 action / inline shell step 回调。
// api 直跑路径与 cli 路径共用同一份构造逻辑，保证 workflow 内两类 step 行为一致。
// merged 是 global+workflow params 合并结果（终值），作为 step.params/env 里 ${VAR} 的变量源。
func WorkflowCallbacks(reg *registry.Registry, deps Deps, merged map[string]any) (workflow.ActionRunFunc, workflow.ShellRunFunc) {
	return makeActionRun(reg, deps, merged), makeShellRun(deps, merged)
}

// makeActionRun 构造 workflow 中 action step 的执行回调。
func makeActionRun(reg *registry.Registry, deps Deps, merged map[string]any) workflow.ActionRunFunc {
	return func(req workflow.ActionRequest) runner.Result {
		la, ok := reg.Actions[req.ActionID]
		if !ok {
			req.Emit("stderr", fmt.Sprintf("未知动作 %q", req.ActionID))
			return runner.Result{ExitCode: -1, Err: fmt.Errorf("未知动作 %q", req.ActionID)}
		}
		// ${VAR} 展开必须在合并前完成（详见 buildActionRunParams 注释）。
		runParams, expandedEnv := buildActionRunParams(req.Ctx, deps, merged, req.Env, req.Params)
		runParams = withActionDefaults(req.Ctx, deps, runParams, la.Def.Params)
		r, err := Build(req.Ctx, la, deps, Options{
			Params:          runParams,
			ExtraEnv:        expandedEnv,
			CaptureOverride: req.CaptureOutput,
		})
		if err != nil {
			req.Emit("stderr", err.Error())
			return runner.Result{ExitCode: -1, Err: err,
				Outputs: map[string]string{"exit_code": "-1", "success": "false"}}
		}
		protocol := "script"
		if la.Def.Command.Adb.Operation != "" {
			protocol = "adb"
		}
		emit := runner.WithoutTreeHMI(req.Emit, protocol)
		if la.Def.HMI != nil && la.Def.HMI.Tree != nil {
			emit = runner.WithTreeSource(req.Emit, runner.TreeSource{
				ActionID: req.ActionID, Params: runParams, Protocol: protocol,
			})
		}
		return r.Run(req.Ctx, runParams, emit)
	}
}

// LockActionStep 给工作流的动作步骤包一层目标锁（见 LockStep）。api 与 cli 两条 workflow
// 路径共用。
func LockActionStep(next workflow.ActionRunFunc, locks *targetlock.Locks) workflow.ActionRunFunc {
	return func(req workflow.ActionRequest) runner.Result {
		return LockStep(req.ActionID, req.Emit, locks, target.Action, func() runner.Result { return next(req) })
	}
}

// LockStep 在占住目标（kind + id）的锁之后执行 run，跑完释放。工作流的动作步骤与 AI 步骤
// 经它占各自的目标锁，与直接运行该目标、别的进程里的运行互斥。撞上运行中的目标立即失败、
// 不等待（规格：目标锁与冲突）——原因推到 stderr，步骤以 -1 退出。
func LockStep(id string, emit runner.EmitFunc, locks *targetlock.Locks, kind target.Kind, run func() runner.Result) runner.Result {
	release, err := locks.Acquire(kind, id)
	if err != nil {
		if errors.Is(err, targetlock.ErrBusy) {
			err = fmt.Errorf("目标 %q 正在运行，步骤不等待", id)
		}
		emit("stderr", err.Error())
		return runner.Result{ExitCode: -1, Err: err, Outputs: map[string]string{"exit_code": "-1", "success": "false"}}
	}
	defer release()
	return run()
}

// withActionDefaults 与直接运行动作的表单默认值语义一致，同时保留空值参数。
func withActionDefaults(ctx context.Context, deps Deps, params map[string]any, specs []registry.ParamSpec) map[string]any {
	result := make(map[string]any, len(params)+len(specs))
	for key, value := range params {
		result[key] = value
	}
	for _, spec := range specs {
		if _, exists := result[spec.ID]; !exists && spec.Default != "" {
			result[spec.ID] = runner.Expand(ctx, spec.Default, params, deps.Builtins)
		}
	}
	return result
}

// makeShellRun 构造 workflow 中 inline shell step 的执行回调。
func makeShellRun(deps Deps, merged map[string]any) workflow.ShellRunFunc {
	return func(req workflow.ShellRequest) runner.Result {
		// env 的 ${VAR} 用 merged 展开（executor 只做了 ${{ }} 替换，剩余在此了结）
		expandedEnv := make(map[string]string, len(req.Env))
		for k, v := range req.Env {
			expandedEnv[k] = runner.Expand(req.Ctx, v, merged, deps.Builtins)
		}
		// params 同样展开成终值（runner 拿到即终值的统一约定）
		runParams := make(map[string]any, len(req.Params))
		for k, v := range req.Params {
			if sv, ok := v.(string); ok {
				runParams[k] = runner.Expand(req.Ctx, sv, merged, deps.Builtins)
			} else {
				runParams[k] = v
			}
		}
		r := &runner.ShellRunner{Cfg: runner.ShellConfig{
			Run:           req.Run,
			Shell:         req.Shell,
			BashPath:      bashPathOf(deps),
			Timeout:       parseShellTimeout(req.Timeout),
			Env:           expandedEnv,
			CaptureOutput: req.CaptureOutput,
			Builtins:      deps.Builtins,
		}}
		return r.Run(req.Ctx, runParams, req.Emit)
	}
}

// parseShellTimeout 解析 shell step 的 timeout 字符串（如 "120s"/"2m"）；
// 空/非法回退 60s，与 registry 的 action timeout 解析语义一致。
func parseShellTimeout(s string) time.Duration {
	if s == "" {
		return 60 * time.Second
	}
	if d, err := time.ParseDuration(s); err == nil {
		return d
	}
	return 60 * time.Second
}

// buildActionRunParams 合并 global/workflow params（merged）与 step.params，并展开 ${VAR}。
// 展开变量源必须是 merged 而非合并结果——否则 step.params 里 { PACKAGE: "${PACKAGE}" }
// 这类自引用会展开成自身原值，拿不到 merged 里的真实包名。
func buildActionRunParams(ctx context.Context, deps Deps, merged map[string]any, env map[string]string, stepParams map[string]any) (map[string]any, map[string]string) {
	baseParams := runner.ExpandParams(ctx, merged, deps.Builtins)
	runParams := make(map[string]any, len(baseParams)+len(stepParams))
	for k, v := range baseParams {
		runParams[k] = v
	}
	for k, v := range stepParams {
		if sv, ok := v.(string); ok {
			runParams[k] = runner.Expand(ctx, sv, baseParams, deps.Builtins)
		} else {
			runParams[k] = v
		}
	}
	expandedEnv := make(map[string]string, len(env))
	for k, v := range env {
		expandedEnv[k] = runner.Expand(ctx, v, baseParams, deps.Builtins)
	}
	return runParams, expandedEnv
}
