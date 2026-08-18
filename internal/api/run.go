package api

import (
	"context"
	"fmt"
	"os"

	"workflow-tool/internal/actionrun"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
)

// RunAction 按 id 启动动作，params 为运行时参数；输出通过事件流推送。
func (s *Service) RunAction(id string, params map[string]any) error {
	la, ok := s.reg.Actions[id]
	if !ok {
		return fmt.Errorf("未知动作 %q", id)
	}
	ctx, ok := s.running.begin(id)
	if !ok {
		return fmt.Errorf("动作 %q 正在运行", id)
	}

	merged := s.mergeGlobalAndParams(params)
	go s.execute(ctx, id, la, merged)
	return nil
}

// mergeGlobalAndParams 合并全局配置与参数（参数覆盖同名全局）。
func (s *Service) mergeGlobalAndParams(params map[string]any) map[string]any {
	s.gMu.Lock()
	defer s.gMu.Unlock()
	merged := make(map[string]any, len(s.global)+len(params))
	for k, v := range s.global {
		merged[k] = v
	}
	for k, v := range params {
		merged[k] = v
	}
	return merged
}

// CancelAction 取消正在运行的动作。
func (s *Service) CancelAction(id string) {
	s.running.cancel(id)
}

// execute 在独立 goroutine 里执行动作（事件协议见 events.go 的 actionEvents）：
// 统一 ${VAR} 展开 → 工作目录校验 → actionrun.Build 构造 runner → 运行 → done 事件。
func (s *Service) execute(ctx context.Context, id string, la registry.LoadedAction, params map[string]any) {
	// 统一在进入 runner 前对 params 做 ${VAR} 展开：runner 拿到的是终值，不再各自展开。
	params = runner.ExpandParams(params)
	defer s.running.end(id)

	ev := newActionEvents(s.app, id)

	// 运行时替换 cwd（用终值 params），替换后检查存在性；
	// 早退发生在任何 output 之前，done 不带 seq（前端直接应用）。
	cwd := runner.Expand(la.Cwd, params)
	if cwd != "" {
		if _, err := os.Stat(cwd); err != nil {
			ev.DoneUnordered(-1, fmt.Sprintf("工作目录不存在: %s", cwd), 0)
			return
		}
	}

	r := actionrun.Build(la, s.runDeps, actionrun.Options{Params: params})
	res := r.Run(ctx, params, ev.EmitFunc())

	// LLM 形态提取终点读数（cost/tokens/session_id），随 done 事件下发。
	var readout map[string]any
	if la.Def.Command.LLM.Prompt != "" {
		readout = llmReadout(res.Outputs, res.Duration)
	}
	ev.Done(res.ExitCode, errStr(res.Err), res.Duration, readout)
}
