package api

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"workflow-tool/internal/registry"
	"workflow-tool/internal/schedule"
	"workflow-tool/internal/workflow"
)

func scheduleService(t *testing.T, dir string) (*Service, string) {
	t.Helper()
	if dir == "" {
		dir = t.TempDir()
	}
	reg := &registry.Registry{Actions: map[string]registry.LoadedAction{"patrol": {Def: registry.ActionDef{ID: "patrol", Title: "Patrol", Command: registry.Command{Run: "echo ok"}}, Timeout: time.Minute}}}
	workflows := &workflow.WorkflowRegistry{Workflows: map[string]workflow.LoadedWorkflow{"daily": {Def: workflow.WorkflowDef{ID: "daily", Title: "Daily", Steps: []workflow.Step{{Sleep: 1}}}}}}
	return New(reg, workflows, dir, filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml")), filepath.Join(dir, "schedules.yaml")
}

func validSchedule() ScheduleInput {
	return ScheduleInput{ID: "check", Name: "Check", Enabled: true, Cron: "7 * * * *", TargetKind: "action", TargetID: "patrol", Params: map[string]any{"device": "active"}}
}

func TestListSchedulesReturnsEmptyWhenFileMissing(t *testing.T) {
	svc, path := scheduleService(t, "")
	got := svc.ListSchedules()
	if len(got.Schedules) != 0 || len(got.Errors) != 0 {
		t.Fatalf("unexpected list: %+v", got)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("list created file: %v", err)
	}
}

func TestSaveSchedulePersistsActionTarget(t *testing.T) {
	svc, path := scheduleService(t, "")
	got, err := svc.SaveSchedule(validSchedule())
	if err != nil || len(got.Schedules) != 1 {
		t.Fatalf("save: %+v %v", got, err)
	}
	data, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(data), "action: patrol") || strings.Contains(string(data), "workflow:") {
		t.Fatalf("file: %q %v", data, err)
	}
	item := svc.ListSchedules().Schedules[0]
	if item.TargetKind != "action" || item.TargetID != "patrol" || item.NextRun == "" || item.Running || item.LastRun != nil {
		t.Fatalf("projection: %+v", item)
	}
}

func TestSaveSchedulePersistsWorkflowTarget(t *testing.T) {
	svc, path := scheduleService(t, "")
	input := validSchedule()
	input.TargetKind = "workflow"
	input.TargetID = "daily"
	got, err := svc.SaveSchedule(input)
	if err != nil || len(got.Schedules) != 1 || got.Schedules[0].TargetKind != "workflow" {
		t.Fatalf("save: %+v %v", got, err)
	}
	data, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(data), "workflow: daily") || strings.Contains(string(data), "action:") {
		t.Fatalf("file: %q %v", data, err)
	}
}

func TestSaveScheduleRejectsUnknownTargetWithoutChangingFile(t *testing.T) {
	svc, path := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	input := validSchedule()
	input.TargetID = "missing"
	if _, err := svc.SaveSchedule(input); err == nil || !strings.Contains(err.Error(), "check") || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("target error: %v", err)
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(before) || svc.ListSchedules().Schedules[0].TargetID != "patrol" {
		t.Fatal("rejected save changed file or memory")
	}
}

func TestSaveScheduleRejectsInvalidInput(t *testing.T) {
	for _, tc := range []struct {
		name, field string
		change      func(*ScheduleInput)
	}{
		{"id", "id", func(i *ScheduleInput) { i.ID = "Bad ID" }},
		{"name", "name", func(i *ScheduleInput) { i.Name = " " }},
		{"cron", "cron", func(i *ScheduleInput) { i.Cron = "bad" }},
		{"target kind", "targetKind", func(i *ScheduleInput) { i.TargetKind = "other" }},
		{"workflow target", "missing", func(i *ScheduleInput) { i.TargetKind = "workflow"; i.TargetID = "missing" }},
		{"params", "params", func(i *ScheduleInput) { i.Params = map[string]any{"bad": make(chan int)} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, path := scheduleService(t, "")
			input := validSchedule()
			tc.change(&input)
			if _, err := svc.SaveSchedule(input); err == nil || !strings.Contains(err.Error(), tc.field) {
				t.Fatalf("want %s error: %v", tc.field, err)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("invalid input created file: %v", err)
			}
		})
	}
}

func TestSaveScheduleUpdatesExistingID(t *testing.T) {
	svc, path := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	input := validSchedule()
	input.Cron = "8 * * * *"
	got, err := svc.SaveSchedule(input)
	if err != nil || len(got.Schedules) != 1 || got.Schedules[0].Cron != input.Cron {
		t.Fatalf("update: %+v %v", got, err)
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "8 * * * *") || strings.Contains(string(data), "7 * * * *") {
		t.Fatalf("old cron persisted: %q", data)
	}
}

func TestScheduleLoadErrorsBlockCRUDWithoutLosingFile(t *testing.T) {
	_, path := scheduleService(t, "")
	invalid := []byte("schedules:\n  - id: check\n    name: Check\n    cron: '* * * * *'\n    action: missing\n")
	if err := os.WriteFile(path, invalid, 0o600); err != nil {
		t.Fatal(err)
	}
	svc, _ := scheduleService(t, filepath.Dir(path))
	if got := svc.ListSchedules(); len(got.Errors) == 0 || !strings.Contains(got.Errors[0], "missing") {
		t.Fatalf("diagnostics: %+v", got)
	}
	if _, err := svc.SaveSchedule(validSchedule()); err == nil {
		t.Fatal("save overwrote invalid file")
	}
	if _, err := svc.DeleteSchedule("check"); err == nil {
		t.Fatal("delete overwrote invalid file")
	}
	if _, err := svc.SetScheduleEnabled("check", false); err == nil {
		t.Fatal("toggle overwrote invalid file")
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(invalid) {
		t.Fatalf("invalid file lost: %q", after)
	}
}

func TestSaveScheduleWriteFailureKeepsActiveSnapshot(t *testing.T) {
	svc, path := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("directory mode enforcement requires unprivileged Unix user")
	}
	if err := os.Chmod(filepath.Dir(path), 0o500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(filepath.Dir(path), 0o700)
	input := validSchedule()
	input.Cron = "8 * * * *"
	if _, err := svc.SaveSchedule(input); err == nil || !strings.Contains(err.Error(), "save schedules") {
		t.Fatalf("expected SaveFile failure, got %v", err)
	}
	got := svc.ListSchedules()
	if len(got.Schedules) != 1 || got.Schedules[0].Cron != "7 * * * *" {
		t.Fatalf("active snapshot changed: %+v", got)
	}
	data, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(data), "7 * * * *") {
		t.Fatalf("failed write modified disk: %q %v", data, err)
	}
}

func TestScheduleParamsAreIsolated(t *testing.T) {
	svc, _ := scheduleService(t, "")
	input := validSchedule()
	input.Params = map[string]any{"device": "initial"}
	if _, err := svc.SaveSchedule(input); err != nil {
		t.Fatal(err)
	}
	input.Params["device"] = "changed"
	item := svc.ListSchedules().Schedules[0]
	item.Params["device"] = "also changed"
	if got := svc.ListSchedules().Schedules[0].Params["device"]; got != "initial" {
		t.Fatalf("params shared: %v", got)
	}
}

func TestDeleteAndToggleSchedule(t *testing.T) {
	svc, path := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	got, err := svc.SetScheduleEnabled("check", false)
	if err != nil || len(got.Schedules) != 1 || got.Schedules[0].Enabled {
		t.Fatalf("toggle: %+v %v", got, err)
	}
	got, err = svc.DeleteSchedule("check")
	if err != nil || len(got.Schedules) != 0 {
		t.Fatalf("delete: %+v %v", got, err)
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "schedules: []") {
		t.Fatalf("file: %q", data)
	}
	if _, err := svc.DeleteSchedule("check"); err == nil || !strings.Contains(err.Error(), "check") {
		t.Fatalf("missing id: %v", err)
	}
}

func TestRunScheduleNowRejectsMissingID(t *testing.T) {
	svc, _ := scheduleService(t, "")
	if err := svc.RunScheduleNow("missing"); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("missing id: %v", err)
	}
}

func TestRunScheduleNowUsesExistingActionLaunch(t *testing.T) {
	svc, _ := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	svc.app = &application.App{}
	_, ok := svc.running.begin("patrol")
	if !ok {
		t.Fatal("cannot reserve action")
	}
	defer svc.running.end("patrol")
	if err := svc.RunScheduleNow("check"); err == nil || !strings.Contains(err.Error(), "正在运行") {
		t.Fatalf("expected concurrency rejection: %v", err)
	}
}

func TestRunScheduleNowUsesExistingWorkflowLaunch(t *testing.T) {
	svc, _ := scheduleService(t, "")
	input := validSchedule()
	input.TargetKind, input.TargetID = "workflow", "daily"
	if _, err := svc.SaveSchedule(input); err != nil {
		t.Fatal(err)
	}
	svc.app = &application.App{}
	if _, ok := svc.wfRunning.begin("daily"); !ok {
		t.Fatal("cannot reserve workflow")
	}
	defer svc.wfRunning.end("daily")
	if err := svc.RunScheduleNow("check"); err == nil || !strings.Contains(err.Error(), "正在运行") {
		t.Fatalf("expected workflow concurrency rejection, got %v", err)
	}
}

func TestScheduleListCopiesLastRunAndDeleteRemovesState(t *testing.T) {
	svc, _ := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	svc.scheduleRuns["check"] = &scheduleRunState{Running: true, LastRun: &LastRun{Status: "running"}}
	item := svc.ListSchedules().Schedules[0]
	if !item.Running || item.LastRun == nil || item.LastRun.Status != "running" {
		t.Fatalf("runtime projection: %+v", item)
	}
	item.LastRun.Status = "changed"
	if svc.ListSchedules().Schedules[0].LastRun.Status != "running" {
		t.Fatal("LastRun pointer leaked")
	}
	if _, err := svc.DeleteSchedule("check"); err != nil {
		t.Fatal(err)
	}
	if len(svc.scheduleRuns) != 0 {
		t.Fatalf("deleted schedule retained state: %v", svc.scheduleRuns)
	}
}

func TestRunScheduleNowHeadlessUpdatesState(t *testing.T) {
	svc, _ := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	if err := svc.RunScheduleNow("check"); err != nil {
		t.Fatalf("headless launch should succeed: %v", err)
	}
	item := waitForSchedule(t, svc, "check", func(item ScheduleItem) bool {
		return item.LastRun != nil && !item.Running
	})
	if item.LastRun.Status != "success" {
		t.Fatalf("unexpected headless last run: %+v", item.LastRun)
	}
}

func TestScheduleStartupLoadsValidFileAndReportsDuplicate(t *testing.T) {
	_, path := scheduleService(t, "")
	body := "schedules:\n  - id: check\n    name: First\n    cron: '7 * * * *'\n    action: patrol\n  - id: check\n    name: Duplicate\n    cron: '* * * * *'\n    action: patrol\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	svc, _ := scheduleService(t, filepath.Dir(path))
	got := svc.ListSchedules()
	if len(got.Schedules) != 1 || got.Schedules[0].Name != "First" || len(got.Errors) != 1 || !strings.Contains(got.Errors[0], "duplicate") {
		t.Fatalf("startup diagnostics: %+v", got)
	}
	if _, err := svc.SaveSchedule(validSchedule()); err == nil {
		t.Fatal("duplicate source silently replaced")
	}
	after, _ := os.ReadFile(path)
	if string(after) != body {
		t.Fatal("duplicate source modified")
	}
}

func TestScheduleServiceRejectsNonFiniteParams(t *testing.T) {
	svc, path := scheduleService(t, "")
	input := validSchedule()
	input.Params = map[string]any{"nested": []any{math.NaN()}}
	if _, err := svc.SaveSchedule(input); err == nil || !strings.Contains(err.Error(), "params") {
		t.Fatalf("nonfinite param accepted: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("invalid params created file: %v", err)
	}
}

func TestSaveScheduleRejectsInvalidActionLiteralProtocol(t *testing.T) {
	for _, param := range []any{
		map[string]any{"$literal": 4},
		map[string]any{"$literal": "valid", "extra": "unexpected"},
		map[string]any{"nested": "unsupported"},
	} {
		svc, path := scheduleService(t, "")
		input := validSchedule()
		input.Params = map[string]any{"device": param}
		if _, err := svc.SaveSchedule(input); err == nil || !strings.Contains(err.Error(), "device") {
			t.Fatalf("action accepted invalid params %#v: %v", param, err)
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("invalid action params persisted: %v", err)
		}
	}
}

func TestSaveScheduleRejectsLiteralShellSubstitution(t *testing.T) {
	svc, _ := scheduleService(t, "")
	la := svc.reg.Actions["patrol"]
	la.Def.Command.Run = "echo ${device}"
	svc.reg.Actions["patrol"] = la
	input := validSchedule()
	input.Params = map[string]any{"device": map[string]any{"$literal": "quoted"}}
	if _, err := svc.SaveSchedule(input); err == nil || !strings.Contains(err.Error(), "device") {
		t.Fatalf("inline shell literal accepted: %v", err)
	}
}

func TestSaveScheduleAcceptsValidActionLiteral(t *testing.T) {
	svc, _ := scheduleService(t, "")
	input := validSchedule()
	input.Params = map[string]any{"device": map[string]any{"$literal": "literal; value"}}
	if _, err := svc.SaveSchedule(input); err != nil {
		t.Fatalf("valid literal rejected: %v", err)
	}
}

func TestScheduleCatalogConcurrentWithReload(t *testing.T) {
	svc, _ := scheduleService(t, "")
	// Both reload paths publish new registry pointers while the catalog is read.
	for dir, file := range map[string]string{"actions": "a.yaml", "workflows": "w.yaml"} {
		path := filepath.Join(svc.baseDir, dir)
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatal(err)
		}
		body := "id: patrol\ntitle: Patrol\ncommand:\n  run: echo ok\n"
		if dir == "workflows" {
			body = "id: daily\ntitle: Daily\nsteps:\n  - sleep: 1\n"
		}
		if err := os.WriteFile(filepath.Join(path, file), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 200; i++ {
			svc.Reload()
			svc.ReloadWorkflows()
		}
	}()
	for i := 0; i < 200; i++ {
		catalog := svc.scheduleCatalog()
		if _, ok := catalog.Actions["patrol"]; !ok {
			t.Fatal("action missing from catalog")
		}
		if _, ok := catalog.Workflows["daily"]; !ok {
			t.Fatal("workflow missing from catalog")
		}
	}
	<-done
}

func TestListSchedulesDoesNotHoldLockDuringNextRunScan(t *testing.T) {
	svc, _ := scheduleService(t, "")
	defs := make([]schedule.Definition, 48)
	for i := range defs {
		defs[i] = schedule.Definition{ID: fmt.Sprintf("unreachable-%d", i), Name: "Unreachable", Enabled: true, Cron: "0 0 31 2 *", Action: "patrol"}
	}
	svc.scheduleDefs = defs
	finished := make(chan struct{})
	go func() { svc.ListSchedules(); close(finished) }()
	// A bounded year scan is deliberately slow here; CRUD must not wait for it.
	time.Sleep(20 * time.Millisecond)
	select {
	case <-finished:
		t.Skip("year-scan completed before contention could be observed")
	default:
	}
	if !svc.scheduleMu.TryLock() {
		t.Fatal("ListSchedules holds scheduleMu during NextAfter scan")
	}
	svc.scheduleMu.Unlock()
	<-finished
}

func TestConcurrentScheduleSavesKeepAllDefinitions(t *testing.T) {
	svc, _ := scheduleService(t, "")
	const count = 8
	errors := make(chan error, count)
	for i := 0; i < count; i++ {
		go func(i int) {
			input := validSchedule()
			input.ID = fmt.Sprintf("check-%d", i)
			_, err := svc.SaveSchedule(input)
			errors <- err
		}(i)
	}
	for i := 0; i < count; i++ {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
	}
	got := svc.ListSchedules()
	if len(got.Schedules) != count {
		t.Fatalf("lost concurrent updates: %+v", got)
	}
}

func TestNewNormalizesNilActionRegistryForPublicPaths(t *testing.T) {
	baseDir := t.TempDir()
	svc := New(nil, nil, baseDir, filepath.Join(baseDir, "config.yaml"), filepath.Join(baseDir, "fragments.yaml"))

	if result := svc.ListActions(); len(result.Actions) != 0 {
		t.Fatalf("nil registry should expose no actions: %+v", result)
	}
	if err := svc.RunAction("missing", nil); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("missing action should return an error, got %v", err)
	}
	if _, err := svc.SaveSchedule(validSchedule()); err == nil || !strings.Contains(err.Error(), "patrol") {
		t.Fatalf("unknown action should return an error, got %v", err)
	}
}

func TestNewFiltersInvalidScheduleParamObjects(t *testing.T) {
	baseDir := t.TempDir()
	schedulePath := filepath.Join(baseDir, "schedules.yaml")
	body := "schedules:\n  - id: check\n    name: Check\n    enabled: true\n    cron: '7 * * * *'\n    action: patrol\n    params:\n      device:\n        - unexpected: value\n"
	if err := os.WriteFile(schedulePath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	svc, _ := scheduleService(t, baseDir)
	result := svc.ListSchedules()
	if len(result.Schedules) != 0 || len(result.Errors) == 0 || !strings.Contains(result.Errors[0], "device") {
		t.Fatalf("invalid startup schedule was not filtered: %+v", result)
	}
}

func TestSaveScheduleRejectsObjectsInsideArray(t *testing.T) {
	svc, path := scheduleService(t, "")
	input := validSchedule()
	input.Params = map[string]any{"device": []any{map[string]any{"unexpected": "value"}}}

	if _, err := svc.SaveSchedule(input); err == nil || !strings.Contains(err.Error(), "device") {
		t.Fatalf("array object accepted: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("invalid params created file: %v", err)
	}
}

func TestSaveScheduleRejectsLiteralForWorkflowTarget(t *testing.T) {
	svc, path := scheduleService(t, "")
	input := validSchedule()
	input.TargetKind = "workflow"
	input.TargetID = "daily"
	input.Params = map[string]any{"device": map[string]any{"$literal": "value"}}

	if _, err := svc.SaveSchedule(input); err == nil || !strings.Contains(err.Error(), "device") {
		t.Fatalf("workflow accepted action literal: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("invalid params created file: %v", err)
	}
}

func TestSaveScheduleAcceptsJSONArrayWireValue(t *testing.T) {
	svc, _ := scheduleService(t, "")
	input := validSchedule()
	input.Params = map[string]any{"device": `["one", "two"]`}

	if _, err := svc.SaveSchedule(input); err != nil {
		t.Fatalf("JSON array string rejected: %v", err)
	}
}

func TestSaveScheduleRejectsDirectArrayWireValue(t *testing.T) {
	svc, path := scheduleService(t, "")
	input := validSchedule()
	input.Params = map[string]any{"device": []any{"one", "two"}}

	if _, err := svc.SaveSchedule(input); err == nil || !strings.Contains(err.Error(), "device") {
		t.Fatalf("direct array accepted: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("invalid params created file: %v", err)
	}
}
