package api

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"workflow-tool/internal/registry"
	"workflow-tool/internal/runstore"
	"workflow-tool/internal/schedule"
	"workflow-tool/internal/workflow"
)

// AI 任务成为第三种调度目标（M2，ADR-0005）：保存与加载校验、到点发起、立即运行。

func aiSchedule() ScheduleInput {
	return ScheduleInput{ID: "nightly", Name: "夜间协议验证", Enabled: true, Cron: "0 2 * * *",
		TargetKind: "ai", TargetID: "t-ask", Params: map[string]any{"TOPIC": "crash"}}
}

func TestSaveSchedulePersistsAITarget(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	input := aiSchedule()
	input.Params["prompt"] = "只分析崩溃线程，卡片：${TOPIC}"
	got, err := svc.SaveSchedule(input)
	if err != nil || len(got.Schedules) != 1 || got.Schedules[0].TargetKind != "ai" || got.Schedules[0].TargetID != "t-ask" {
		t.Fatalf("save: %+v %v", got, err)
	}
	data, err := os.ReadFile(svc.schedulePath)
	if err != nil || !strings.Contains(string(data), "ai: t-ask") || strings.Contains(string(data), "action:") || strings.Contains(string(data), "workflow:") {
		t.Fatalf("file: %q %v", data, err)
	}
	if got.Schedules[0].Params["prompt"] != "只分析崩溃线程，卡片：${TOPIC}" {
		t.Fatalf("reserved run params must be kept as schedule params: %+v", got.Schedules[0].Params)
	}
	// 列表里的种类与投影（下次到点）对 AI 目标同样成立
	if got.Schedules[0].NextRun == "" || got.Schedules[0].Running || got.Schedules[0].LastRun != nil {
		t.Fatalf("projection: %+v", got.Schedules[0])
	}
}

func TestSaveScheduleAcceptsDeclaredAndReservedAIParams(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	input := aiSchedule()
	input.Params = map[string]any{
		"TOPIC":  "crash",
		"prompt": "只看崩溃线程",
		"system": "你是分析员",
		"resume": "sess-1",
	}
	if _, err := svc.SaveSchedule(input); err != nil {
		t.Fatalf("declared and reserved params rejected: %v", err)
	}
}

func TestSaveScheduleRejectsUndeclaredAIParamWithoutChangingFile(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	// 拼错的参数名：t-ask 只声明了 TOPIC
	input := aiSchedule()
	input.Params = map[string]any{"TOpic": "typo"}
	if _, err := svc.SaveSchedule(input); err == nil || !strings.Contains(err.Error(), "TOpic") || !strings.Contains(err.Error(), "t-ask") {
		t.Fatalf("undeclared param accepted: %v", err)
	}
	if _, err := os.Stat(svc.schedulePath); !os.IsNotExist(err) {
		t.Fatalf("rejected save created the file: %v", err)
	}
	// 空串值同样是「键出现了」：仍按未声明拒绝
	input.Params = map[string]any{"nope": ""}
	if _, err := svc.SaveSchedule(input); err == nil || !strings.Contains(err.Error(), "nope") {
		t.Fatalf("undeclared param with empty value accepted: %v", err)
	}
	if _, err := os.Stat(svc.schedulePath); !os.IsNotExist(err) {
		t.Fatalf("rejected save created the file: %v", err)
	}
}

func TestSaveScheduleRejectsLiteralAndObjectForAITarget(t *testing.T) {
	for name, value := range map[string]any{
		"literal": map[string]any{"$literal": "value"},
		"object":  map[string]any{"nested": "value"},
		"array":   []any{"one", "two"},
	} {
		t.Run(name, func(t *testing.T) {
			svc, _ := newAiSvc(t, "")
			input := aiSchedule()
			input.Params = map[string]any{"TOPIC": value}
			if _, err := svc.SaveSchedule(input); err == nil || !strings.Contains(err.Error(), "TOPIC") {
				t.Fatalf("AI target accepted %s param: %v", name, err)
			}
			if _, err := os.Stat(svc.schedulePath); !os.IsNotExist(err) {
				t.Fatalf("invalid AI params persisted: %v", err)
			}
		})
	}
}

func TestSaveScheduleRejectsUnknownAITarget(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	input := aiSchedule()
	input.TargetID = "nobody"
	if _, err := svc.SaveSchedule(input); err == nil || !strings.Contains(err.Error(), "nobody") {
		t.Fatalf("unknown AI task accepted: %v", err)
	}
}

// 同一 id 可以同时是动作与 AI 任务：目标键决定查哪张表，互不串扰。
func TestScheduleTargetsWithSharedIDResolveByKind(t *testing.T) {
	svc, dir := newAiSvc(t, "")
	if err := os.WriteFile(filepath.Join(dir, "ai", "t-ask.yaml"),
		[]byte("id: t-ask\ntitle: Ask\nprompt: hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "actions", "t-ask.yaml"),
		[]byte("id: t-ask\ntitle: T-Ask\ncommand:\n  run: echo ok\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc.Reload()
	for _, kind := range []string{"action", "ai"} {
		input := aiSchedule()
		input.ID, input.TargetKind, input.Params = "same-"+kind, kind, map[string]any{}
		if _, err := svc.SaveSchedule(input); err != nil {
			t.Fatalf("%s target sharing an id rejected: %v", kind, err)
		}
	}
	got := svc.ListSchedules().Schedules
	if len(got) != 2 {
		t.Fatalf("schedules: %+v", got)
	}
	kinds := map[string]bool{}
	for _, item := range got {
		kinds[item.TargetKind] = true
	}
	if !kinds["action"] || !kinds["ai"] {
		t.Fatalf("kinds = %v", kinds)
	}
}

// 加载时同样按目标校验：引用了未声明参数的 AI 调度被过滤并报诊断，其余调度不受影响。
func TestLoadFiltersAIScheduleWithUndeclaredParam(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	body := "schedules:\n" +
		"  - id: good\n    name: Good\n    cron: '0 2 * * *'\n    ai: t-ask\n    params:\n      TOPIC: crash\n" +
		"  - id: bad\n    name: Bad\n    cron: '0 2 * * *'\n    ai: t-ask\n    params:\n      TOpic: typo\n" +
		"  - id: gone\n    name: Gone\n    cron: '0 2 * * *'\n    ai: nobody\n"
	if err := os.WriteFile(svc.schedulePath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	svc.reconcileSchedules()
	got := svc.ListSchedules()
	if len(got.Schedules) != 1 || got.Schedules[0].ID != "good" {
		t.Fatalf("valid AI schedule lost: %+v", got)
	}
	joined := strings.Join(got.Errors, "\n")
	if len(got.Errors) != 2 || !strings.Contains(joined, "TOpic") || !strings.Contains(joined, "nobody") {
		t.Fatalf("diagnostics: %v", got.Errors)
	}
	// 不合格的文件挡住增删改，避免保存时把别人的错误条目覆盖掉
	if _, err := svc.SaveSchedule(ScheduleInput{ID: "new", Name: "New", Enabled: true, Cron: "0 3 * * *", TargetKind: "ai", TargetID: "t-block"}); err == nil {
		t.Fatal("save overwrote a file that failed validation")
	}
}

// 热重载后任务被删：指向它的调度随之从列表消失（与动作、工作流一致）。
func TestRemovingAITaskInvalidatesItsSchedules(t *testing.T) {
	svc, dir := newAiSvc(t, "")
	if _, err := svc.SaveSchedule(aiSchedule()); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "ai", "t-ask.yaml")); err != nil {
		t.Fatal(err)
	}
	svc.Reload()
	got := svc.ListSchedules()
	if len(got.Schedules) != 0 || len(got.Errors) == 0 || !strings.Contains(got.Errors[0], "t-ask") {
		t.Fatalf("schedule pointing at a removed task still listed: %+v", got)
	}
}

func TestScheduledAIRunIsRecordedWithReservedParamsAndRules(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	input := aiSchedule()
	input.Params["prompt"] = "介绍一下 ${TOPIC}"
	if _, err := svc.SaveSchedule(input); err != nil {
		t.Fatal(err)
	}
	if err := svc.RunScheduleNow("nightly"); err != nil {
		t.Fatal(err)
	}
	item := waitForSchedule(t, svc, "nightly", func(item ScheduleItem) bool {
		return item.LastRun != nil && !item.Running
	})
	if item.LastRun.Status != runstore.StatusSucceeded || item.LastRun.RunID == "" {
		t.Fatalf("unexpected last run: %+v", item.LastRun)
	}
	detail, err := svc.GetRun(item.LastRun.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.TargetKind != "ai" || detail.TargetID != "t-ask" || detail.Origin != runstore.OriginRunNow || detail.ScheduleID != "nightly" {
		t.Fatalf("unexpected run detail: %+v", detail)
	}
	// 输入原样留存，含保留运行参数；守则全文随运行落档
	if detail.Params["prompt"] != "介绍一下 ${TOPIC}" || detail.Params["TOPIC"] != "crash" {
		t.Fatalf("params not kept as given: %+v", detail.Params)
	}
	if !strings.Contains(detail.Rules, "无人值守") {
		t.Fatalf("injected rules not archived: %q", detail.Rules)
	}
	if detail.Outputs["session_id"] != "sess-1" || detail.Outputs["text"] != "你好" {
		t.Fatalf("outputs: %+v", detail.Outputs)
	}
	events, _ := svc.GetRunEvents(detail.ID)
	var sawReply bool
	for _, ev := range events {
		if ev.Event == "output" && ev.Stream == "ai" && ev.Line == "你好" {
			sawReply = true
		}
	}
	if !sawReply {
		t.Fatalf("reply increments missing from run log: %+v", events)
	}
}

func TestRunScheduleNowOnBusyAITaskReturnsErrorAndKeepsLastRun(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	if _, err := svc.SaveSchedule(aiSchedule()); err != nil {
		t.Fatal(err)
	}
	if err := svc.RunScheduleNow("nightly"); err != nil {
		t.Fatal(err)
	}
	before := waitForSchedule(t, svc, "nightly", func(item ScheduleItem) bool {
		return item.LastRun != nil && !item.Running
	}).LastRun
	if _, ok := svc.aiRunning.begin("t-ask"); !ok {
		t.Fatal("cannot reserve AI task")
	}
	defer svc.aiRunning.end("t-ask")
	err := svc.RunScheduleNow("nightly")
	if err == nil || !strings.Contains(err.Error(), "AI 任务") || !strings.Contains(err.Error(), "已在运行，已跳过") {
		t.Fatalf("expected busy-and-skipped rejection, got %v", err)
	}
	item := svc.ListSchedules().Schedules[0]
	if item.LastRun.RunID != before.RunID || item.LastSkip != nil {
		t.Fatalf("run-now changed the schedule's last result: %+v", item)
	}
}

// 手动运行撞上运行中的 AI 任务：仍是「正在运行」，不留跳过记录（只有调度到点才留）。
func TestManualAIConflictIsRejectedNotSkipped(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	if _, ok := svc.aiRunning.begin("t-ask"); !ok {
		t.Fatal("cannot reserve AI task")
	}
	defer svc.aiRunning.end("t-ask")
	if err := svc.RunAi("t-ask", map[string]any{"TOPIC": "x"}); err == nil || !strings.Contains(err.Error(), "正在运行") || strings.Contains(err.Error(), "已跳过") {
		t.Fatalf("expected plain busy rejection for a manual run, got %v", err)
	}
	if got := svc.ListRuns(RunFilter{}).Runs; len(got) != 0 {
		t.Fatalf("a rejected manual run must not be recorded: %+v", got)
	}
}

// 调度的最近结果跨重启保留：内存态丢了，从运行记录回填。
func TestScheduleLastRunSurvivesRestartViaRunRecords(t *testing.T) {
	svc, _ := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	if err := svc.RunScheduleNow("check"); err != nil {
		t.Fatal(err)
	}
	before := waitForSchedule(t, svc, "check", func(item ScheduleItem) bool {
		return item.LastRun != nil && !item.Running
	}).LastRun

	// 同一目录重新建 service：等同应用下次启动，内存里的调度运行态已丢
	reopened, _ := scheduleService(t, svc.baseDir)
	item := reopened.ListSchedules().Schedules[0]
	if item.Running || item.LastRun == nil || item.LastRun.RunID != before.RunID || item.LastRun.Status != runstore.StatusSucceeded ||
		item.LastRun.StartedAt == "" || item.LastRun.FinishedAt == "" || item.LastRun.Duration == "" {
		t.Fatalf("last run not restored from run records: %+v", item)
	}
	// 列表返回的是副本：改它不影响下一次读取
	item.LastRun.Status = "changed"
	if reopened.ListSchedules().Schedules[0].LastRun.Status != runstore.StatusSucceeded {
		t.Fatal("restored LastRun pointer leaked")
	}
}

// 重启后「上次到点已跳过」也从运行记录回填，且同样只说明最近一次到点。
func TestScheduleLastSkipSurvivesRestartAndClearsAfterRealRun(t *testing.T) {
	svc, _ := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	def := schedule.Definition{ID: "check", Name: "Check", Enabled: true, Cron: "* * * * *", Action: "patrol"}
	if _, ok := svc.running.begin("patrol"); !ok {
		t.Fatal("cannot reserve action")
	}
	if err := svc.launchSchedule(context.Background(), def); err != nil {
		t.Fatal(err)
	}
	svc.running.end("patrol")
	skippedID := svc.ListSchedules().Schedules[0].LastSkip.RunID

	reopened, _ := scheduleService(t, svc.baseDir)
	item := reopened.ListSchedules().Schedules[0]
	if item.LastSkip == nil || item.LastSkip.RunID != skippedID || !strings.Contains(item.LastSkip.Reason, "正在运行") {
		t.Fatalf("last skip not restored: %+v", item)
	}
	if item.LastRun != nil {
		t.Fatalf("a skip must not masquerade as a real result: %+v", item.LastRun)
	}
	// 之后有一次真实运行：旧账不再翻
	if err := reopened.launchSchedule(context.Background(), def); err != nil {
		t.Fatal(err)
	}
	after := waitForSchedule(t, reopened, "check", func(item ScheduleItem) bool {
		return item.LastRun != nil && !item.Running
	})
	if after.LastSkip != nil || after.LastRun.Status != runstore.StatusSucceeded {
		t.Fatalf("real run did not supersede the skip: %+v", after)
	}
}

// AI 卡的叙述区取自运行记录：任务列表带回最近一次真实运行（跳过不算）。
func TestAiTaskItemCarriesLatestRealRun(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	tasks := svc.ListAiTasks().Tasks
	if tasks[0].LastRun != nil {
		t.Fatalf("never-run task must not carry a last run: %+v", tasks[0].LastRun)
	}
	if err := svc.RunAi("t-ask", map[string]any{"TOPIC": "crash", "prompt": "介绍一下 ${TOPIC}"}); err != nil {
		t.Fatal(err)
	}
	waitRuns(t, svc, 1, allSettled)
	tasks = svc.ListAiTasks().Tasks
	if tasks[0].LastRun == nil {
		t.Fatalf("last run not surfaced on the task: %+v", tasks[0])
	}
	last := tasks[0].LastRun
	if last.TargetID != "t-ask" || last.Origin != runstore.OriginManual || last.Status != runstore.StatusSucceeded {
		t.Fatalf("unexpected last run: %+v", last)
	}
	if last.Params["prompt"] != "介绍一下 ${TOPIC}" || last.Params["TOPIC"] != "crash" {
		t.Fatalf("params not exposed for the card summary: %+v", last.Params)
	}
	if last.Outputs["session_id"] != "sess-1" {
		t.Fatalf("readouts not exposed: %+v", last.Outputs)
	}
	if tasks[1].ID != "t-block" && tasks[1].LastRun != nil {
		t.Fatalf("another task picked up the run: %+v", tasks[1])
	}
}

func TestScheduledTimeoutIsFailedNotCancelled(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	input := aiSchedule()
	input.TargetID = "t-block"
	input.Params = map[string]any{}
	// t-block 阻塞 30s；把它的超时压到 1s 再调度
	if err := os.WriteFile(filepath.Join(svc.baseDir, "ai", "t-block.yaml"),
		[]byte("id: t-block\ntitle: Block\nprompt: hi\ntimeout: 1s\nenv:\n  FAKE_AI_SECONDS: \"30\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc.Reload()
	if _, err := svc.SaveSchedule(input); err != nil {
		t.Fatal(err)
	}
	if err := svc.RunScheduleNow("nightly"); err != nil {
		t.Fatal(err)
	}
	item := waitForSchedule(t, svc, "nightly", func(item ScheduleItem) bool {
		return item.LastRun != nil && !item.Running
	})
	if item.LastRun.Status != runstore.StatusFailed || !strings.Contains(item.LastRun.Error, "超时") {
		t.Fatalf("timeout must be a failure with the reason stated: %+v", item.LastRun)
	}
	detail, err := svc.GetRun(item.LastRun.RunID)
	if err != nil || detail.Status != runstore.StatusFailed || !strings.Contains(detail.Reason, "超时") {
		t.Fatalf("run record: %+v %v", detail, err)
	}
	// 超时的运行最需要会话 id 来续接：失败与超时的时刻 session_id 都保留
	if detail.Outputs["session_id"] != "sess-1" {
		t.Fatalf("session id lost on timeout: %+v", detail.Outputs)
	}
}

func TestCancelledAIRunIsRecordedAsCancelled(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	if err := svc.RunAi("t-block", nil); err != nil {
		t.Fatal(err)
	}
	waitRegistered(t, svc.aiRunning, "t-block", true)
	svc.CancelAi("t-block")
	runs := waitRuns(t, svc, 1, allSettled)
	if runs[0].Status != runstore.StatusCancelled || runs[0].Reason != "" || runs[0].TargetID != "t-block" {
		t.Fatalf("unexpected outcome: %+v", runs[0])
	}
}

func TestAIStepIsNotRecordedAsItsOwnRun(t *testing.T) {
	svc, _ := newAiSvc(t, "id: w\ntitle: W\nsteps:\n  - ai: t-ask\n    params:\n      TOPIC: crash\n")
	if err := svc.RunWorkflow("w", nil); err != nil {
		t.Fatal(err)
	}
	runs := waitRuns(t, svc, 1, allSettled)
	// 只有工作流这一次运行留档；AI 步骤的输出在它的运行日志里（带步骤归属）
	if len(runs) != 1 || runs[0].TargetKind != "workflow" {
		t.Fatalf("AI step left a separate run record: %+v", runs)
	}
	events, _ := svc.GetRunEvents(runs[0].ID)
	var sawStepOutput bool
	for _, ev := range events {
		if ev.Event == "output" && ev.Stream == "ai" && ev.Step == "0" {
			sawStepOutput = true
		}
	}
	if !sawStepOutput {
		t.Fatalf("AI step output missing from the workflow's run log: %+v", events)
	}
}

// ——— 按目标校验：动作 / 工作流的调度参数 ———

// declaredTargetSvc 建一个带参数声明的动作 pick 与工作流 choose 的 service：
// MODE(select) / FLAG(bool) / ITEMS(list) / ARGS(arguments) / NAME(text)，工作流同构。
func declaredTargetSvc(t *testing.T) (*Service, string) {
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
	params := `params:
  - { id: MODE, label: 模式, type: select, options: [fast, full] }
  - { id: FLAG, label: 开关, type: bool }
  - { id: ITEMS, label: 列表, type: list }
  - { id: ARGS, label: 参数, type: arguments }
  - { id: NAME, label: 名称, type: text, required: true }
`
	// 命令不插值这些参数：$literal 的参数不得插入内联命令，别让那条规则盖过这里要测的类型校验
	write("actions/pick.yaml", "id: pick\ntitle: Pick\n"+params+"command:\n  run: echo pick\n")
	write("workflows/choose.yaml", "id: choose\ntitle: Choose\n"+params+"steps:\n  - run: echo ${NAME}\n")
	svc := New(registry.Load(filepath.Join(dir, "actions"), dir), workflow.Load(filepath.Join(dir, "workflows")),
		dir, filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
	if len(svc.ListActions().Actions) != 1 || len(svc.ListWorkflows().Workflows) != 1 {
		t.Fatalf("目标未按预期加载：%+v %+v", svc.ListActions(), svc.ListWorkflows())
	}
	return svc, dir
}

func TestSaveScheduleValidatesDeclaredParamsAgainstTheirTypes(t *testing.T) {
	for _, kind := range []string{"action", "workflow"} {
		t.Run(kind, func(t *testing.T) {
			targetID := map[string]string{"action": "pick", "workflow": "choose"}[kind]
			for _, tc := range []struct {
				name    string
				params  map[string]any
				wantErr string // 空 = 应通过
			}{
				{"select 在 options 内", map[string]any{"MODE": "fast"}, ""},
				{"select 不在 options 内", map[string]any{"MODE": "turbo"}, `MODE`},
				{"bool 是 JSON 布尔", map[string]any{"FLAG": true}, ""},
				{"bool 是 true/false 文本", map[string]any{"FLAG": "false"}, ""},
				{"bool 不是布尔", map[string]any{"FLAG": "yes"}, "FLAG"},
				{"list 是 JSON 字符串数组", map[string]any{"ITEMS": `["a","b"]`}, ""},
				{"list 不是字符串数组", map[string]any{"ITEMS": `[1,2]`}, "ITEMS"},
				{"arguments 是 {flag,values} 数组", map[string]any{"ARGS": `[{"flag":"-k","values":["x"]}]`}, ""},
				{"arguments 形状不对", map[string]any{"ARGS": `["-k"]`}, "ARGS"},
				{"text 是字符串", map[string]any{"NAME": "build"}, ""},
				// 未声明的键是额外变量源：动作与工作流的既有用法
				{"未声明的键允许", map[string]any{"EXTRA": "x"}, ""},
				// 缺省的必填参数可以来自 config.yaml 的同名键：保存时不下结论
				{"缺省必填参数不报错", map[string]any{}, ""},
			} {
				t.Run(tc.name, func(t *testing.T) {
					svc, _ := declaredTargetSvc(t)
					_, err := svc.SaveSchedule(ScheduleInput{ID: "s", Name: "S", Enabled: true, Cron: "0 2 * * *",
						TargetKind: kind, TargetID: targetID, Params: tc.params})
					if tc.wantErr == "" {
						if err != nil {
							t.Fatalf("合法的参数被拒：%v", err)
						}
						return
					}
					if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
						t.Fatalf("want %s error, got %v", tc.wantErr, err)
					}
					if _, statErr := os.Stat(svc.schedulePath); !os.IsNotExist(statErr) {
						t.Fatalf("非法参数创建了文件：%v", statErr)
					}
				})
			}
		})
	}
}

func TestScheduleParamValidationDiffsByTargetKind(t *testing.T) {
	svc, _ := declaredTargetSvc(t)
	base := func(kind, id string, params map[string]any) ScheduleInput {
		return ScheduleInput{ID: "s", Name: "S", Enabled: true, Cron: "0 2 * * *", TargetKind: kind, TargetID: id, Params: params}
	}
	// $literal 只属于动作：字面值按其中的文本校验，select 的字面值也须在 options 内
	if _, err := svc.SaveSchedule(base("action", "pick", map[string]any{"NAME": map[string]any{"$literal": "a; b"}})); err != nil {
		t.Fatalf("动作的 $literal 文本值被拒：%v", err)
	}
	if _, err := svc.SaveSchedule(base("action", "pick", map[string]any{"MODE": map[string]any{"$literal": "turbo"}})); err == nil || !strings.Contains(err.Error(), "MODE") {
		t.Fatalf("select 的 $literal 不在 options 内却通过了：%v", err)
	}
	if _, err := svc.SaveSchedule(base("action", "pick", map[string]any{"FLAG": map[string]any{"$literal": "true"}})); err == nil || !strings.Contains(err.Error(), "FLAG") {
		t.Fatalf("bool 参数的 $literal 却通过了：%v", err)
	}
	// 工作流不接受 $literal 对象（值的形状一层就已拒绝）
	if _, err := svc.SaveSchedule(base("workflow", "choose", map[string]any{"NAME": map[string]any{"$literal": "x"}})); err == nil {
		t.Fatal("工作流接受了 $literal 对象")
	}
}

// 加载路径同样按目标校验：取值不合法的调度被过滤并报诊断，其余调度不受影响。
func TestLoadFiltersSchedulesWhoseDeclaredParamValuesAreInvalid(t *testing.T) {
	svc, _ := declaredTargetSvc(t)
	body := "schedules:\n" +
		"  - id: good\n    name: Good\n    cron: '0 2 * * *'\n    action: pick\n    params:\n      MODE: full\n      EXTRA: anything\n" +
		"  - id: bad\n    name: Bad\n    cron: '0 2 * * *'\n    workflow: choose\n    params:\n      MODE: turbo\n"
	if err := os.WriteFile(svc.schedulePath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	svc.reconcileSchedules()
	got := svc.ListSchedules()
	if len(got.Schedules) != 1 || got.Schedules[0].ID != "good" {
		t.Fatalf("valid schedule lost: %+v", got)
	}
	if len(got.Errors) != 1 || !strings.Contains(got.Errors[0], "MODE") || !strings.Contains(got.Errors[0], "turbo") {
		t.Fatalf("diagnostics: %v", got.Errors)
	}
}

// ——— 发起即通知 ———

// 调度发起的运行前端没有输出捕获：运行一开始就要广播 schedules:changed，卡片才能进入
// 运行态、才能凭最近结果里的 run-id 进运行详情实时跟踪。
func TestScheduledRunStartIsAnnouncedWithItsRunRecord(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	if _, err := svc.SaveSchedule(ScheduleInput{ID: "slow", Name: "Slow", Enabled: true, Cron: "0 2 * * *",
		TargetKind: "ai", TargetID: "t-block"}); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var announced []ScheduleItem
	svc.emitEvent = func(name string, data any) {
		if name != "schedules:changed" {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		announced = append(announced, data.(ScheduleItem))
	}
	if err := svc.RunScheduleNow("slow"); err != nil {
		t.Fatal(err)
	}
	waitRegistered(t, svc.aiRunning, "t-block", true)
	mu.Lock()
	defer mu.Unlock()
	var start *ScheduleItem
	for i := range announced {
		if announced[i].Running && announced[i].LastRun != nil && announced[i].LastRun.Status == runstore.StatusRunning {
			start = &announced[i]
		}
	}
	if start == nil {
		t.Fatalf("the start of a scheduled run was never announced: %+v", announced)
	}
	if !strings.HasPrefix(start.LastRun.RunID, "r") {
		t.Fatalf("in-flight result is not linked to its run record: %+v", start.LastRun)
	}
	svc.CancelAi("t-block")
}

// 「已跳过」的提示是给发起人看的完整一句话，不带内部标记的尾巴。
func TestRunNowBusyMessageIsSelfContained(t *testing.T) {
	svc, _ := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	if _, ok := svc.running.begin("patrol"); !ok {
		t.Fatal("cannot reserve action")
	}
	defer svc.running.end("patrol")
	err := svc.RunScheduleNow("check")
	if err == nil {
		t.Fatal("expected busy rejection")
	}
	if strings.Contains(err.Error(), "target busy") || !strings.HasSuffix(err.Error(), "已在运行，已跳过") {
		t.Fatalf("busy message leaks an internal marker or lacks the hint: %q", err.Error())
	}
}
