package api

import (
	"context"
	"fmt"
	"os"

	"workflow-tool/internal/actionrun"
	"workflow-tool/internal/adb/logcat"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
)

// controlChanCap 控制通道缓冲：前端 300ms 防抖后过滤更新的到达速率远低于后端
// 处理速率，4 足以吸收突发；溢出策略（挤掉过期更新）见 UpdateLogcatFilter。
const controlChanCap = 4

// RunAction 按 id 启动动作，params 为运行时参数；输出通过事件流推送。
// logcat-stream 动作额外预登记控制通道（UpdateLogcatFilter 按 id 寻址下发规则）。
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
	var ctrl chan any
	if la.Def.Command.Adb.Operation == logcat.OpStream {
		ctrl = make(chan any, controlChanCap)
		s.running.setControl(id, ctrl)
	}
	go s.execute(ctx, id, la, merged, ctrl)
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

// UpdateLogcatFilter 运行期更新 logcat-stream 动作的过滤规则（spec 决策 3/4：前端
// 300ms 防抖后调用，后端收到即重筛 raw ring 并以 logcat-replace 帧整体重发）。
// 未运行/非 logcat-stream 返回 error；非法规则同步返回 error 且运行中的旧规则不受
// 影响（不静默降级）。reset=true 同时清空后端 raw ring 与增量缓冲（清空按钮联动）。
func (s *Service) UpdateLogcatFilter(id string, rule logcat.Rule, reset bool) error {
	if _, err := logcat.CompileRule(rule); err != nil {
		return fmt.Errorf("非法过滤规则: %w", err)
	}
	// 控制通道只在 logcat-stream 运行期存在（RunAction 登记、end 清除），
	// 它同时是「在运行」与「是 logcat-stream」两个条件的唯一事实源。
	ch, ok := s.running.control(id)
	if !ok {
		return fmt.Errorf("动作 %q 未在运行或不是 logcat-stream", id)
	}
	update := logcat.FilterUpdate{Rule: rule, Reset: reset}
	select {
	case ch <- update:
		return nil
	default:
		// 规则是整体快照（非增量）：挤掉一条积压的过期更新后重试；仍满才报错。
		select {
		case <-ch:
		default:
		}
		select {
		case ch <- update:
			return nil
		default:
			return fmt.Errorf("动作 %q 的过滤更新积压，请稍后重试", id)
		}
	}
}

// execute 在独立 goroutine 里执行动作（事件协议见 events.go 的 actionEvents）：
// 统一 ${VAR} 展开 → 工作目录校验 → actionrun.Build 构造 runner → 运行 → done 事件。
// ctrl 为 logcat-stream 的运行期控制通道（其余动作为 nil）。
func (s *Service) execute(ctx context.Context, id string, la registry.LoadedAction, params map[string]any, ctrl chan any) {
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

	r := actionrun.Build(la, s.runDeps, actionrun.Options{Params: params, ADBControl: ctrl})
	res := r.Run(ctx, params, ev.EmitFunc())

	// LLM 形态提取终点读数（cost/tokens/session_id），随 done 事件下发。
	var readout map[string]any
	if la.Def.Command.LLM.Prompt != "" {
		readout = llmReadout(res.Outputs, res.Duration)
	}
	ev.Done(res.ExitCode, errStr(res.Err), res.Duration, readout)
}
