package workflow

import (
	"context"
	"slices"
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

	actionRun := func(req ActionRequest) runner.Result {
		req.Emit("stdout", "ran:"+req.ActionID)
		return runner.Result{ExitCode: 0}
	}
	shellRun := func(req ShellRequest) runner.Result {
		req.Emit("stdout", "sh:"+req.Run)
		return runner.Result{ExitCode: 0}
	}

	exec := &Executor{}
	res := exec.Execute(context.Background(), wf, actionRun, shellRun, nil, nil, emit)

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
	actionRun := func(req ActionRequest) runner.Result {
		ran = append(ran, req.ActionID)
		if req.ActionID == "fail-act" {
			return runner.Result{ExitCode: 1}
		}
		return runner.Result{ExitCode: 0}
	}
	shellRun := func(ShellRequest) runner.Result {
		return runner.Result{ExitCode: 0}
	}

	exec := &Executor{}
	res := exec.Execute(context.Background(), wf, actionRun, shellRun, nil, nil, emit)

	if res.ExitCode != 1 {
		t.Fatalf("expected exit 1, got %d", res.ExitCode)
	}
	if len(ran) != 1 {
		t.Fatalf("second step should not run, ran: %v", ran)
	}
}

func TestExecutor_ShellStep(t *testing.T) {
	var called string
	shellRun := func(req ShellRequest) runner.Result {
		called = req.Run
		req.Emit("stdout", "sh:"+req.Run)
		return runner.Result{ExitCode: 0}
	}
	actionRun := func(ActionRequest) runner.Result {
		return runner.Result{ExitCode: 0}
	}

	wf := LoadedWorkflow{Def: WorkflowDef{
		ID:    "test-shell",
		Title: "Test Shell",
		Steps: []Step{{Run: "echo hi"}},
	}}

	exec := &Executor{}
	res := exec.Execute(context.Background(), wf, actionRun, shellRun, nil, nil, func(_, _ string) {})

	if res.ExitCode != 0 {
		t.Fatalf("expected exit 0, got %d", res.ExitCode)
	}
	if called != "echo hi" {
		t.Fatalf("shellRun not called with correct shell, got %q", called)
	}
}

func TestExecutor_RetrySucceedsEventually(t *testing.T) {
	callCount := 0
	actionRun := func(ActionRequest) runner.Result {
		callCount++
		if callCount < 3 {
			return runner.Result{ExitCode: 1}
		}
		return runner.Result{ExitCode: 0}
	}
	shellRun := func(ShellRequest) runner.Result {
		return runner.Result{ExitCode: 0}
	}

	wf := LoadedWorkflow{Def: WorkflowDef{
		ID:    "test-retry",
		Title: "Retry",
		Steps: []Step{{Action: "flaky", Retry: 2}},
	}}

	exec := &Executor{}
	res := exec.Execute(context.Background(), wf, actionRun, shellRun, nil, nil, func(_, _ string) {})

	if res.ExitCode != 0 {
		t.Fatalf("expected exit 0 after retry, got %d", res.ExitCode)
	}
	if callCount != 3 {
		t.Fatalf("expected 3 calls (1 initial + 2 retry), got %d", callCount)
	}
}

func TestExecutor_ContinueOnError(t *testing.T) {
	ran := []string{}
	actionRun := func(req ActionRequest) runner.Result {
		ran = append(ran, req.ActionID)
		if req.ActionID == "fail" {
			return runner.Result{ExitCode: 1}
		}
		return runner.Result{ExitCode: 0}
	}
	shellRun := func(ShellRequest) runner.Result {
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
	res := exec.Execute(context.Background(), wf, actionRun, shellRun, nil, nil, func(_, _ string) {})

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
			{ID: "first", Run: "echo 1"},
			{ID: "second", Run: "echo 2", If: "steps.first.outputs.exit_code == '0'"},
		},
	}}
	var ranSecond bool
	shellRun := func(req ShellRequest) runner.Result {
		if req.Run == "echo 2" {
			ranSecond = true
		}
		return runner.Result{
			ExitCode: 0,
			Outputs:  map[string]string{"exit_code": "0", "success": "true"},
		}
	}
	actionRun := func(ActionRequest) runner.Result {
		t.Fatal("no action step")
		return runner.Result{}
	}
	res := (&Executor{}).Execute(context.Background(), wf, actionRun, shellRun, nil, nil, func(string, string) {})
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
			{ID: "first", Run: "echo 1"},
			{ID: "skip", Run: "echo skipped", If: "steps.first.outputs.exit_code == '99'"},
			{ID: "third", Run: "echo 3"},
		},
	}}
	var ran []string
	shellRun := func(req ShellRequest) runner.Result {
		ran = append(ran, req.Run)
		return runner.Result{ExitCode: 0, Outputs: map[string]string{"exit_code": "0", "success": "true"}}
	}
	var skipEvents []string
	emit := func(stream, line string) {
		if stream == "step-skip" {
			skipEvents = append(skipEvents, line)
		}
	}
	res := (&Executor{}).Execute(context.Background(), wf,
		func(ActionRequest) runner.Result { return runner.Result{} },
		shellRun, nil, nil, emit)
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
			{Run: "echo first"}, // 无 id，用 "0"
			// expr-lang 的点语法不接受数字字面量作为字段名（steps.0 解析失败），
			// 索引兜底键必须用 bracket 语法访问。
			{Run: "echo second", If: `steps["0"].outputs.exit_code == '0'`},
		},
	}}
	var ran []string
	shellRun := func(req ShellRequest) runner.Result {
		ran = append(ran, req.Run)
		return runner.Result{ExitCode: 0, Outputs: map[string]string{"exit_code": "0"}}
	}
	res := (&Executor{}).Execute(context.Background(), wf,
		func(ActionRequest) runner.Result { return runner.Result{} },
		shellRun, nil, nil, func(string, string) {})
	if res.ExitCode != 0 {
		t.Fatalf("exit = %d, want 0", res.ExitCode)
	}
	if len(ran) != 2 {
		t.Fatalf("ran = %v, want 2 steps", ran)
	}
}

func TestExecutor_SubstituteActionParamsExpr(t *testing.T) {
	wf := LoadedWorkflow{Def: WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{ID: "find", Run: "produce"},
			{ID: "install", Action: "adb-install", Params: map[string]string{"APK_PATH": "${{ steps.find.outputs.apk_path }}"}},
		},
	}}
	var gotActionParams map[string]any
	actionRun := func(req ActionRequest) runner.Result {
		if req.ActionID == "adb-install" {
			gotActionParams = req.Params
			return runner.Result{ExitCode: 0}
		}
		return runner.Result{ExitCode: 0, Outputs: map[string]string{"apk_path": "/tmp/voice.apk", "exit_code": "0"}}
	}
	shellRun := func(ShellRequest) runner.Result {
		return runner.Result{ExitCode: 0, Outputs: map[string]string{"apk_path": "/tmp/voice.apk", "exit_code": "0"}}
	}
	res := (&Executor{}).Execute(context.Background(), wf, actionRun, shellRun, nil, nil, func(string, string) {})
	if res.ExitCode != 0 {
		t.Fatalf("exit = %d, want 0", res.ExitCode)
	}
	if gotActionParams["APK_PATH"] != "/tmp/voice.apk" {
		t.Fatalf("APK_PATH = %v, want /tmp/voice.apk", gotActionParams["APK_PATH"])
	}
}

func TestExecutor_SubstituteEnvExpr(t *testing.T) {
	wf := LoadedWorkflow{Def: WorkflowDef{
		ID: "wf-env", Title: "t",
		Steps: []Step{
			{ID: "find", Run: "produce"},
			{ID: "install", Run: "echo $TOKEN", Env: map[string]string{"TOKEN": "${{ steps.find.outputs.token }}"}},
		},
	}}
	var gotEnv map[string]string
	shellRun := func(req ShellRequest) runner.Result {
		if req.Run == "echo $TOKEN" {
			gotEnv = req.Env
			return runner.Result{ExitCode: 0}
		}
		return runner.Result{ExitCode: 0, Outputs: map[string]string{"token": "abc123", "exit_code": "0"}}
	}
	res := (&Executor{}).Execute(context.Background(), wf,
		func(ActionRequest) runner.Result { return runner.Result{} },
		shellRun, nil, nil, func(string, string) {})
	if res.ExitCode != 0 {
		t.Fatalf("exit = %d, want 0", res.ExitCode)
	}
	if gotEnv["TOKEN"] != "abc123" {
		t.Fatalf("env TOKEN = %v, want abc123", gotEnv["TOKEN"])
	}
}

func TestExecutor_SubstituteShellExpr(t *testing.T) {
	wf := LoadedWorkflow{Def: WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{ID: "first", Run: "produce"},
			{ID: "consume", Run: "use ${{ steps.first.outputs.token }}"},
		},
	}}
	var seen string
	shellRun := func(req ShellRequest) runner.Result {
		if strings.HasPrefix(req.Run, "use ") {
			seen = req.Run
			return runner.Result{ExitCode: 0}
		}
		return runner.Result{ExitCode: 0, Outputs: map[string]string{"token": "abc123", "exit_code": "0"}}
	}
	(&Executor{}).Execute(context.Background(), wf,
		func(ActionRequest) runner.Result { return runner.Result{} },
		shellRun, nil, nil, func(string, string) {})
	if seen != "use abc123" {
		t.Fatalf("shell substituted = %q, want %q", seen, "use abc123")
	}
}

// TestExecutor_PassesContextToCallbacks 校验 ctx 经请求 struct 透传（不再闭包捕获）。
func TestExecutor_PassesContextToCallbacks(t *testing.T) {
	type ctxKey struct{}
	wf := LoadedWorkflow{Def: WorkflowDef{
		ID: "wf-ctx", Title: "t",
		Steps: []Step{
			{Action: "a"},
			{Run: "echo hi"},
		},
	}}
	ctx := context.WithValue(context.Background(), ctxKey{}, "v")
	var gotAction, gotShell string
	actionRun := func(req ActionRequest) runner.Result {
		gotAction, _ = req.Ctx.Value(ctxKey{}).(string)
		return runner.Result{ExitCode: 0}
	}
	shellRun := func(req ShellRequest) runner.Result {
		gotShell, _ = req.Ctx.Value(ctxKey{}).(string)
		return runner.Result{ExitCode: 0}
	}
	res := (&Executor{}).Execute(ctx, wf, actionRun, shellRun, nil, nil, func(string, string) {})
	if res.ExitCode != 0 {
		t.Fatalf("exit = %d, want 0", res.ExitCode)
	}
	if gotAction != "v" || gotShell != "v" {
		t.Fatalf("ctx 未透传: action=%q shell=%q", gotAction, gotShell)
	}
}

// TestExecutor_AIStep 校验 ai step 的分发：回调拿到任务 id、只做过 ${{ }} 替换的 params
// 与 env、同一个 ctx 与 emit；返回值的 Outputs 落到 steps.<id>.outputs，后续步骤可引用。
func TestExecutor_AIStep(t *testing.T) {
	type ctxKey struct{}
	wf := LoadedWorkflow{Def: WorkflowDef{
		ID: "wf-ai", Title: "t",
		Env: map[string]string{"WF": "w"},
		Steps: []Step{
			{ID: "find", Run: "produce"},
			{ID: "analyze", AI: "ai-bug-analyze", Params: map[string]string{
				"BUG_URL": "${{ steps.find.outputs.apk_path }}",
				"prompt":  "只分析崩溃线程，卡片：${{ steps.find.outputs.apk_path }}；原样保留 ${BUG_URL} 与 $HOME",
			}, Env: map[string]string{"TOKEN": "${{ steps.find.outputs.token }}", "BASE": "${ROOT}/x"}},
			{ID: "after", Run: "use ${{ steps.analyze.outputs.text }}"},
		},
	}}
	ctx := context.WithValue(context.Background(), ctxKey{}, "v")
	var events []string
	emit := func(stream, line string) { events = append(events, stream+":"+line) }

	var seen string
	shellRun := func(req ShellRequest) runner.Result {
		if req.Run == "produce" {
			return runner.Result{ExitCode: 0, Outputs: map[string]string{
				"apk_path": "/tmp/a.apk", "token": "abc123", "exit_code": "0",
			}}
		}
		seen = req.Run
		return runner.Result{ExitCode: 0, Outputs: map[string]string{"exit_code": "0"}}
	}
	aiCalls := 0
	aiRun := func(req AIRequest) runner.Result {
		aiCalls++
		if req.TaskID != "ai-bug-analyze" {
			t.Errorf("TaskID = %q", req.TaskID)
		}
		if got, _ := req.Ctx.Value(ctxKey{}).(string); got != "v" {
			t.Errorf("ctx 未透传: %q", got)
		}
		if req.Params["BUG_URL"] != "/tmp/a.apk" {
			t.Errorf("BUG_URL 应经 ${{ }} 替换: %v", req.Params["BUG_URL"])
		}
		if want := "只分析崩溃线程，卡片：/tmp/a.apk；原样保留 ${BUG_URL} 与 $HOME"; req.Params["prompt"] != want {
			t.Errorf("prompt = %q want %q（${VAR} 不展开）", req.Params["prompt"], want)
		}
		if req.Env["TOKEN"] != "abc123" || req.Env["BASE"] != "${ROOT}/x" || req.Env["WF"] != "w" {
			t.Errorf("env = %v", req.Env)
		}
		req.Emit("ai", "增量")
		return runner.Result{ExitCode: 0, Outputs: map[string]string{
			"text": "崩溃在渲染线程", "session_id": "s-1", "exit_code": "0",
		}}
	}
	actionRun := func(ActionRequest) runner.Result {
		t.Fatal("no action step")
		return runner.Result{}
	}

	res := (&Executor{}).Execute(ctx, wf, actionRun, shellRun, aiRun, nil, emit)
	if res.ExitCode != 0 {
		t.Fatalf("exit = %d (err=%v)", res.ExitCode, res.Err)
	}
	if aiCalls != 1 {
		t.Fatalf("aiRun 调用 %d 次，want 1", aiCalls)
	}
	if seen != "use 崩溃在渲染线程" {
		t.Fatalf("后续步骤 = %q，未引用到 ai step 的 text 产出", seen)
	}
	if !slices.Contains(events, "ai:增量") {
		t.Fatalf("回调的 emit 未接到 workflow 事件流: %v", events)
	}
}

// TestExecutor_AIStepRetryAndContinueOnError 校验 retry / continue_on_error 对 ai 步骤
// 同样生效（与其他 step 共用一条 runStep 路径）。
func TestExecutor_AIStepRetryAndContinueOnError(t *testing.T) {
	wf := LoadedWorkflow{Def: WorkflowDef{
		ID: "wf-ai-retry", Title: "t",
		Steps: []Step{
			{ID: "analyze", AI: "demo-ask", Retry: 2, ContinueOnError: true},
			{ID: "after", Run: "echo next"},
		},
	}}
	aiCalls, shellCalls := 0, 0
	res := (&Executor{}).Execute(context.Background(), wf,
		func(ActionRequest) runner.Result { return runner.Result{} },
		func(ShellRequest) runner.Result { shellCalls++; return runner.Result{ExitCode: 0} },
		func(AIRequest) runner.Result { aiCalls++; return runner.Result{ExitCode: 1} },
		nil, func(string, string) {})
	if res.ExitCode != 0 {
		t.Fatalf("continue_on_error 应让 workflow 成功结束，exit = %d err = %v", res.ExitCode, res.Err)
	}
	if aiCalls != 3 {
		t.Fatalf("ai step 应重试到 3 次（1 次 + retry 2），got %d", aiCalls)
	}
	if shellCalls != 1 {
		t.Fatalf("失败后续步骤应照常执行，shell 调用 %d 次", shellCalls)
	}
}

// TestExecutor_AIStepWithoutCallbackFails 校验未注入 AIRunFunc 时 ai 步骤立即失败、后续步骤
// 不再执行（CLI 路径在进入执行器前就已拒绝，这里是兜底，不 panic）。
func TestExecutor_AIStepWithoutCallbackFails(t *testing.T) {
	wf := LoadedWorkflow{Def: WorkflowDef{
		ID: "wf-ai-nil", Title: "t",
		Steps: []Step{
			{ID: "analyze", AI: "demo-ask"},
			{ID: "after", Run: "echo never"},
		},
	}}
	var ran []string
	var stderr []string
	res := (&Executor{}).Execute(context.Background(), wf,
		func(ActionRequest) runner.Result { return runner.Result{} },
		func(req ShellRequest) runner.Result { ran = append(ran, req.Run); return runner.Result{ExitCode: 0} },
		nil, nil,
		func(stream, line string) {
			if stream == "stderr" {
				stderr = append(stderr, line)
			}
		})
	if res.ExitCode != -1 || res.Err == nil || !strings.Contains(res.Err.Error(), "demo-ask") {
		t.Fatalf("应报未注入回调并指向任务: %+v", res)
	}
	if len(ran) != 0 {
		t.Fatalf("后续步骤不应执行: %v", ran)
	}
	if len(stderr) != 1 {
		t.Fatalf("应向 stderr 推一行原因: %q", stderr)
	}
}
