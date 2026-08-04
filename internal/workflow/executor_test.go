package workflow

import (
	"context"
	"testing"

	"workflow-tool/internal/runner"
)

func TestExecutor_RunsStepsSequentially(t *testing.T) {
	var events []string
	emit := func(stream, line string) {
		events = append(events, stream+":"+line)
	}

	wf := LoadedWorkflow{Def: WorkflowDef{
		ID:    "test",
		Title: "Test",
		Steps: []Step{
			{Action: "act-a"},
			{Sleep: 1},
			{Action: "act-b"},
		},
	}}

	actionRun := func(actionID string, params map[string]any, e runner.EmitFunc) runner.Result {
		e("stdout", "ran:"+actionID)
		return runner.Result{ExitCode: 0}
	}
	shellRun := func(shell, timeout string, e runner.EmitFunc) runner.Result {
		e("stdout", "sh:"+shell)
		return runner.Result{ExitCode: 0}
	}

	exec := &Executor{}
	res := exec.Execute(context.Background(), wf, actionRun, shellRun, emit)

	if res.ExitCode != 0 {
		t.Fatalf("expected exit 0, got %d (err=%v)", res.ExitCode, res.Err)
	}
	hasStart0 := false
	hasDone2 := false
	for _, ev := range events {
		if ev == "step-start:0" {
			hasStart0 = true
		}
		if ev == "step-done:2:0" {
			hasDone2 = true
		}
	}
	if !hasStart0 || !hasDone2 {
		t.Fatalf("missing step events, got: %v", events)
	}
}

func TestExecutor_StopsOnFailure(t *testing.T) {
	emit := func(_, _ string) {}

	wf := LoadedWorkflow{Def: WorkflowDef{
		ID:    "test",
		Title: "Test",
		Steps: []Step{
			{Action: "fail-act"},
			{Action: "never-run"},
		},
	}}

	ran := []string{}
	actionRun := func(actionID string, _ map[string]any, _ runner.EmitFunc) runner.Result {
		ran = append(ran, actionID)
		if actionID == "fail-act" {
			return runner.Result{ExitCode: 1}
		}
		return runner.Result{ExitCode: 0}
	}
	shellRun := func(shell, timeout string, e runner.EmitFunc) runner.Result {
		return runner.Result{ExitCode: 0}
	}

	exec := &Executor{}
	res := exec.Execute(context.Background(), wf, actionRun, shellRun, emit)

	if res.ExitCode != 1 {
		t.Fatalf("expected exit 1, got %d", res.ExitCode)
	}
	if len(ran) != 1 {
		t.Fatalf("second step should not run, ran: %v", ran)
	}
}

func TestExecutor_ShellStep(t *testing.T) {
	var called string
	shellRun := func(shell, timeout string, e runner.EmitFunc) runner.Result {
		called = shell
		e("stdout", "sh:"+shell)
		return runner.Result{ExitCode: 0}
	}
	actionRun := func(id string, _ map[string]any, _ runner.EmitFunc) runner.Result {
		return runner.Result{ExitCode: 0}
	}

	wf := LoadedWorkflow{Def: WorkflowDef{
		ID:    "test-shell",
		Title: "Test Shell",
		Steps: []Step{{Shell: "echo hi"}},
	}}

	exec := &Executor{}
	res := exec.Execute(context.Background(), wf, actionRun, shellRun, func(_, _ string) {})

	if res.ExitCode != 0 {
		t.Fatalf("expected exit 0, got %d", res.ExitCode)
	}
	if called != "echo hi" {
		t.Fatalf("shellRun not called with correct shell, got %q", called)
	}
}

func TestExecutor_RetrySucceedsEventually(t *testing.T) {
	callCount := 0
	actionRun := func(id string, _ map[string]any, _ runner.EmitFunc) runner.Result {
		callCount++
		if callCount < 3 {
			return runner.Result{ExitCode: 1}
		}
		return runner.Result{ExitCode: 0}
	}
	shellRun := func(shell, timeout string, e runner.EmitFunc) runner.Result {
		return runner.Result{ExitCode: 0}
	}

	wf := LoadedWorkflow{Def: WorkflowDef{
		ID:    "test-retry",
		Title: "Retry",
		Steps: []Step{{Action: "flaky", Retry: 2}},
	}}

	exec := &Executor{}
	res := exec.Execute(context.Background(), wf, actionRun, shellRun, func(_, _ string) {})

	if res.ExitCode != 0 {
		t.Fatalf("expected exit 0 after retry, got %d", res.ExitCode)
	}
	if callCount != 3 {
		t.Fatalf("expected 3 calls (1 initial + 2 retry), got %d", callCount)
	}
}

func TestExecutor_ContinueOnError(t *testing.T) {
	ran := []string{}
	actionRun := func(id string, _ map[string]any, _ runner.EmitFunc) runner.Result {
		ran = append(ran, id)
		if id == "fail" {
			return runner.Result{ExitCode: 1}
		}
		return runner.Result{ExitCode: 0}
	}
	shellRun := func(shell, timeout string, e runner.EmitFunc) runner.Result {
		return runner.Result{ExitCode: 0}
	}

	wf := LoadedWorkflow{Def: WorkflowDef{
		ID:    "test-continue",
		Title: "Continue",
		Steps: []Step{
			{Action: "fail", ContinueOnError: true},
			{Action: "ok"},
		},
	}}

	exec := &Executor{}
	res := exec.Execute(context.Background(), wf, actionRun, shellRun, func(_, _ string) {})

	if res.ExitCode != 0 {
		t.Fatalf("expected exit 0, got %d", res.ExitCode)
	}
	if len(ran) != 2 {
		t.Fatalf("expected both steps to run, got: %v", ran)
	}
}
