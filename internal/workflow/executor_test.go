package workflow

import (
	"context"
	"strings"
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

	actionRun := func(actionID string, params map[string]any, _ map[string]string, _ *bool, e runner.EmitFunc) runner.Result {
		e("stdout", "ran:"+actionID)
		return runner.Result{ExitCode: 0}
	}
	shellRun := func(shell, timeout string, _ map[string]string, _ *bool, _ map[string]any, e runner.EmitFunc) runner.Result {
		e("stdout", "sh:"+shell)
		return runner.Result{ExitCode: 0}
	}

	exec := &Executor{}
	res := exec.Execute(context.Background(), wf, actionRun, shellRun, nil, emit)

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
	actionRun := func(actionID string, _ map[string]any, _ map[string]string, _ *bool, _ runner.EmitFunc) runner.Result {
		ran = append(ran, actionID)
		if actionID == "fail-act" {
			return runner.Result{ExitCode: 1}
		}
		return runner.Result{ExitCode: 0}
	}
	shellRun := func(shell, timeout string, _ map[string]string, _ *bool, _ map[string]any, e runner.EmitFunc) runner.Result {
		return runner.Result{ExitCode: 0}
	}

	exec := &Executor{}
	res := exec.Execute(context.Background(), wf, actionRun, shellRun, nil, emit)

	if res.ExitCode != 1 {
		t.Fatalf("expected exit 1, got %d", res.ExitCode)
	}
	if len(ran) != 1 {
		t.Fatalf("second step should not run, ran: %v", ran)
	}
}

func TestExecutor_ShellStep(t *testing.T) {
	var called string
	shellRun := func(shell, timeout string, _ map[string]string, _ *bool, _ map[string]any, e runner.EmitFunc) runner.Result {
		called = shell
		e("stdout", "sh:"+shell)
		return runner.Result{ExitCode: 0}
	}
	actionRun := func(id string, _ map[string]any, _ map[string]string, _ *bool, _ runner.EmitFunc) runner.Result {
		return runner.Result{ExitCode: 0}
	}

	wf := LoadedWorkflow{Def: WorkflowDef{
		ID:    "test-shell",
		Title: "Test Shell",
		Steps: []Step{{Shell: "echo hi"}},
	}}

	exec := &Executor{}
	res := exec.Execute(context.Background(), wf, actionRun, shellRun, nil, func(_, _ string) {})

	if res.ExitCode != 0 {
		t.Fatalf("expected exit 0, got %d", res.ExitCode)
	}
	if called != "echo hi" {
		t.Fatalf("shellRun not called with correct shell, got %q", called)
	}
}

func TestExecutor_RetrySucceedsEventually(t *testing.T) {
	callCount := 0
	actionRun := func(id string, _ map[string]any, _ map[string]string, _ *bool, _ runner.EmitFunc) runner.Result {
		callCount++
		if callCount < 3 {
			return runner.Result{ExitCode: 1}
		}
		return runner.Result{ExitCode: 0}
	}
	shellRun := func(shell, timeout string, _ map[string]string, _ *bool, _ map[string]any, e runner.EmitFunc) runner.Result {
		return runner.Result{ExitCode: 0}
	}

	wf := LoadedWorkflow{Def: WorkflowDef{
		ID:    "test-retry",
		Title: "Retry",
		Steps: []Step{{Action: "flaky", Retry: 2}},
	}}

	exec := &Executor{}
	res := exec.Execute(context.Background(), wf, actionRun, shellRun, nil, func(_, _ string) {})

	if res.ExitCode != 0 {
		t.Fatalf("expected exit 0 after retry, got %d", res.ExitCode)
	}
	if callCount != 3 {
		t.Fatalf("expected 3 calls (1 initial + 2 retry), got %d", callCount)
	}
}

func TestExecutor_ContinueOnError(t *testing.T) {
	ran := []string{}
	actionRun := func(id string, _ map[string]any, _ map[string]string, _ *bool, _ runner.EmitFunc) runner.Result {
		ran = append(ran, id)
		if id == "fail" {
			return runner.Result{ExitCode: 1}
		}
		return runner.Result{ExitCode: 0}
	}
	shellRun := func(shell, timeout string, _ map[string]string, _ *bool, _ map[string]any, e runner.EmitFunc) runner.Result {
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
	res := exec.Execute(context.Background(), wf, actionRun, shellRun, nil, func(_, _ string) {})

	if res.ExitCode != 0 {
		t.Fatalf("expected exit 0, got %d", res.ExitCode)
	}
	if len(ran) != 2 {
		t.Fatalf("expected both steps to run, got: %v", ran)
	}
}

func TestExecutor_StepOutputsAccumulate(t *testing.T) {
	wf := LoadedWorkflow{Def: WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{ID: "first", Shell: "echo 1"},
			{ID: "second", Shell: "echo 2", If: "steps.first.outputs.exit_code == '0'"},
		},
	}}
	var ranSecond bool
	shellRun := func(shellCmd, timeout string, env map[string]string, capture *bool, params map[string]any, emit runner.EmitFunc) runner.Result {
		if shellCmd == "echo 2" {
			ranSecond = true
		}
		return runner.Result{
			ExitCode: 0,
			Outputs:  map[string]string{"exit_code": "0", "success": "true"},
		}
	}
	actionRun := func(string, map[string]any, map[string]string, *bool, runner.EmitFunc) runner.Result {
		t.Fatal("no action step")
		return runner.Result{}
	}
	res := (&Executor{}).Execute(context.Background(), wf, actionRun, shellRun, nil, func(string, string) {})
	if res.ExitCode != 0 {
		t.Fatalf("exit = %d, want 0", res.ExitCode)
	}
	if !ranSecond {
		t.Fatal("second step 应被执行（if 求值为 true）")
	}
}

func TestExecutor_IfFalseSkips(t *testing.T) {
	wf := LoadedWorkflow{Def: WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{ID: "first", Shell: "echo 1"},
			{ID: "skip", Shell: "echo skipped", If: "steps.first.outputs.exit_code == '99'"},
			{ID: "third", Shell: "echo 3"},
		},
	}}
	var ran []string
	shellRun := func(shellCmd, timeout string, env map[string]string, capture *bool, params map[string]any, emit runner.EmitFunc) runner.Result {
		ran = append(ran, shellCmd)
		return runner.Result{ExitCode: 0, Outputs: map[string]string{"exit_code": "0", "success": "true"}}
	}
	var skipEvents []string
	emit := func(stream, line string) {
		if stream == "step-skip" {
			skipEvents = append(skipEvents, line)
		}
	}
	res := (&Executor{}).Execute(context.Background(), wf,
		func(string, map[string]any, map[string]string, *bool, runner.EmitFunc) runner.Result {
			return runner.Result{}
		},
		shellRun, nil, emit)
	if res.ExitCode != 0 {
		t.Fatalf("exit = %d, want 0", res.ExitCode)
	}
	if len(ran) != 2 || ran[0] != "echo 1" || ran[1] != "echo 3" {
		t.Fatalf("ran = %v, want [echo 1, echo 3]", ran)
	}
	if len(skipEvents) != 1 || skipEvents[0] != "1" {
		t.Fatalf("skipEvents = %v, want [\"1\"]", skipEvents)
	}
}

func TestExecutor_IndexFallbackID(t *testing.T) {
	wf := LoadedWorkflow{Def: WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{Shell: "echo first"}, // 无 id，用 "0"
			// expr-lang 的点语法不接受数字字面量作为字段名（steps.0 解析失败），
			// 索引兜底键必须用 bracket 语法访问。
			{Shell: "echo second", If: `steps["0"].outputs.exit_code == '0'`},
		},
	}}
	var ran []string
	shellRun := func(shellCmd, timeout string, env map[string]string, capture *bool, params map[string]any, emit runner.EmitFunc) runner.Result {
		ran = append(ran, shellCmd)
		return runner.Result{ExitCode: 0, Outputs: map[string]string{"exit_code": "0"}}
	}
	res := (&Executor{}).Execute(context.Background(), wf,
		func(string, map[string]any, map[string]string, *bool, runner.EmitFunc) runner.Result {
			return runner.Result{}
		},
		shellRun, nil, func(string, string) {})
	if res.ExitCode != 0 {
		t.Fatalf("exit = %d", res.ExitCode)
	}
	if len(ran) != 2 {
		t.Fatalf("ran = %v, want 2 steps", ran)
	}
}

func TestExecutor_SubstituteShellExpr(t *testing.T) {
	wf := LoadedWorkflow{Def: WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{ID: "first", Shell: "produce"},
			{ID: "consume", Shell: "use ${{ steps.first.outputs.token }}"},
		},
	}}
	var seen string
	shellRun := func(shellCmd, timeout string, env map[string]string, capture *bool, params map[string]any, emit runner.EmitFunc) runner.Result {
		if strings.HasPrefix(shellCmd, "use ") {
			seen = shellCmd
			return runner.Result{ExitCode: 0}
		}
		return runner.Result{ExitCode: 0, Outputs: map[string]string{"token": "abc123", "exit_code": "0"}}
	}
	(&Executor{}).Execute(context.Background(), wf,
		func(string, map[string]any, map[string]string, *bool, runner.EmitFunc) runner.Result {
			return runner.Result{}
		},
		shellRun, nil, func(string, string) {})
	if seen != "use abc123" {
		t.Fatalf("shell substituted = %q, want %q", seen, "use abc123")
	}
}
