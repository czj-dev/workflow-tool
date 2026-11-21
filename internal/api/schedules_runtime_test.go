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
	if item.LastRun.Status != "success" || item.LastRun.ExitCode != 0 || item.LastRun.StartedAt == "" || item.LastRun.FinishedAt == "" || item.LastRun.Duration == "" || item.LastRun.Error != "" {
		t.Fatalf("unexpected action last run: %+v", item.LastRun)
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
	if item.LastRun.Status != "success" || item.LastRun.ExitCode != 0 || item.LastRun.StartedAt == "" || item.LastRun.FinishedAt == "" || item.LastRun.Duration == "" || item.LastRun.Error != "" {
		t.Fatalf("unexpected workflow last run: %+v", item.LastRun)
	}
}

func TestScheduledStartFailureUpdatesLastRun(t *testing.T) {
	svc, _ := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	if _, ok := svc.running.begin("patrol"); !ok {
		t.Fatal("cannot reserve action")
	}
	defer svc.running.end("patrol")

	if err := svc.launchSchedule(context.Background(), schedule.Definition{
		ID: "check", Name: "Check", Enabled: true, Cron: "* * * * *", Action: "patrol",
	}); err == nil || !strings.Contains(err.Error(), "正在运行") {
		t.Fatalf("expected concurrency rejection: %v", err)
	}
	item := svc.ListSchedules().Schedules[0]
	if item.Running || item.LastRun == nil || item.LastRun.Status != "failed" || item.LastRun.Error == "" || item.LastRun.ExitCode != -1 {
		t.Fatalf("unexpected start failure state: %+v", item)
	}
}

func TestScheduledStartFailureDoesNotOverwriteActiveRun(t *testing.T) {
	svc, _ := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	if started := svc.startScheduleRun("check"); started == nil {
		t.Fatal("scheduled run did not start")
	}
	before := svc.ListSchedules().Schedules[0].LastRun.StartedAt

	svc.failScheduleStart("check", errors.New("action already running"))

	item := svc.ListSchedules().Schedules[0]
	if !item.Running || item.LastRun == nil || item.LastRun.Status != "running" {
		t.Fatalf("start failure overwrote active run: %+v", item)
	}
	if item.LastRun.StartedAt != before {
		t.Fatalf("active run start time changed: %+v", item.LastRun)
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
	first := svc.startScheduleRun("check")
	second := svc.startScheduleRun("check")
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
