// runs.go：运行记录（M3）。两部分：
//   - 查询 API：ListRuns / GetRun / GetRunEvents，供前端「运行记录」列表与运行详情；
//   - 接入点：beginRun / settleRun / endRun（三条执行路径共用）与 onTargetBusy（撞上运行中
//     目标的处置）。
//
// 执行路径本身在 run.go / workflows.go，调度在 schedules.go；事件契约与运行日志的落盘点
// 在 events.go。
package api

import (
	"context"
	"errors"
	"fmt"
	"time"

	"workflow-tool/internal/runstore"
	"workflow-tool/internal/target"
)

// RunFilter 是运行记录列表的筛选条件；空串与 0 表示不限。
type RunFilter struct {
	TargetKind string `json:"targetKind"`
	TargetID   string `json:"targetId"`
	Status     string `json:"status"`
	Origin     string `json:"origin"`
	Limit      int    `json:"limit"`
}

// RunItem 是一条运行记录的摘要：结论性事实、输入与读数类产出。正文类产出
// （text / thinking / stdout / stderr）与守则全文只在 RunDetail 里。
type RunItem struct {
	ID         string `json:"id"`
	TargetKind string `json:"targetKind"`
	TargetID   string `json:"targetId"`
	Origin     string `json:"origin"`
	ScheduleID string `json:"scheduleId"`
	Status     string `json:"status"`
	Reason     string `json:"reason"`
	StartedAt  string `json:"startedAt"`
	// FinishedAt 为空 = 尚未结束，或中断（结束时刻不可知）。
	FinishedAt string `json:"finishedAt"`
	// ExitCode 没有有效退出码时为 -1（跳过、启动失败、中断、构造阶段失败）。
	ExitCode int            `json:"exitCode"`
	Params   map[string]any `json:"params"`
	// Outputs 只含读数类的产出（session_id / cost_usd / tokens / exit_code / success）。
	Outputs map[string]string `json:"outputs"`
}

// RunDetail 是完整的运行记录：RunItem 之外再带正文类产出、守则全文与进程信息。
type RunDetail struct {
	ID          string            `json:"id"`
	TargetKind  string            `json:"targetKind"`
	TargetID    string            `json:"targetId"`
	Origin      string            `json:"origin"`
	ScheduleID  string            `json:"scheduleId"`
	Status      string            `json:"status"`
	Reason      string            `json:"reason"`
	StartedAt   string            `json:"startedAt"`
	FinishedAt  string            `json:"finishedAt"`
	ExitCode    int               `json:"exitCode"`
	Params      map[string]any    `json:"params"`
	Outputs     map[string]string `json:"outputs"`
	Rules       string            `json:"rules"`
	ProcessMode string            `json:"processMode"`
	ProcessPID  int               `json:"processPid"`
	// ProcessStartedAt 是承载这次运行的进程的启动时刻（认领时与 pid 一起核对进程身份）。
	ProcessStartedAt string `json:"processStartedAt"`
}

// RunListResult 是 ListRuns 的返回值，最新在前。
type RunListResult struct {
	Runs []RunItem `json:"runs"`
}

// ListRuns 按启动时间倒序返回运行记录，可按目标、状态、来源筛选。
func (s *Service) ListRuns(filter RunFilter) RunListResult {
	recs := s.runs.List(runstore.Filter{
		TargetKind: target.Kind(filter.TargetKind),
		TargetID:   filter.TargetID,
		Status:     filter.Status,
		Origin:     filter.Origin,
		Limit:      filter.Limit,
	})
	items := make([]RunItem, 0, len(recs))
	for _, rec := range recs {
		items = append(items, toRunItem(rec))
	}
	return RunListResult{Runs: items}
}

// GetRun 返回一条完整的运行记录（含产出与守则全文）。
func (s *Service) GetRun(id string) (RunDetail, error) {
	rec, err := s.runs.Get(id)
	if errors.Is(err, runstore.ErrNotFound) {
		return RunDetail{}, fmt.Errorf("未知的运行记录 %q", id)
	}
	if err != nil {
		return RunDetail{}, err
	}
	item := toRunItem(rec)
	detail := RunDetail{
		ID: item.ID, TargetKind: item.TargetKind, TargetID: item.TargetID, Origin: item.Origin,
		ScheduleID: item.ScheduleID, Status: item.Status, Reason: item.Reason, StartedAt: item.StartedAt,
		FinishedAt: item.FinishedAt, ExitCode: item.ExitCode, Params: item.Params,
		Outputs: rec.Outputs, Rules: rec.Rules,
	}
	if detail.Outputs == nil {
		detail.Outputs = map[string]string{}
	}
	if rec.Process != nil {
		detail.ProcessMode, detail.ProcessPID, detail.ProcessStartedAt = rec.Process.Mode, rec.Process.PID, rec.Process.StartedAt
	}
	return detail, nil
}

// GetRunEvents 返回一条运行的运行日志（运行详情据此回放）。跳过与启动失败的运行
// 没有日志，返回空数组。
func (s *Service) GetRunEvents(id string) ([]runstore.Event, error) {
	if s.runs == nil {
		return []runstore.Event{}, nil
	}
	events, err := s.runs.Events(id)
	if errors.Is(err, runstore.ErrNotFound) {
		return nil, fmt.Errorf("未知的运行记录 %q", id)
	}
	if err != nil {
		return nil, err
	}
	if events == nil {
		events = []runstore.Event{}
	}
	return events, nil
}

// toRunItem 把存储层的记录转成前端摘要。时间用 RFC3339Nano 下发。
func toRunItem(rec runstore.Record) RunItem {
	item := RunItem{
		ID:         rec.ID,
		TargetKind: string(rec.Target.Kind),
		TargetID:   rec.Target.ID,
		Origin:     rec.Origin,
		ScheduleID: rec.ScheduleID,
		Status:     rec.Status,
		Reason:     rec.Reason,
		StartedAt:  rec.StartedAt.Format(time.RFC3339Nano),
		ExitCode:   -1,
		Params:     rec.Params,
		Outputs:    rec.Outputs,
	}
	if rec.FinishedAt != nil {
		item.FinishedAt = rec.FinishedAt.Format(time.RFC3339Nano)
	}
	if rec.ExitCode != nil {
		item.ExitCode = *rec.ExitCode
	}
	if item.Params == nil {
		item.Params = map[string]any{}
	}
	if item.Outputs == nil {
		item.Outputs = map[string]string{}
	}
	return item
}

// ——— 接入点：三条执行路径（动作 / 工作流 / AI 任务）共用 ———

// beginRun 为一次顶层运行建立运行记录。发起来源由 source 决定（nil = 手动运行）；
// params 是本次输入，原样留存（含保留运行参数）。
// 记录建不出来时返回 nil 会话并记一条应用日志——运行照常进行，只是没有留档。
func (s *Service) beginRun(kind target.Kind, id string, params map[string]any, source *runSource) *runstore.Session {
	rec := runstore.Record{Target: target.Target{Kind: kind, ID: id}, Origin: runstore.OriginManual, Params: params}
	if source != nil {
		rec.Origin, rec.ScheduleID = source.origin, source.scheduleID
	}
	sess, err := s.runs.Start(rec)
	if err != nil {
		s.appLog.Log("run.start.failed", map[string]any{"target_kind": kind, "target_id": id, "origin": rec.Origin, "error": err.Error()})
		return nil
	}
	if source != nil {
		source.runID = sess.ID()
	}
	s.notify(eventRunsChanged, runsChangedPayload(sess.ID(), runstore.StatusRunning, kind, id))
	return sess
}

// settleRun 是三条执行路径共用的收尾兜底，在执行函数入口处 defer 它的返回值：
//
//	defer s.settleRun(ctx, sess, source, started, &finished, release)()
//
// 正常路径都显式收尾（写运行记录终态、更新调度结果）并把 finished 置真；走到这里的只有
// 意外退出——运行记录与调度状态都要有个交代，最后释放目标锁（release）。
// endRun 对已终结的会话无副作用，所以兜底重复执行是安全的。
func (s *Service) settleRun(ctx context.Context, sess *runstore.Session, source *runSource, started time.Time, finished *bool, release func()) func() {
	return func() {
		s.endRun(sess, -1, ctx.Err(), nil)
		if source != nil && !*finished {
			s.finishScheduleRun(source, source.token, -1, ctx.Err(), time.Since(started))
		}
		release()
	}
}

// endRun 写运行记录的终态并通知前端。sess 为 nil（没有留档）时空操作。
// exitCode 原样落档；err 经 runstore.Outcome 归入状态词汇（取消 / 超时 / 失败）。
func (s *Service) endRun(sess *runstore.Session, exitCode int, err error, outputs map[string]string) {
	if sess == nil {
		return
	}
	status, reason := runstore.Outcome(exitCode, err)
	if sess.Finish(status, reason, &exitCode, outputs) {
		target := sess.Target()
		s.notify(eventRunsChanged, runsChangedPayload(sess.ID(), status, target.Kind, target.ID))
	}
}

// noteRun 留一条没有运行过程的运行记录（跳过 / 启动失败），返回 run-id。
func (s *Service) noteRun(kind target.Kind, id string, params map[string]any, source *runSource, status, reason string) string {
	rec := runstore.Record{Target: target.Target{Kind: kind, ID: id}, Origin: runstore.OriginManual, Params: params}
	if source != nil {
		rec.Origin, rec.ScheduleID = source.origin, source.scheduleID
	}
	sess, err := s.runs.Note(rec, status, reason)
	if err != nil {
		s.appLog.Log("run.note.failed", map[string]any{"target_kind": kind, "target_id": id, "status": status, "error": err.Error()})
		return ""
	}
	s.notify(eventRunsChanged, runsChangedPayload(sess.ID(), status, kind, id))
	return sess.ID()
}

// targetLabel 是错误文案里的目标称谓。workflow 沿用既有文案（前端按「正在运行」识别）。
func targetLabel(kind target.Kind) string {
	switch kind {
	case target.AI:
		return "AI 任务"
	case target.Workflow:
		return "workflow"
	default:
		return "动作"
	}
}

// targetBusyError 是「撞上运行中的目标」。Error() 是给人看的完整文案——launch 据此
// 决定是静默（已留档为跳过）还是把原因返回给发起人，不靠解析文案。
type targetBusyError struct {
	reason  string
	skipped bool // true = 已留档为跳过（调度到点）；false = 原样返回（立即运行）
}

func (e *targetBusyError) Error() string { return e.reason }

// onTargetBusy 是目标正在运行时的处置，按发起来源分流（规格「目标锁与冲突」）：
//   - 手动运行：返回「正在运行」，前端回到该目标的界面；
//   - 立即运行：返回「已在运行，已跳过」，不动调度的最近结果；
//   - 调度到点：留档为跳过并注明原因，不覆盖上一次真实运行的结果。
func (s *Service) onTargetBusy(kind target.Kind, id string, params map[string]any, source *runSource) error {
	if source == nil {
		return fmt.Errorf("%s %q 正在运行", targetLabel(kind), id)
	}
	if source.origin == runstore.OriginRunNow {
		return &targetBusyError{reason: fmt.Sprintf("%s %q 已在运行，已跳过", targetLabel(kind), id)}
	}
	reason := fmt.Sprintf("%s %q 正在运行", targetLabel(kind), id)
	source.runID = s.noteRun(kind, id, params, source, runstore.StatusSkipped, reason)
	s.skipScheduleRun(source.scheduleID, reason, source.runID)
	s.appLog.Log("schedule.skipped", map[string]any{
		"schedule_id": source.scheduleID, "target_kind": kind, "target_id": id, "run_id": source.runID, "reason": reason,
	})
	s.emitScheduleChanged(source.scheduleID)
	return &targetBusyError{reason: reason, skipped: true}
}
