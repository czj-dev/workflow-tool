package api

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"workflow-tool/internal/registry"
	"workflow-tool/internal/runstore"
	"workflow-tool/internal/schedule"
	"workflow-tool/internal/workflow"
)

func TestScheduledActionCompletionUpdatesLastRun(t *testing.T) {
	svc, _ := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}

	if err := svc.launchSchedule(context.Background(), schedule.Definition{
		ID: "check", Name: "Check", Enabled: true, Cron: "* * * * *", Action: "patrol",
	}); err != nil {
		t.Fatal(err)
	}

	item := waitForSchedule(t, svc, "check", func(item ScheduleItem) bool {
		return item.LastRun != nil && !item.Running
	})
	if item.LastRun.Status != runstore.StatusSucceeded || item.LastRun.ExitCode != 0 || item.LastRun.StartedAt == "" || item.LastRun.FinishedAt == "" || item.LastRun.Duration == "" || item.LastRun.Error != "" {
		t.Fatalf("unexpected action last run: %+v", item.LastRun)
	}
	// 最近结果连着它的运行记录：卡片从这里进运行详情
	if !strings.HasPrefix(item.LastRun.RunID, "r") {
		t.Fatalf("last run is not linked to a run record: %+v", item.LastRun)
	}
	if item.LastSkip != nil {
		t.Fatalf("a real run must not register as a skip: %+v", item.LastSkip)
	}
}

func TestScheduledWorkflowCompletionUpdatesLastRun(t *testing.T) {
	svc, _ := scheduleService(t, "")
	input := validSchedule()
	input.TargetKind, input.TargetID = "workflow", "daily"
	if _, err := svc.SaveSchedule(input); err != nil {
		t.Fatal(err)
	}

	if err := svc.launchSchedule(context.Background(), schedule.Definition{
		ID: "check", Name: "Check", Enabled: true, Cron: "* * * * *", Workflow: "daily",
	}); err != nil {
		t.Fatal(err)
	}

	item := waitForSchedule(t, svc, "check", func(item ScheduleItem) bool {
		return item.LastRun != nil && !item.Running
	})
	if item.LastRun.Status != runstore.StatusSucceeded || item.LastRun.ExitCode != 0 || item.LastRun.StartedAt == "" || item.LastRun.FinishedAt == "" || item.LastRun.Duration == "" || item.LastRun.Error != "" {
		t.Fatalf("unexpected workflow last run: %+v", item.LastRun)
	}
}

// 调度到点撞上正在运行的目标：记为跳过——留档并注明原因，不覆盖上一次真实运行的结果。
func TestScheduledConflictIsSkippedAndKeepsLastRun(t *testing.T) {
	svc, _ := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	def := schedule.Definition{ID: "check", Name: "Check", Enabled: true, Cron: "* * * * *", Action: "patrol"}
	if err := svc.launchSchedule(context.Background(), def); err != nil {
		t.Fatal(err)
	}
	before := waitForSchedule(t, svc, "check", func(item ScheduleItem) bool {
		return item.LastRun != nil && !item.Running
	}).LastRun
	if before.RunID == "" {
		t.Fatalf("real run left no run record: %+v", before)
	}

	if _, ok := svc.running.begin("patrol"); !ok {
		t.Fatal("cannot reserve action")
	}
	defer svc.running.end("patrol")

	// 跳过不是失败：到点回调不返回错误
	if err := svc.launchSchedule(context.Background(), def); err != nil {
		t.Fatalf("a skipped schedule must not fail: %v", err)
	}
	item := svc.ListSchedules().Schedules[0]
	if item.Running {
		t.Fatalf("skipped schedule reported as running: %+v", item)
	}
	if item.LastRun.Status != before.Status || item.LastRun.RunID != before.RunID {
		t.Fatalf("skip overwrote the previous real result: %+v", item.LastRun)
	}
	if item.LastSkip == nil || item.LastSkip.At == "" || !strings.Contains(item.LastSkip.Reason, "正在运行") {
		t.Fatalf("skip not reported on the schedule: %+v", item.LastSkip)
	}
	// 留档：一条 skipped 运行记录，带调度归属与原因
	runs := svc.ListRuns(RunFilter{TargetKind: "action", TargetID: "patrol"}).Runs
	if len(runs) != 2 || runs[0].Status != runstore.StatusSkipped || runs[0].Origin != runstore.OriginSchedule ||
		runs[0].ScheduleID != "check" || !strings.Contains(runs[0].Reason, "正在运行") || runs[0].ID != item.LastSkip.RunID {
		t.Fatalf("skipped run not recorded: %+v", runs)
	}
	if events, _ := svc.GetRunEvents(runs[0].ID); len(events) != 0 {
		t.Fatalf("a skipped run has no output to replay: %+v", events)
	}
	// 下一次真实运行开始即清掉跳过标记（卡片只说明最近一次到点）
	svc.running.end("patrol")
	if err := svc.launchSchedule(context.Background(), def); err != nil {
		t.Fatal(err)
	}
	after := waitForSchedule(t, svc, "check", func(item ScheduleItem) bool {
		return item.LastRun != nil && !item.Running
	})
	if after.LastSkip != nil || after.LastRun.RunID == before.RunID {
		t.Fatalf("new real run did not clear the skip: %+v", after)
	}
}

func TestScheduledAIConflictIsSkipped(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	input := ScheduleInput{ID: "nightly", Name: "Nightly", Enabled: true, Cron: "0 2 * * *", TargetKind: "ai", TargetID: "t-ask",
		Params: map[string]any{"TOPIC": "crash"}}
	if _, err := svc.SaveSchedule(input); err != nil {
		t.Fatal(err)
	}
	if _, ok := svc.aiRunning.begin("t-ask"); !ok {
		t.Fatal("cannot reserve AI task")
	}
	defer svc.aiRunning.end("t-ask")

	if err := svc.launchSchedule(context.Background(), schedule.Definition{
		ID: "nightly", Name: "Nightly", Enabled: true, Cron: "0 2 * * *", AI: "t-ask", Params: input.Params,
	}); err != nil {
		t.Fatalf("a skipped schedule must not fail: %v", err)
	}
	runs := svc.ListRuns(RunFilter{TargetKind: "ai"}).Runs
	if len(runs) != 1 || runs[0].Status != runstore.StatusSkipped || runs[0].TargetID != "t-ask" || runs[0].Params["TOPIC"] != "crash" {
		t.Fatalf("skipped AI run not recorded: %+v", runs)
	}
}

func TestScheduledLaunchFailureUpdatesLastRunAndLeavesARunRecord(t *testing.T) {
	svc, _ := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	// 绕过保存校验直接发起：目标已被卸载，运行开始前就失败
	if err := svc.launchSchedule(context.Background(), schedule.Definition{
		ID: "check", Name: "Check", Enabled: true, Cron: "* * * * *", Action: "gone",
	}); err == nil || !strings.Contains(err.Error(), "gone") {
		t.Fatalf("expected launch failure: %v", err)
	}
	item := svc.ListSchedules().Schedules[0]
	if item.Running || item.LastRun == nil || item.LastRun.Status != "failed" || item.LastRun.Error == "" || item.LastRun.ExitCode != -1 {
		t.Fatalf("unexpected start failure state: %+v", item)
	}
	// 启动失败也是一次运行的事实：留一条 failed 记录，卡片从它进运行详情
	runs := svc.ListRuns(RunFilter{TargetID: "gone"}).Runs
	if len(runs) != 1 || runs[0].Status != runstore.StatusFailed || runs[0].Origin != runstore.OriginSchedule ||
		runs[0].ScheduleID != "check" || runs[0].ID != item.LastRun.RunID {
		t.Fatalf("launch failure not recorded: %+v", runs)
	}
}

func TestScheduledStartFailureDoesNotOverwriteActiveRun(t *testing.T) {
	svc, _ := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	if started := svc.startScheduleRunWithID("check", ""); started == nil {
		t.Fatal("scheduled run did not start")
	}
	before := svc.ListSchedules().Schedules[0].LastRun.StartedAt

	svc.failScheduleStart(schedule.Definition{ID: "check", Action: "patrol"}, runstore.OriginSchedule, errors.New("action already running"))

	item := svc.ListSchedules().Schedules[0]
	if !item.Running || item.LastRun == nil || item.LastRun.Status != "running" {
		t.Fatalf("start failure overwrote active run: %+v", item)
	}
	if item.LastRun.StartedAt != before {
		t.Fatalf("active run start time changed: %+v", item.LastRun)
	}
}

// 运行中的调度最近结果就连着它的运行记录：调度发起的运行前端没有输出捕获，
// 界面靠它进运行详情实时跟踪。
func TestInFlightScheduleRunLinksToItsRunRecord(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	input := ScheduleInput{ID: "slow", Name: "Slow", Enabled: true, Cron: "0 2 * * *", TargetKind: "ai", TargetID: "t-block"}
	if _, err := svc.SaveSchedule(input); err != nil {
		t.Fatal(err)
	}
	if err := svc.RunScheduleNow("slow"); err != nil {
		t.Fatal(err)
	}
	item := waitForSchedule(t, svc, "slow", func(item ScheduleItem) bool { return item.Running })
	if item.LastRun == nil || item.LastRun.Status != runstore.StatusRunning || !strings.HasPrefix(item.LastRun.RunID, "r") {
		t.Fatalf("in-flight last run is not linked to its run record: %+v", item.LastRun)
	}
	svc.CancelAi("t-block")
	done := waitForSchedule(t, svc, "slow", func(item ScheduleItem) bool { return item.LastRun != nil && !item.Running })
	if done.LastRun.RunID != item.LastRun.RunID || done.LastRun.Status != runstore.StatusCancelled {
		t.Fatalf("finished last run lost its run link or status: %+v", done.LastRun)
	}
}

func TestManualRunDoesNotWriteScheduleState(t *testing.T) {
	svc, _ := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	if err := svc.RunAction("patrol", nil); err != nil {
		t.Fatal(err)
	}
	waitForSchedule(t, svc, "check", func(item ScheduleItem) bool { return !item.Running })
	if item := svc.ListSchedules().Schedules[0]; item.LastRun != nil || item.Running {
		t.Fatalf("manual run changed schedule state: %+v", item)
	}
}

func TestStaleScheduleCompletionDoesNotOverwriteNewRun(t *testing.T) {
	svc, _ := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	first := svc.startScheduleRunWithID("check", "")
	second := svc.startScheduleRunWithID("check", "")
	if first == nil || second == nil || first.token == second.token {
		t.Fatalf("expected distinct schedule run tokens: first=%+v second=%+v", first, second)
	}
	svc.finishScheduleRun(first.source, first.token, 0, nil, time.Second)
	item := svc.ListSchedules().Schedules[0]
	if !item.Running || item.LastRun == nil || item.LastRun.Status != "running" {
		t.Fatalf("stale completion overwrote active run: %+v", item)
	}
	svc.finishScheduleRun(second.source, second.token, 0, nil, 2*time.Second)
	item = svc.ListSchedules().Schedules[0]
	if item.Running || item.LastRun == nil || item.LastRun.Duration != "2s" {
		t.Fatalf("current completion not applied: %+v", item)
	}
}

func TestServiceSchedulerLifecycle(t *testing.T) {
	svc, _ := scheduleService(t, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := svc.ServiceStartup(ctx, application.ServiceOptions{}); err != nil {
		t.Fatal(err)
	}
	if svc.schedulerCancel == nil {
		t.Fatal("scheduler did not start")
	}
	if err := svc.ServiceShutdown(); err != nil {
		t.Fatal(err)
	}
	if svc.schedulerCancel != nil {
		t.Fatal("scheduler cancellation was not cleared")
	}
}

func waitForSchedule(t *testing.T, svc *Service, id string, ready func(ScheduleItem) bool) ScheduleItem {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		result := svc.ListSchedules()
		for _, item := range result.Schedules {
			if item.ID == id && ready(item) {
				return item
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("schedule %q did not reach expected state: %+v", id, svc.ListSchedules())
	return ScheduleItem{}
}

var _ = filepath.Separator
var _ = registry.Registry{}
var _ = workflow.WorkflowRegistry{}
