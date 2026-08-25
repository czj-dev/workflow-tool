package api

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"workflow-tool/internal/actionrun"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
	"workflow-tool/internal/workflow"
)

// WorkflowStepInfo 是前端侧边栏/概览可见的步骤摘要。
type WorkflowStepInfo struct {
	// 改动 Kind 的取值集合时，必须同步前端 frontend/src/components/WorkflowStepsOverview.tsx
	// 的 STEP_ICON 表：前端无编译期约束，缺键会落到 ?? FlashIcon 兜底、图标静默退化成 action 的闪电。
	Kind  string `json:"kind"`  // "action" | "sleep" | "run"
	Label string `json:"label"` // 显示文案，如 action id / "5s" / 截断 run
	Name  string `json:"name"`  // step.name 人类可读标签（可为空）
}

// WorkflowItem 是前端可见的 workflow 描述。
type WorkflowItem struct {
	ID          string               `json:"id"`
	Title       string               `json:"title"`
	Icon        string               `json:"icon"`
	Description string               `json:"description"`
	StepCount   int                  `json:"stepCount"`
	Params      []registry.ParamSpec `json:"params"`
	Steps       []WorkflowStepInfo   `json:"steps"`
}

// WorkflowListResult 是 ListWorkflows 的返回值。
type WorkflowListResult struct {
	Workflows []WorkflowItem `json:"workflows"`
	Errors    []string       `json:"errors"`
}

// ListWorkflows 返回全部已加载 workflow + 加载错误。
func (s *Service) ListWorkflows() WorkflowListResult {
	items := make([]WorkflowItem, 0, len(s.wfReg.Workflows))
	for _, lw := range s.wfReg.Workflows {
		steps := buildStepInfos(lw.Def.Steps)
		items = append(items, WorkflowItem{
			ID:          lw.Def.ID,
			Title:       lw.Def.Title,
			Icon:        lw.Def.Icon,
			Description: lw.Def.Description,
			StepCount:   len(lw.Def.Steps),
			Params:      lw.Def.Params,
			Steps:       steps,
		})
	}
	errs := make([]string, 0, len(s.wfReg.Errors))
	for _, e := range s.wfReg.Errors {
		errs = append(errs, fmt.Sprintf("%s: %s", e.File, e.Error))
	}
	return WorkflowListResult{Workflows: items, Errors: errs}
}

// buildStepInfos 把 step 列表转换为前端可用的摘要。
func buildStepInfos(steps []workflow.Step) []WorkflowStepInfo {
	infos := make([]WorkflowStepInfo, len(steps))
	for i, s := range steps {
		info := WorkflowStepInfo{Name: s.Name}
		switch {
		case s.Action != "":
			info.Kind = "action"
			info.Label = s.Action
		case s.Sleep > 0:
			info.Kind = "sleep"
			info.Label = fmt.Sprintf("%ds", s.Sleep)
		case s.Run != "":
			label := s.Run
			if len(label) > 40 {
				label = label[:37] + "..."
			}
			info.Kind = "run"
			info.Label = label
		}
		infos[i] = info
	}
	return infos
}

// ReloadWorkflows 重扫 workflows 目录重建 wfReg（编辑保存后调用）。
func (s *Service) ReloadWorkflows() {
	s.wfReg = workflow.Load(filepath.Join(s.baseDir, "workflows"))
}

// GetWorkflowYaml 返回指定 workflow 源文件原文（含注释与格式）。
func (s *Service) GetWorkflowYaml(id string) (string, error) {
	lw, ok := s.wfReg.Workflows[id]
	if !ok {
		return "", fmt.Errorf("未知 workflow %q", id)
	}
	data, err := os.ReadFile(lw.File)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// SetWorkflowYaml 校验并写回 workflow 源文件，随后重载 wfReg，返回最新列表。
// 禁止改 id（id 为文件锚点）；解析/校验失败时不写盘。
func (s *Service) SetWorkflowYaml(id string, text string) (WorkflowListResult, error) {
	lw, ok := s.wfReg.Workflows[id]
	if !ok {
		return WorkflowListResult{}, fmt.Errorf("未知 workflow %q", id)
	}
	def, err := workflow.ParseWorkflow([]byte(text))
	if err != nil {
		return WorkflowListResult{}, fmt.Errorf("YAML 解析失败: %w", err)
	}
	if def.ID != id {
		return WorkflowListResult{}, fmt.Errorf("id 不可修改（原 %q，现 %q）", id, def.ID)
	}
	if err := workflow.Validate(def); err != nil {
		return WorkflowListResult{}, err
	}
	if err := os.WriteFile(lw.File, []byte(text), 0644); err != nil {
		return WorkflowListResult{}, err
	}
	s.ReloadWorkflows()
	return s.ListWorkflows(), nil
}

// RunWorkflow 启动 workflow 执行；同一 workflow 并发运行被拒。
func (s *Service) RunWorkflow(id string, params map[string]any) error {
	lw, ok := s.wfReg.Workflows[id]
	if !ok {
		return fmt.Errorf("未知 workflow %q", id)
	}
	ctx, ok := s.wfRunning.begin(id)
	if !ok {
		return fmt.Errorf("workflow %q 正在运行", id)
	}
	go s.executeWorkflow(ctx, id, lw, params)
	return nil
}

// CancelWorkflow 取消正在运行的 workflow。
func (s *Service) CancelWorkflow(id string) {
	s.wfRunning.cancel(id)
}

// executeWorkflow 在独立 goroutine 里执行 workflow（事件协议见 events.go 的 workflowEvents）。
func (s *Service) executeWorkflow(ctx context.Context, id string, lw workflow.LoadedWorkflow, params map[string]any) {
	defer s.wfRunning.end(id)
	ev := newWorkflowEvents(s.app, id)

	merged := s.mergeGlobalAndParams(params)
	res := (&workflow.Executor{}).Execute(ctx, lw, s.makeActionRun(merged), s.makeShellRun(merged), merged, ev.EmitFunc())
	ev.Done(res.ExitCode, errStr(res.Err), res.Duration)
}

// makeActionRun 构造 workflow 中 action step 的执行回调。
// merged 是 global+workflow params 合并结果（终值），作为 step.params/env 里 ${VAR} 的变量源。
func (s *Service) makeActionRun(merged map[string]any) workflow.ActionRunFunc {
	return func(req workflow.ActionRequest) runner.Result {
		la, ok := s.reg.Actions[req.ActionID]
		if !ok {
			req.Emit("stderr", fmt.Sprintf("未知动作 %q", req.ActionID))
			return runner.Result{ExitCode: -1, Err: fmt.Errorf("未知动作 %q", req.ActionID)}
		}
		// ${VAR} 展开必须在合并前完成（详见 buildActionRunParams 注释）。
		runParams, expandedEnv := s.buildActionRunParams(req.Ctx, merged, req.Env, req.Params)
		// 与直跑路径共用同一构造逻辑：形态分发/env 分层/capture 合并都在 actionrun.Build 里。
		r := actionrun.Build(req.Ctx, la, s.runDeps, actionrun.Options{
			Params:          runParams,
			ExtraEnv:        expandedEnv,
			CaptureOverride: req.CaptureOutput,
		})
		return r.Run(req.Ctx, runParams, req.Emit)
	}
}

// makeShellRun 构造 workflow 中 inline shell step 的执行回调。
func (s *Service) makeShellRun(merged map[string]any) workflow.ShellRunFunc {
	return func(req workflow.ShellRequest) runner.Result {
		// env 的 ${VAR} 用 merged 展开（executor 只做了 ${{ }} 替换，剩余在此了结）
		expandedEnv := make(map[string]string, len(req.Env))
		for k, v := range req.Env {
			expandedEnv[k] = runner.Expand(req.Ctx, v, merged, s.builtins)
		}
		// params 同样展开成终值（runner 拿到即终值的统一约定）
		runParams := make(map[string]any, len(req.Params))
		for k, v := range req.Params {
			if sv, ok := v.(string); ok {
				runParams[k] = runner.Expand(req.Ctx, sv, merged, s.builtins)
			} else {
				runParams[k] = v
			}
		}
		r := &runner.ShellRunner{Cfg: runner.ShellConfig{
			Run:           req.Run,
			Shell:         req.Shell,
			BashPath:      s.bashOverride(),
			Timeout:       parseShellTimeout(req.Timeout),
			Env:           expandedEnv,
			CaptureOutput: req.CaptureOutput,
			Builtins:      s.builtins,
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
// 这类自引用会展开成自身原值，拿不到 merged 里的真实包名
// （复现：adb-clean-reinstall 第一步 force-stop 收到空包名）。
func (s *Service) buildActionRunParams(ctx context.Context, merged map[string]any, env map[string]string, stepParams map[string]any) (map[string]any, map[string]string) {
	// 1. 合并 merged + stepParams（step 覆盖），字符串值用 merged 展开 ${VAR}
	runParams := make(map[string]any, len(merged)+len(stepParams))
	for k, v := range merged {
		runParams[k] = v
	}
	for k, v := range stepParams {
		if sv, ok := v.(string); ok {
			runParams[k] = runner.Expand(ctx, sv, merged, s.builtins)
		} else {
			runParams[k] = v
		}
	}

	// 2. env 的 ${VAR} 同样用 merged 展开（如 ADB_SERIAL 内置变量兜底）
	expandedEnv := make(map[string]string, len(env))
	for k, v := range env {
		expandedEnv[k] = runner.Expand(ctx, v, merged, s.builtins)
	}

	return runParams, expandedEnv
}
