package api

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"workflow-tool/internal/applog"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/runstore"
	"workflow-tool/internal/schedule"
	"workflow-tool/internal/workflow"
)

// 运行记录（M3）：每次运行不论来源都留下运行记录与运行日志。

// newRunSvc 建一个带 ok / fail / sleep 三个动作与 s-loop 工作流的 service。
func newRunSvc(t *testing.T) (*Service, string) {
	t.Helper()
	dir := t.TempDir()
	write := func(rel, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, rel)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, rel), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("actions/ok.yaml", "id: ok\ntitle: OK\ncommand:\n  run: echo hello\n")
	write("actions/fail.yaml", "id: fail\ntitle: Fail\ncommand:\n  run: echo boom 1>&2; exit 3\n")
	write("actions/sleep.yaml", "id: sleep\ntitle: Sleep\ncommand:\n  run: sleep 30\n")
	write("workflows/loop.yaml", "id: loop\ntitle: Loop\nsteps:\n  - run: echo step-one\n  - sleep: 1\n")
	svc := New(registry.Load(filepath.Join(dir, "actions"), dir), workflow.Load(filepath.Join(dir, "workflows")),
		dir, filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
	if len(svc.ListActions().Actions) != 3 || len(svc.ListWorkflows().Workflows) != 1 {
		t.Fatalf("动作/工作流未按预期加载： %+v %+v", svc.ListActions(), svc.ListWorkflows())
	}
	return svc, dir
}

// waitRuns 轮询到运行记录条数达到 want 且 ready 为真，返回最新在前的列表。
func waitRuns(t *testing.T, svc *Service, want int, ready func([]RunItem) bool) []RunItem {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		runs := svc.ListRuns(RunFilter{}).Runs
		if len(runs) >= want && ready(runs) {
			return runs
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("运行记录未达到预期状态（want %d）: %+v", want, svc.ListRuns(RunFilter{}).Runs)
	return nil
}

func settledRun(r RunItem) bool {
	return r.Status != runstore.StatusRunning
}

func allSettled(runs []RunItem) bool {
	for _, r := range runs {
		if !settledRun(r) {
			return false
		}
	}
	return true
}

func TestManualActionRunIsRecordedWithEventLog(t *testing.T) {
	svc, _ := newRunSvc(t)
	if err := svc.RunAction("ok", map[string]any{"device": "active"}); err != nil {
		t.Fatal(err)
	}
	runs := waitRuns(t, svc, 1, allSettled)
	got := runs[0]
	if got.TargetKind != "action" || got.TargetID != "ok" || got.Origin != "manual" || got.ScheduleID != "" {
		t.Fatalf("unexpected run item: %+v", got)
	}
	if got.Status != "succeeded" || got.Reason != "" || got.ExitCode != 0 || got.StartedAt == "" || got.FinishedAt == "" {
		t.Fatalf("unexpected outcome: %+v", got)
	}
	if got.Params["device"] != "active" {
		t.Fatalf("params not kept as given: %+v", got.Params)
	}
	detail, err := svc.GetRun(got.ID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.ID != got.ID || detail.Outputs["exit_code"] != "0" || detail.Outputs["success"] != "true" {
		t.Fatalf("unexpected run detail: %+v", detail)
	}
	events, err := svc.GetRunEvents(got.ID)
	if err != nil {
		t.Fatal(err)
	}
	var streams []string
	for _, ev := range events {
		streams = append(streams, ev.Event+":"+ev.Stream)
		if ev.T < 0 {
			t.Fatalf("event without relative timestamp: %+v", ev)
		}
	}
	// 运行日志与前端收到的事件同构：output 行带 stream/line/seq，末尾一条 done
	joined := strings.Join(streams, ",")
	if !strings.Contains(joined, "output:stdout") || !strings.HasSuffix(joined, "done:") {
		t.Fatalf("unexpected event sequence: %v", joined)
	}
	last := events[len(events)-1]
	if last.ExitCode != 0 || last.Duration == "" || last.Seq == 0 {
		t.Fatalf("done event = %+v", last)
	}
	// seq 唯一且递增（done 独占一个号）
	for i := 1; i < len(events); i++ {
		if events[i].Seq <= events[i-1].Seq {
			t.Fatalf("seq not increasing: %+v", events)
		}
	}
}

func TestFailedActionRunIsRecordedWithReasonAndExitCode(t *testing.T) {
	svc, _ := newRunSvc(t)
	if err := svc.RunAction("fail", nil); err != nil {
		t.Fatal(err)
	}
	got := waitRuns(t, svc, 1, allSettled)[0]
	if got.Status != "failed" || got.Reason != "退出码 3" || got.ExitCode != 3 {
		t.Fatalf("unexpected outcome: %+v", got)
	}
	events, _ := svc.GetRunEvents(got.ID)
	hasStderr := false
	for _, ev := range events {
		if ev.Stream == "stderr" && strings.Contains(ev.Line, "boom") {
			hasStderr = true
		}
	}
	if !hasStderr {
		t.Fatalf("stderr line missing from run log: %+v", events)
	}
}

func TestCancelledActionRunIsRecordedAsCancelled(t *testing.T) {
	svc, _ := newRunSvc(t)
	if err := svc.RunAction("sleep", nil); err != nil {
		t.Fatal(err)
	}
	waitRegistered(t, svc.running, "sleep", true)
	svc.CancelAction("sleep")
	got := waitRuns(t, svc, 1, allSettled)[0]
	if got.Status != "cancelled" || got.Reason != "" {
		t.Fatalf("unexpected outcome: %+v", got)
	}
}

func TestManualWorkflowRunIsRecordedWithStepEvents(t *testing.T) {
	svc, _ := newRunSvc(t)
	if err := svc.RunWorkflow("loop", nil); err != nil {
		t.Fatal(err)
	}
	got := waitRuns(t, svc, 1, allSettled)[0]
	if got.TargetKind != "workflow" || got.TargetID != "loop" || got.Origin != "manual" || got.Status != "succeeded" {
		t.Fatalf("unexpected run item: %+v", got)
	}
	events, _ := svc.GetRunEvents(got.ID)
	// 步骤归属随行落盘，运行详情据此把输出分桶回放
	var start, body, done bool
	lastSeq := int64(0)
	for _, ev := range events {
		if ev.Stream == "step-start" && ev.Step == "0" {
			start = true
		}
		if ev.Stream == "stdout" && ev.Line == "step-one" && ev.Step == "0" {
			body = true
		}
		if ev.Event == "done" {
			done = true
		}
		// 工作流的 output 也带递增 seq（与 action / ai 同一契约）：回放与运行中的详情
		// 跟踪据此排序、去重；done 不取号
		if ev.Event == "output" {
			if ev.Seq <= lastSeq {
				t.Fatalf("workflow output seq not increasing: %+v", events)
			}
			lastSeq = ev.Seq
		} else if ev.Seq != 0 {
			t.Fatalf("workflow done must not take a seq: %+v", ev)
		}
	}
	if !start || !body || !done {
		t.Fatalf("step attribution missing from run log: %+v", events)
	}
}

func TestScheduledRunIsRecordedWithScheduleAndOrigin(t *testing.T) {
	svc, _ := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	if err := svc.launchSchedule(context.Background(), schedule.Definition{
		ID: "check", Name: "Check", Enabled: true, Cron: "* * * * *", Action: "patrol", Params: map[string]any{"device": "active"},
	}); err != nil {
		t.Fatal(err)
	}
	got := waitRuns(t, svc, 1, allSettled)[0]
	if got.TargetKind != "action" || got.TargetID != "patrol" || got.Origin != "schedule" || got.ScheduleID != "check" {
		t.Fatalf("unexpected run item: %+v", got)
	}
	if got.Params["device"] != "active" || got.Status != "succeeded" {
		t.Fatalf("params/status not kept: %+v", got)
	}
}

func TestRunScheduleNowIsRecordedAsRunNow(t *testing.T) {
	svc, _ := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	if err := svc.RunScheduleNow("check"); err != nil {
		t.Fatal(err)
	}
	got := waitRuns(t, svc, 1, allSettled)[0]
	if got.Origin != "run-now" || got.ScheduleID != "check" || got.Status != "succeeded" {
		t.Fatalf("unexpected run item: %+v", got)
	}
}

func TestListRunsFiltersByTargetStatusAndOrigin(t *testing.T) {
	svc, _ := newRunSvc(t)
	_ = svc.RunAction("ok", nil)
	_ = svc.RunAction("fail", nil)
	_ = svc.RunWorkflow("loop", nil)
	waitRuns(t, svc, 3, allSettled)
	got := svc.ListRuns(RunFilter{TargetKind: "action"})
	if len(got.Runs) != 2 {
		t.Fatalf("kind filter = %+v", got.Runs)
	}
	if got := svc.ListRuns(RunFilter{TargetKind: "action", TargetID: "fail"}); len(got.Runs) != 1 || got.Runs[0].TargetID != "fail" {
		t.Fatalf("target filter = %+v", got.Runs)
	}
	if got := svc.ListRuns(RunFilter{Status: "failed"}); len(got.Runs) != 1 || got.Runs[0].TargetID != "fail" {
		t.Fatalf("status filter = %+v", got.Runs)
	}
	if got := svc.ListRuns(RunFilter{Status: "succeeded"}); len(got.Runs) != 2 {
		t.Fatalf("status filter = %+v", got.Runs)
	}
	if got := svc.ListRuns(RunFilter{Origin: "schedule"}); len(got.Runs) != 0 {
		t.Fatalf("origin filter = %+v", got.Runs)
	}
	// 倒序：最新在前
	all := svc.ListRuns(RunFilter{}).Runs
	for i := 1; i < len(all); i++ {
		if all[i-1].StartedAt < all[i].StartedAt {
			t.Fatalf("not newest first: %+v", all)
		}
	}
	if got := svc.ListRuns(RunFilter{Limit: 2}); len(got.Runs) != 2 {
		t.Fatalf("limit = %+v", got.Runs)
	}
}

func TestGetRunRejectsUnknownID(t *testing.T) {
	svc, _ := newRunSvc(t)
	_ = svc.RunAction("ok", nil)
	waitRuns(t, svc, 1, allSettled)
	if _, err := svc.GetRun("r20260101-000000-nope"); err == nil {
		t.Fatal("unknown run id must not resolve")
	}
	if _, err := svc.GetRun("../etc"); err == nil {
		t.Fatal("path traversal must not resolve")
	}
	if events, err := svc.GetRunEvents("r20260101-000000-nope"); err != nil || len(events) != 0 {
		t.Fatalf("events of unknown run = %v, %v", events, err)
	}
}

func TestStartupMarksStaleRunningRecordsInterrupted(t *testing.T) {
	_, dir := newRunSvc(t)
	// 人为造一条上次遗留的 running 记录
	id := "r20261125-021500-a1b2c3"
	runDir := filepath.Join(dir, "runs", id)
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"id":"` + id + `","target":{"kind":"ai","id":"review-bot"},"origin":"manual","params":{},"status":"running","reason":"","started_at":"2026-11-25T02:15:00+08:00"}`
	if err := os.WriteFile(filepath.Join(runDir, "run.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	// 重新打开同一目录：等同应用下次启动
	reopened := New(registry.Load(filepath.Join(dir, "actions"), dir), workflow.Load(filepath.Join(dir, "workflows")),
		dir, filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
	got := reopened.ListRuns(RunFilter{}).Runs
	if len(got) != 1 || got[0].ID != id || got[0].Status != "interrupted" || got[0].Reason == "" {
		t.Fatalf("stale running record = %+v", got)
	}
	if got[0].FinishedAt != "" {
		t.Fatalf("interrupted run must not invent a finish time: %+v", got[0])
	}
	// 启动对账只做一次：再启动时它已是终态，不被二次改写
	again := New(registry.Load(filepath.Join(dir, "actions"), dir), workflow.Load(filepath.Join(dir, "workflows")),
		dir, filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
	if got := again.ListRuns(RunFilter{}).Runs; got[0].Status != "interrupted" || got[0].Reason != reopened.ListRuns(RunFilter{}).Runs[0].Reason {
		t.Fatalf("interrupted record rewritten: %+v", got)
	}
}

func TestAppLogRecordsScheduleLifecycle(t *testing.T) {
	svc, schedulePath := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	if err := svc.launchSchedule(context.Background(), schedule.Definition{
		ID: "check", Name: "Check", Enabled: true, Cron: "* * * * *", Action: "patrol",
	}); err != nil {
		t.Fatal(err)
	}
	waitRuns(t, svc, 1, allSettled)
	logData, err := os.ReadFile(filepath.Join(filepath.Dir(schedulePath), applog.DirName, applog.FileName))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"event":"schedule.trigger"`, `"schedule_id":"check"`, `"run_id":"r`} {
		if !strings.Contains(string(logData), want) {
			t.Fatalf("app log lacks %s: %s", want, logData)
		}
	}
}

func TestRunsChangedIsEmittedOnStartAndFinish(t *testing.T) {
	svc, _ := newRunSvc(t)
	var mu sync.Mutex
	var emitted []string
	svc.emitEvent = func(name string, data any) {
		mu.Lock()
		defer mu.Unlock()
		payload, _ := json.Marshal(data)
		emitted = append(emitted, name+" "+string(payload))
	}
	if err := svc.RunAction("ok", nil); err != nil {
		t.Fatal(err)
	}
	waitRuns(t, svc, 1, allSettled)
	// emit 是同步调用的，等 done 事件之后收尾
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		done := len(emitted) >= 2
		mu.Unlock()
		if done {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(emitted) < 2 {
		t.Fatalf("runs:changed not emitted: %v", emitted)
	}
	if !strings.Contains(emitted[0], `"status":"running"`) || !strings.Contains(emitted[len(emitted)-1], `"status":"succeeded"`) {
		t.Fatalf("unexpected runs:changed payloads: %v", emitted)
	}
}

func TestNilRunStoreStillRuns(t *testing.T) {
	svc, _ := newRunSvc(t)
	svc.runs = nil
	if err := svc.RunAction("ok", nil); err != nil {
		t.Fatal(err)
	}
	waitRegistered(t, svc.running, "ok", false)
	if got := svc.ListRuns(RunFilter{}).Runs; len(got) != 0 {
		t.Fatalf("nil store listed runs: %+v", got)
	}
}

func TestRunRecordsCarryTheProcessStartTime(t *testing.T) {
	svc, _ := newRunSvc(t)
	if err := svc.RunAction("ok", nil); err != nil {
		t.Fatal(err)
	}
	got := waitRuns(t, svc, 1, allSettled)[0]
	detail, err := svc.GetRun(got.ID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.ProcessMode != "in-app" || detail.ProcessPID != os.Getpid() || detail.ProcessStartedAt == "" {
		t.Fatalf("process info not archived: %+v", detail)
	}
	if _, err := time.Parse(time.RFC3339Nano, detail.ProcessStartedAt); err != nil {
		t.Fatalf("process start time is not a timestamp: %q", detail.ProcessStartedAt)
	}
}

// runs:changed 的 payload 始终带目标：开始与结束两条都够订阅方判断「哪个目标在变」。
func TestRunsChangedPayloadAlwaysCarriesTheTarget(t *testing.T) {
	svc, _ := newRunSvc(t)
	var mu sync.Mutex
	var payloads []map[string]any
	svc.emitEvent = func(name string, data any) {
		if name != "runs:changed" {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		payloads = append(payloads, data.(map[string]any))
	}
	if err := svc.RunWorkflow("loop", nil); err != nil {
		t.Fatal(err)
	}
	waitRuns(t, svc, 1, allSettled)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		enough := len(payloads) >= 2
		mu.Unlock()
		if enough {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(payloads) < 2 {
		t.Fatalf("runs:changed not emitted on start and finish: %v", payloads)
	}
	var runID string
	for i, want := range []string{"running", "succeeded"} {
		p := payloads[i]
		if p["status"] != want || p["target_kind"] != "workflow" || p["target_id"] != "loop" {
			t.Fatalf("payload %d = %v, want status %s with the target", i, p, want)
		}
		if i == 0 {
			runID, _ = p["run_id"].(string)
		} else if p["run_id"] != runID || runID == "" {
			t.Fatalf("start and finish must name the same run: %v", payloads)
		}
	}
}
