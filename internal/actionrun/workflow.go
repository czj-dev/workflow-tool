package actionrun

import (
	"context"
	"fmt"
	"time"

	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
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
		withDefaults := make(map[string]any, len(la.Def.Params)+len(runParams))
		for _, param := range la.Def.Params {
			if param.Default != "" {
				withDefaults[param.ID] = runner.Expand(req.Ctx, param.Default, merged, deps.Builtins)
			}
		}
		for key, value := range runParams {
			withDefaults[key] = value
		}
		runParams = withDefaults
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
		return r.Run(req.Ctx, runParams, req.Emit)
	}
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
	runParams := make(map[string]any, len(merged)+len(stepParams))
	for k, v := range merged {
		runParams[k] = v
	}
	for k, v := range stepParams {
		if sv, ok := v.(string); ok {
			runParams[k] = runner.Expand(ctx, sv, merged, deps.Builtins)
		} else {
			runParams[k] = v
		}
	}
	expandedEnv := make(map[string]string, len(env))
	for k, v := range env {
		expandedEnv[k] = runner.Expand(ctx, v, merged, deps.Builtins)
	}
	return runParams, expandedEnv
}
