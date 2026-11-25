package api

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"workflow-tool/internal/actionrun"
	"workflow-tool/internal/adb/logcat"
	"workflow-tool/internal/ai"
	"workflow-tool/internal/airun"
	"workflow-tool/internal/builtinvars"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
	"workflow-tool/internal/runstore"
	"workflow-tool/internal/target"
	"workflow-tool/internal/workflow"
)

// controlChanCap 控制通道缓冲：前端 300ms 防抖后过滤更新的到达速率远低于后端
// 处理速率，4 足以吸收突发；溢出策略（挤掉过期更新）见 UpdateLogcatFilter。
const controlChanCap = 4

// RunAction 按 id 启动动作，params 为运行时参数；输出通过事件流推送。
// logcat-stream 动作额外预登记控制通道（UpdateLogcatFilter 按 id 寻址下发规则）。
func (s *Service) RunAction(id string, params map[string]any) error {
	return s.runAction(id, params, nil)
}

func (s *Service) runAction(id string, params map[string]any, source *runSource) error {
	la, ok := s.actionRegistry().Actions[id]
	if !ok {
		return fmt.Errorf("未知动作 %q", id)
	}
	decoded, literalKeys, err := decodeLiteralParams(params)
	if err != nil {
		return err
	}
	if err := rejectLiteralShellSubstitution(la.Def.Command.Run, literalKeys); err != nil {
		return err
	}
	ctx, ok := s.running.begin(id)
	if !ok {
		return s.onTargetBusy(target.Action, id, decoded, source)
	}
	// 运行记录在占锁之后才建：锁都占不到，就没有这次运行。
	sess := s.beginRun(target.Action, id, decoded, source)
	s.beginScheduledRun(source)

	merged := s.mergeGlobalAndParams(decoded)
	var ctrl chan any
	if la.Def.Command.Adb.Operation == logcat.OpStream {
		ctrl = make(chan any, controlChanCap)
		s.running.setControl(id, ctrl)
	}
	go s.execute(ctx, id, la, merged, ctrl, literalKeys, source, sess)
	return nil
}

// mergeGlobalAndParams 持锁快照 global 后委托 actionrun.MergeParams（合并单一真相源）。
func (s *Service) mergeGlobalAndParams(params map[string]any) map[string]any {
	s.gMu.Lock()
	defer s.gMu.Unlock()
	return actionrun.MergeParams(s.global, params)
}

// decodeLiteralParams 校验树点击传来的字面值包装，仅接受单键对象。
func decodeLiteralParams(params map[string]any) (map[string]any, map[string]bool, error) {
	decoded := make(map[string]any, len(params))
	literalKeys := make(map[string]bool)
	for key, value := range params {
		object, isObject := value.(map[string]any)
		if !isObject {
			decoded[key] = value
			continue
		}
		literal, ok := object["$literal"].(string)
		if !ok || len(object) != 1 {
			return nil, nil, fmt.Errorf("参数 %q 的字面值格式无效", key)
		}
		decoded[key] = literal
		literalKeys[key] = true
	}
	return decoded, literalKeys, nil
}

func rejectLiteralShellSubstitution(command string, literalKeys map[string]bool) error {
	for key := range literalKeys {
		if strings.Contains(command, "${"+key+"}") {
			return fmt.Errorf("参数 %q 是字面值，不能插入内联命令；请在脚本中读取环境变量", key)
		}
	}
	return nil
}

func expandDirectParams(ctx context.Context, params map[string]any, builtins *builtinvars.Registry, literalKeys map[string]bool) map[string]any {
	if len(literalKeys) == 0 {
		return runner.ExpandParams(ctx, params, builtins)
	}
	result := make(map[string]any, len(params))
	for key, value := range params {
		if text, ok := value.(string); ok && !literalKeys[key] {
			result[key] = runner.Expand(ctx, text, params, builtins)
		} else {
			result[key] = value
		}
	}
	return result
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
// sess 是本次运行的记录会话：emit 的每一行同步落进运行日志，结束时在这里写终态。
func (s *Service) execute(ctx context.Context, id string, la registry.LoadedAction, params map[string]any, ctrl chan any, literalKeys map[string]bool, source *runSource, sess *runstore.Session) {
	started := time.Now()
	// 树点击映射值已是终值；其余参数仍以解包后的字符串为变量源展开。
	params = expandDirectParams(ctx, params, s.builtins, literalKeys)
	finished := false
	// 兜底：意外退出时运行记录与调度状态都要有个交代，最后释放目标锁（见 settleRun）。
	defer s.settleRun(ctx, sess, source, started, &finished, func() { s.running.end(id) })()

	ev := newActionEvents(s.app, id)
	ev.Sink = sess
	// 早退（发生在任何 output 之前）：done 不带 seq（前端直接应用），运行记录落 failed。
	failEarly := func(err error) {
		ev.DoneUnordered(-1, err.Error(), 0)
		finished = true
		s.endRun(sess, -1, err, map[string]string{"exit_code": "-1", "success": "false"})
		if source != nil {
			s.finishScheduleRun(source, source.token, -1, err, time.Since(started))
		}
	}

	// 运行时替换 cwd（用终值 params），替换后检查存在性。
	cwd := runner.Expand(ctx, la.Cwd, params, s.builtins)
	if cwd != "" {
		if _, err := os.Stat(cwd); err != nil {
			failEarly(fmt.Errorf("工作目录不存在: %s", cwd))
			return
		}
	}

	r, err := actionrun.Build(ctx, la, s.runDeps, actionrun.Options{Params: params, ADBControl: ctrl})
	if err != nil {
		failEarly(err)
		return
	}
	protocol := "script"
	if la.Def.Command.Adb.Operation != "" {
		protocol = "adb"
	}
	emit := runner.WithoutTreeHMI(ev.EmitFunc(), protocol)
	if la.Def.HMI != nil && la.Def.HMI.Tree != nil {
		emit = runner.WithTreeSource(ev.EmitFunc(), runner.TreeSource{
			ActionID: id, Params: params, Protocol: protocol,
		})
	}
	res := r.Run(ctx, params, emit)

	ev.Done(res.ExitCode, errStr(res.Err), res.Duration, nil)
	finished = true
	s.endRun(sess, res.ExitCode, res.Err, res.Outputs)
	if source != nil {
		s.finishScheduleRun(source, source.token, res.ExitCode, res.Err, res.Duration)
	}
}

// ——— AI 任务的执行（列表与 CRUD 在 ai.go；对标上面的动作执行路径）———

// RunAi 按 id 启动 AI 任务，输出通过 ai:<id>:* 事件推送。
// params 是本次输入：已声明参数的值 + 保留运行参数 prompt/system/resume，原样交给
// airun.Build（不做 ${VAR} 预展开——用户在输入框里写什么就进什么模板）。
func (s *Service) RunAi(id string, params map[string]any) error {
	return s.runAi(id, params, nil)
}

func (s *Service) runAi(id string, params map[string]any, source *runSource) error {
	lt, ok := s.aiRegistry().Get(id)
	if !ok {
		return fmt.Errorf("未知 AI 任务 %q", id)
	}
	ctx, ok := s.aiRunning.begin(id)
	if !ok {
		return s.onTargetBusy(target.AI, id, params, source)
	}
	sess := s.beginRun(target.AI, id, params, source)
	s.beginScheduledRun(source)

	go s.executeAi(ctx, id, lt, params, source, sess)
	return nil
}

// CancelAi 取消正在运行的 AI 任务。任务若正被某个 workflow 的 ai step 占用，
// 取消的是那个步骤本身（步骤失败，workflow 随之停止）。
func (s *Service) CancelAi(id string) {
	s.aiRunning.cancel(id)
}

// executeAi 在独立 goroutine 里执行 AI 任务（事件协议见 events.go 的 newAiEvents）：
// 构造 runner → 运行 → done 事件（带终点读数）。
// executeAi 在独立 goroutine 里执行 AI 任务（事件协议见 events.go 的 newAiEvents）：
// 构造 runner → 运行 → done 事件（带终点读数）→ 运行记录终态（含本次注入的守则全文）。
func (s *Service) executeAi(ctx context.Context, id string, lt ai.LoadedTask, params map[string]any, source *runSource, sess *runstore.Session) {
	started := time.Now()
	finished := false
	// 兜底同 execute。
	defer s.settleRun(ctx, sess, source, started, &finished, func() { s.aiRunning.end(id) })()

	ev := newAiEvents(s.app, id)
	ev.Sink = sess
	res, rules := airun.Run(ctx, lt, s.aiDeps, airun.Options{
		Params: params,
		Global: s.GetGlobalConfig(),
	}, ev.EmitFunc())
	sess.SetRules(rules)

	// 终点读数（cost/tokens/session_id）随 done 事件下发，聊天页终点展示。
	var readout map[string]any
	if len(res.Outputs) > 0 {
		readout = airun.Readout(res.Outputs, res.Duration)
	}
	ev.Done(res.ExitCode, errStr(res.Err), res.Duration, readout)
	finished = true
	s.endRun(sess, res.ExitCode, res.Err, res.Outputs)
	if source != nil {
		s.finishScheduleRun(source, source.token, res.ExitCode, res.Err, res.Duration)
	}
}

// aiStepRun 构造 workflow 中 ai step 的执行回调（对标 actionrun.WorkflowCallbacks）。
//   - 占目标锁：与手动运行共用 aiRunning。撞锁立即失败、不等待。
//   - ctx 派生自工作流 ctx：取消工作流或 CancelAi 都会终止该步骤。
//   - 执行段是 airun.Step，与 CLI / 执行器路径同一份；step 的 workflow+step env 在那里展开。
//   - 不发 ai:<id>:*：输出带步骤归属落在 workflow:<wf-id>:output 上。
func (s *Service) aiStepRun(wfCtx context.Context, merged map[string]any) workflow.AIRunFunc {
	return func(req workflow.AIRequest) runner.Result {
		fail := func(err error) runner.Result {
			req.Emit("stderr", err.Error())
			return runner.Result{ExitCode: -1, Err: err,
				Outputs: map[string]string{"exit_code": "-1", "success": "false"}}
		}
		lt, ok := s.aiRegistry().Get(req.TaskID)
		if !ok {
			return fail(fmt.Errorf("未知 AI 任务 %q", req.TaskID))
		}
		ctx, ok := s.aiRunning.beginChild(req.TaskID, wfCtx)
		if !ok {
			return fail(fmt.Errorf("AI 任务 %q 正在运行，步骤不等待", req.TaskID))
		}
		defer s.aiRunning.end(req.TaskID)

		// AI 步骤不单独留运行记录：它是工作流这次运行的一步，输出带步骤归属落在
		// 父工作流的运行日志里。
		return airun.Step(ctx, lt, s.aiDeps, airun.Options{Global: s.GetGlobalConfig()}, req, merged, req.Emit)
	}
}
