package api

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"workflow-tool/internal/ai"
	"workflow-tool/internal/airun"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
	"workflow-tool/internal/workflow"
)

// fakeAICli 模拟 AI CLI 的 stream-json 输出：先给 session_id，把收到的 prompt 与
// STEP_NOTE 环境变量打到 stderr（供断言输入确实抵达子进程），按 FAKE_AI_SECONDS
// 阻塞，最后吐回复与 result 事件。
const fakeAICli = `#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-1"}'
printf 'PROMPT<%s>|STEP_NOTE<%s>\n' "$(cat)" "$STEP_NOTE" 1>&2
sleep "${FAKE_AI_SECONDS:-0}"
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]}}'
printf '%s\n' '{"type":"result","total_cost_usd":0.0125,"usage":{"input_tokens":10,"output_tokens":5}}'
`

// newAiSvc 建一个带 ai/ 目录与假 AI CLI 的 service，workflowYAML 非空时再建一个只含
// w.yaml 的 workflows 目录。t-ask 的提示词模板引用 ${TOPIC}；t-block 通过 env 让假
// CLI 阻塞 30s，专供取消与占锁用例使用。
func newAiSvc(t *testing.T, workflowYAML string) (*Service, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("假 AI CLI 是 sh 脚本")
	}
	dir := t.TempDir()
	write := func(rel, content string, mode os.FileMode) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, rel), []byte(content), mode); err != nil {
			t.Fatal(err)
		}
	}
	write("fake-ai.sh", fakeAICli, 0o755)
	cfgPath := filepath.Join(dir, "config.yaml")
	if err := registry.SaveGlobal(cfgPath, map[string]string{"AI_CLI": filepath.Join(dir, "fake-ai.sh")}); err != nil {
		t.Fatal(err)
	}
	for _, sub := range []string{"actions", "ai"} {
		if err := os.Mkdir(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join("ai", "t-ask.yaml"),
		"id: t-ask\ntitle: Ask\nparams:\n  - { id: TOPIC, label: 主题, type: text }\nprompt: |\n  介绍一下 ${TOPIC}\n", 0o644)
	write(filepath.Join("ai", "t-block.yaml"),
		"id: t-block\ntitle: Block\nprompt: hi\nenv:\n  FAKE_AI_SECONDS: \"30\"\n", 0o644)

	var wfReg *workflow.WorkflowRegistry
	if workflowYAML != "" {
		if err := os.Mkdir(filepath.Join(dir, "workflows"), 0o755); err != nil {
			t.Fatal(err)
		}
		write(filepath.Join("workflows", "w.yaml"), workflowYAML, 0o644)
		wfReg = workflow.Load(filepath.Join(dir, "workflows"))
	}
	svc := New(registry.Load(filepath.Join(dir, "actions"), dir), wfReg, dir,
		cfgPath, filepath.Join(dir, "fragments.yaml"))
	if got := svc.ListAiTasks(); len(got.Errors) > 0 || len(got.Tasks) != 2 {
		t.Fatalf("AI 任务未按预期加载：%+v", got)
	}
	return svc, dir
}

// registered 报告 id 当前是否登记在册（运行已开始、簿记未清理）。
func registered(r *runRegistry, id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.running[id]
	return ok
}

// waitRegistered 轮询到 id 的在册状态等于 want。
func waitRegistered(t *testing.T, r *runRegistry, id string, want bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for registered(r, id) != want {
		if time.Now().After(deadline) {
			t.Fatalf("%q 的在册状态未变为 %v", id, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// hasLine 报告 lines（"stream:line"）里是否有 stream 流且含 substr 的行。
func hasLine(lines []string, stream, substr string) bool {
	prefix := stream + ":"
	return slices.ContainsFunc(lines, func(l string) bool {
		return strings.HasPrefix(l, prefix) && strings.Contains(l, substr)
	})
}

func TestListAiTasksOrdersByIDAndExposesTemplates(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	got := svc.ListAiTasks()
	if len(got.Errors) != 0 {
		t.Fatalf("不应有加载错误：%v", got.Errors)
	}
	ids := make([]string, 0, len(got.Tasks))
	for _, task := range got.Tasks {
		ids = append(ids, task.ID)
	}
	if !slices.Equal(ids, []string{"t-ask", "t-block"}) {
		t.Fatalf("任务应按 id 升序，got %v", ids)
	}
	ask := got.Tasks[0]
	// Prompt/System 是定义里的模板原文：对话页草稿的初值，运行时才展开
	if ask.Prompt != "介绍一下 ${TOPIC}\n" || ask.System != "" {
		t.Fatalf("Prompt/System 应为模板原文，got %q / %q", ask.Prompt, ask.System)
	}
	if len(ask.Params) != 1 || ask.Params[0].ID != "TOPIC" {
		t.Fatalf("Params 未带回：%+v", ask.Params)
	}
	if ask.Timeout != ai.DefaultTimeout.String() {
		t.Fatalf("未写 timeout 时应为缺省上限，got %q", ask.Timeout)
	}
}

func TestListAiTasksReportsLoadErrorsWithoutLosingValidTasks(t *testing.T) {
	svc, dir := newAiSvc(t, "")
	path := filepath.Join(dir, "ai", "z-bad.yaml")
	if err := os.WriteFile(path, []byte("id: z-bad\ntitle: Bad\nprompt: hi\nmodel: x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc.Reload()
	got := svc.ListAiTasks()
	if len(got.Tasks) != 2 {
		t.Fatalf("单个文件出错不应影响其余任务，got %+v", got.Tasks)
	}
	if len(got.Errors) != 1 || !strings.Contains(got.Errors[0], "z-bad.yaml") || !strings.Contains(got.Errors[0], "已预留") {
		t.Fatalf("应带回该文件的错误，got %v", got.Errors)
	}
	// 修好后重载，错误随之消失
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	svc.Reload()
	if got := svc.ListAiTasks(); len(got.Errors) != 0 {
		t.Fatalf("错误文件删除后不应再报错，got %v", got.Errors)
	}
}

func TestAiEventNames(t *testing.T) {
	// ai:<id>:* 与 action:<id>:* 同一套 payload 与排序协议，只差前缀
	if got := newAiEvents(nil, "t-ask").name("output"); got != "ai:t-ask:output" {
		t.Fatalf("AI 输出事件名 = %q", got)
	}
	if got := newAiEvents(nil, "t-ask").name("done"); got != "ai:t-ask:done" {
		t.Fatalf("AI 结束事件名 = %q", got)
	}
	if got := newActionEvents(nil, "a").name("done"); got != "action:a:done" {
		t.Fatalf("action 结束事件名 = %q", got)
	}
}

func TestGetSetAiYaml(t *testing.T) {
	svc, dir := newAiSvc(t, "")
	path := filepath.Join(dir, "ai", "t-ask.yaml")
	orig := "# 任务注释\nid: t-ask\ntitle: Ask\nprompt: hi\n"
	if err := os.WriteFile(path, []byte(orig), 0o644); err != nil {
		t.Fatal(err)
	}
	svc.Reload()

	got, err := svc.GetAiYaml("t-ask")
	if err != nil || got != orig {
		t.Fatalf("应返回含注释的原文，got %q, err %v", got, err)
	}
	if _, err := svc.GetAiYaml("nope"); err == nil || !strings.Contains(err.Error(), "未知 AI 任务") {
		t.Fatalf("未知任务应报错，got %v", err)
	}

	res, err := svc.SetAiYaml("t-ask", "id: t-ask\ntitle: 改名\nprompt: bye\n")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Tasks) != 2 || res.Tasks[0].ID != "t-ask" || res.Tasks[0].Title != "改名" {
		t.Fatalf("写回后应重载并返回最新列表，got %+v", res)
	}
	saved := "id: t-ask\ntitle: 改名\nprompt: bye\n"
	if persisted, _ := svc.GetAiYaml("t-ask"); persisted != saved {
		t.Fatalf("应落盘，got %q", persisted)
	}

	cases := map[string]struct{ text, wantErr string }{
		"YAML 语法错误": {"id: t-ask\n  : : :\n", "YAML 解析失败"},
		"未知字段":      {"id: t-ask\ntitle: Ask\nprompt: hi\nnosuch: 1\n", "未知字段"},
		"预留字段":      {"id: t-ask\ntitle: Ask\nprompt: hi\nmodel: x\n", "已预留"},
		"缺 prompt":  {"id: t-ask\ntitle: Ask\n", "prompt"},
		"改 id":      {"id: other\ntitle: Ask\nprompt: hi\n", "id 不可修改"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := svc.SetAiYaml("t-ask", tc.text)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("want error containing %q, got %v", tc.wantErr, err)
			}
			if got, _ := svc.GetAiYaml("t-ask"); got != saved {
				t.Fatalf("被拒时不该写盘，got %q", got)
			}
		})
	}
	if _, err := svc.SetAiYaml("nope", "id: nope\ntitle: N\nprompt: hi\n"); err == nil || !strings.Contains(err.Error(), "未知 AI 任务") {
		t.Fatalf("未知任务应报错，got %v", err)
	}
}

func TestAddAiPreset(t *testing.T) {
	svc, dir := newAiSvc(t, "")
	path := filepath.Join(dir, "ai", "t-ask.yaml")

	// 预设值可以是已声明的参数，也可以是保留运行参数 prompt
	res, err := svc.AddAiPreset("t-ask", "问 Go", "", map[string]string{"TOPIC": "Go", "prompt": "用一句话介绍 ${TOPIC}"})
	if err != nil {
		t.Fatal(err)
	}
	var preset *registry.Preset
	for i := range res.Tasks[0].Presets {
		if res.Tasks[0].Presets[i].Name == "问 Go" {
			preset = &res.Tasks[0].Presets[i]
		}
	}
	if preset == nil || preset.Values["TOPIC"] != "Go" || preset.Values["prompt"] != "用一句话介绍 ${TOPIC}" {
		t.Fatalf("预设未持久化并重载：%+v", res.Tasks[0].Presets)
	}
	before, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(before), "问 Go") {
		t.Fatalf("预设应落盘：got %q, err %v", before, err)
	}

	// 引用未声明的参数：拒绝且不写盘
	if _, err := svc.AddAiPreset("t-ask", "坏预设", "", map[string]string{"NOPE": "x"}); err == nil ||
		!strings.Contains(err.Error(), "NOPE") || !strings.Contains(err.Error(), "坏预设") {
		t.Fatalf("未声明参数应报错，got %v", err)
	}
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Fatalf("被拒时不该写盘：%s", after)
	}
	if _, err := svc.AddAiPreset("nope", "x", "", nil); err == nil || !strings.Contains(err.Error(), "未知 AI 任务") {
		t.Fatalf("未知任务应报错，got %v", err)
	}
}

func TestGetVarReferenceCountsIncludesAiTasks(t *testing.T) {
	svc, dir := newAiSvc(t, "")
	refs := "id: z-refs\ntitle: Z\nprompt: 分析 ${BUG_URL}\nsystem: 你是 ${ROLE}\ncwd: ${ROOT}\nenv:\n  NOTE: ${NOTE_VAR}\n"
	if err := os.WriteFile(filepath.Join(dir, "ai", "z-refs.yaml"), []byte(refs), 0o644); err != nil {
		t.Fatal(err)
	}
	svc.Reload()
	counts := svc.GetVarReferenceCounts()
	// TOPIC 来自 t-ask 的 prompt 模板，其余四个来自 z-refs 的四个字段
	for _, name := range []string{"TOPIC", "BUG_URL", "ROLE", "ROOT", "NOTE_VAR"} {
		if counts[name] < 1 {
			t.Errorf("变量 %s 在 AI 任务里被引用，应被统计", name)
		}
	}
}

func TestRunAiRejectsUnknownAndConcurrent(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	if err := svc.RunAi("nope", nil); err == nil || !strings.Contains(err.Error(), "未知 AI 任务") {
		t.Fatalf("未知任务应报错，got %v", err)
	}
	if err := svc.RunAi("t-block", nil); err != nil {
		t.Fatal(err)
	}
	if err := svc.RunAi("t-block", nil); err == nil || !strings.Contains(err.Error(), "正在运行") {
		t.Fatalf("同一任务并发应被拒，got %v", err)
	}
	// 取消终止运行并释放目标锁
	svc.CancelAi("t-block")
	waitRegistered(t, svc.aiRunning, "t-block", false)
	if err := svc.RunAi("t-block", nil); err != nil {
		t.Fatalf("取消后目标锁应释放：%v", err)
	}
	svc.CancelAi("t-block")
	waitRegistered(t, svc.aiRunning, "t-block", false)
}

func TestRunAiCompletesAndReleasesLock(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	if err := svc.RunAi("t-ask", map[string]any{"TOPIC": "Go"}); err != nil {
		t.Fatal(err)
	}
	waitRegistered(t, svc.aiRunning, "t-ask", false)
	if err := svc.RunAi("t-ask", map[string]any{"TOPIC": "Go"}); err != nil {
		t.Fatalf("运行结束后目标锁应释放：%v", err)
	}
	waitRegistered(t, svc.aiRunning, "t-ask", false)
}

func TestAiStepRunBuildsFromInputs(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	var mu sync.Mutex
	var lines []string
	emit := func(stream, line string) {
		mu.Lock()
		lines = append(lines, stream+":"+line)
		mu.Unlock()
	}
	res := svc.aiStepRun(context.Background(), map[string]any{"ROOT": "/tmp"})(workflow.AIRequest{
		Ctx:    context.Background(),
		TaskID: "t-ask",
		Params: map[string]any{"TOPIC": "Go"},
		Env:    map[string]string{"STEP_NOTE": "${ROOT}/x"},
		Emit:   emit,
	})
	mu.Lock()
	got := slices.Clone(lines)
	mu.Unlock()
	if res.Err != nil || res.ExitCode != 0 {
		t.Fatalf("AI 步骤应成功：exit=%d err=%v lines=%v", res.ExitCode, res.Err, got)
	}
	// 产出契约：后续步骤经 steps.<id>.outputs.<key> 引用
	want := map[string]string{
		"text": "你好", "session_id": "sess-1", "cost_usd": "0.0125",
		"input_tokens": "10", "output_tokens": "5", "success": "true",
	}
	for k, v := range want {
		if res.Outputs[k] != v {
			t.Errorf("outputs[%q] = %q，want %q", k, res.Outputs[k], v)
		}
	}
	// 输入原样抵达子进程：定义里的 prompt 模板用输入展开；step env 的 ${VAR} 用 merged 展开
	if !hasLine(got, "stderr", "PROMPT<介绍一下 Go>|STEP_NOTE</tmp/x>") {
		t.Fatalf("prompt / step env 未按预期抵达子进程：%v", got)
	}
	// 回复增量以 ai 流推送，落在 workflow 事件流上
	if !hasLine(got, "ai", "你好") {
		t.Fatalf("回复增量应以 ai 流推送：%v", got)
	}
}

func TestAiStepRunRejectsUnknownTaskAndParam(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	run := svc.aiStepRun(context.Background(), nil)
	var lines []string
	emit := func(stream, line string) { lines = append(lines, stream+":"+line) }

	res := run(workflow.AIRequest{Ctx: context.Background(), TaskID: "nope", Emit: emit})
	if res.ExitCode != -1 || !strings.Contains(errStr(res.Err), "未知 AI 任务") {
		t.Fatalf("未知任务应失败，got exit=%d err=%v", res.ExitCode, res.Err)
	}
	// 未声明的参数早于进程启动即失败，原因照常进事件流
	res = run(workflow.AIRequest{Ctx: context.Background(), TaskID: "t-ask",
		Params: map[string]any{"NOPE": "x"}, Emit: emit})
	if res.ExitCode != -1 || !strings.Contains(errStr(res.Err), `未知参数 "NOPE"`) {
		t.Fatalf("未声明参数应失败，got exit=%d err=%v", res.ExitCode, res.Err)
	}
	if !hasLine(lines, "stderr", "未知参数") {
		t.Fatalf("失败原因应推进事件流：%v", lines)
	}
	if registered(svc.aiRunning, "t-ask") {
		t.Fatal("失败后不应留锁")
	}
}

func TestAiStepRunTakesTargetLockAndCancelTerminatesStep(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	// 手动运行先占锁：步骤撞锁立即失败，不等待
	if _, ok := svc.aiRunning.begin("t-ask"); !ok {
		t.Fatal("占锁失败")
	}
	res := svc.aiStepRun(context.Background(), nil)(workflow.AIRequest{
		Ctx: context.Background(), TaskID: "t-ask", Emit: func(string, string) {},
	})
	if res.ExitCode != -1 || !strings.Contains(errStr(res.Err), "正在运行") {
		t.Fatalf("撞锁应立即失败，got exit=%d err=%v", res.ExitCode, res.Err)
	}
	svc.aiRunning.end("t-ask")

	// 步骤运行期间占锁：手动运行同一任务被拒
	done := make(chan runner.Result, 1)
	go func() {
		done <- svc.aiStepRun(context.Background(), nil)(workflow.AIRequest{
			Ctx: context.Background(), TaskID: "t-block", Emit: func(string, string) {},
		})
	}()
	waitRegistered(t, svc.aiRunning, "t-block", true)
	if err := svc.RunAi("t-block", nil); err == nil || !strings.Contains(err.Error(), "正在运行") {
		t.Fatalf("AI 步骤应占目标锁，got %v", err)
	}
	// CancelAi 终止的是步骤本身
	svc.CancelAi("t-block")
	select {
	case res := <-done:
		if !errors.Is(res.Err, context.Canceled) {
			t.Fatalf("CancelAi 后步骤应以 context.Canceled 结束，got %v", res.Err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("CancelAi 未终止 AI 步骤")
	}
	waitRegistered(t, svc.aiRunning, "t-block", false)
	if err := svc.RunAi("t-block", nil); err != nil {
		t.Fatalf("步骤结束后目标锁应释放：%v", err)
	}
	svc.CancelAi("t-block")
	waitRegistered(t, svc.aiRunning, "t-block", false)
}

func TestWorkflowAiStepHoldsTargetLockAndFollowsWorkflowCancel(t *testing.T) {
	svc, _ := newAiSvc(t, "id: w\ntitle: W\nsteps:\n  - id: analyze\n    ai: t-block\n")
	if err := svc.RunWorkflow("w", nil); err != nil {
		t.Fatal(err)
	}
	waitRegistered(t, svc.aiRunning, "t-block", true)
	if err := svc.RunAi("t-block", nil); err == nil || !strings.Contains(err.Error(), "正在运行") {
		t.Fatalf("workflow 里的 AI 步骤应占目标锁，got %v", err)
	}
	// 取消工作流 → 终止该步骤 → 目标锁释放
	svc.CancelWorkflow("w")
	waitRegistered(t, svc.aiRunning, "t-block", false)
	waitRegistered(t, svc.wfRunning, "w", false)
	if err := svc.RunAi("t-block", nil); err != nil {
		t.Fatalf("工作流结束后目标锁应释放：%v", err)
	}
	svc.CancelAi("t-block")
	waitRegistered(t, svc.aiRunning, "t-block", false)
}

func TestWorkflowWithBusyAiTaskFailsFast(t *testing.T) {
	svc, _ := newAiSvc(t, "id: w\ntitle: W\nsteps:\n  - id: analyze\n    ai: t-block\n")
	// 手动运行先占锁
	if err := svc.RunAi("t-block", nil); err != nil {
		t.Fatal(err)
	}
	if err := svc.RunWorkflow("w", nil); err != nil {
		t.Fatal(err)
	}
	// 步骤撞锁立即失败：workflow 很快结束，占锁的手动运行不受影响
	waitRegistered(t, svc.wfRunning, "w", false)
	if !registered(svc.aiRunning, "t-block") {
		t.Fatal("workflow 撞锁失败不应终止占锁的手动运行")
	}
	svc.CancelAi("t-block")
	waitRegistered(t, svc.aiRunning, "t-block", false)
}

func TestRunAiOnceReportsTimeoutWithResumeHint(t *testing.T) {
	svc, dir := newAiSvc(t, "")
	slow := "id: z-slow\ntitle: Slow\nprompt: hi\ntimeout: 1s\nenv:\n  FAKE_AI_SECONDS: \"30\"\n"
	if err := os.WriteFile(filepath.Join(dir, "ai", "z-slow.yaml"), []byte(slow), 0o644); err != nil {
		t.Fatal(err)
	}
	svc.Reload()
	lt, ok := svc.aiRegistry().Get("z-slow")
	if !ok {
		t.Fatal("z-slow 未加载")
	}
	res, _ := runAiOnce(context.Background(), lt, svc.aiDeps,
		airun.Options{Global: svc.GetGlobalConfig()}, func(string, string) {})
	// 对外文案给出续接办法；底层原因仍是 DeadlineExceeded（簿记据此判超时）
	if !errors.Is(res.Err, context.DeadlineExceeded) {
		t.Fatalf("超时应保留 DeadlineExceeded，got %v", res.Err)
	}
	for _, want := range []string{"AI 运行超时", "1s", "resume"} {
		if !strings.Contains(res.Err.Error(), want) {
			t.Errorf("超时文案应含 %q，got %q", want, res.Err.Error())
		}
	}
	// 会话 id 在超时前已写入 outputs：续接所需的线索仍在
	if res.Outputs["session_id"] != "sess-1" {
		t.Fatalf("超时时 session_id 应保留在 outputs，got %+v", res.Outputs)
	}
}
