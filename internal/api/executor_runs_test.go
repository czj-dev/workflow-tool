package api

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workflow-tool/internal/registry"
	"workflow-tool/internal/runstore"
	"workflow-tool/internal/target"
	"workflow-tool/internal/targetlock"
)

// 调度交给执行器之后，应用这边的行为：错过与补跑、停止、重启后的认领、续跑。

// tickScheduler 让调度器在 at 这一刻走一个 tick。
func tickScheduler(svc *Service, at time.Time) {
	ticks := make(chan time.Time, 1)
	ticks <- at
	close(ticks)
	svc.scheduler.Run(context.Background(), func() time.Time { return at }, ticks)
}

// writeScheduleState 伪造调度器的「上次评估时刻」：应用在 seen 之后停过。
func writeScheduleState(t *testing.T, dir, id, cron string, seen time.Time) {
	t.Helper()
	body, err := json.Marshal(map[string]seenMark{
		id: {Seen: seen, Cron: cron, Enabled: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, scheduleStateFile), body, 0o644); err != nil {
		t.Fatal(err)
	}
}

type seenMark = struct {
	Seen    time.Time `json:"seen"`
	Cron    string    `json:"cron"`
	Enabled bool      `json:"enabled"`
}

// settledRuns 等到至少一条 status 的运行落定（执行器的运行是异步的，索引由核对同步）。
func settledRuns(t *testing.T, svc *Service, status string) []RunItem {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if runs := svc.ListRuns(RunFilter{Status: status}).Runs; len(runs) > 0 && allSettled(runs) {
			return runs
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no %s run settled: %+v", status, svc.ListRuns(RunFilter{}).Runs)
	return nil
}

// waitExecutedBy 等到执行器把自己的进程信息写进这条记录。
func waitExecutedBy(t *testing.T, svc *Service, runID string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if rec, err := svc.runs.Get(runID); err == nil && rec.Process != nil && rec.Process.PID != 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("the executor never took over run %s", runID)
}

func minuteOf(hour, minute int) time.Time {
	today := time.Now()
	return time.Date(today.Year(), today.Month(), today.Day(), hour, minute, 0, 0, time.Local)
}

// 应用停过一段时间：恢复后的第一个 tick 为其间每个溜走的到点留一条 missed 记录，
// 不覆盖上一次真实运行的结果。
func TestStartupRecordsMissedScheduleInstants(t *testing.T) {
	// 上次评估到 02:07，02:10 才恢复：02:08 与 02:09 两个到点溜走了。状态先于应用启动就位
	seen := minuteOf(2, 7)
	dir := t.TempDir()
	writeScheduleState(t, dir, "check", "* * * * *", seen)
	svc, _ := scheduleService(t, dir)
	input := validSchedule()
	input.Cron = "* * * * *"
	if _, err := svc.SaveSchedule(input); err != nil {
		t.Fatal(err)
	}
	tickScheduler(svc, seen.Add(3*time.Minute+5*time.Second))

	missed := svc.ListRuns(RunFilter{Status: runstore.StatusMissed}).Runs
	if len(missed) != 2 || missed[0].TargetID != "patrol" || missed[0].ScheduleID != "check" ||
		missed[0].Origin != runstore.OriginSchedule || !strings.Contains(missed[1].Reason, "错过") {
		t.Fatalf("missed records = %+v", missed)
	}
	// 恢复后的这一分钟（02:10）照常发起一次真实运行；最近结果是它，不是错过
	real := settledRuns(t, svc, runstore.StatusSucceeded)
	if len(real) != 1 || real[0].ScheduleID != "check" {
		t.Fatalf("the first minute after restart must run for real: %+v", real)
	}
	item := waitForSchedule(t, svc, "check", func(item ScheduleItem) bool { return item.LastRun != nil && !item.Running })
	if item.LastRun.Status != runstore.StatusSucceeded || item.LastRun.RunID != real[0].ID {
		t.Fatalf("last run after restart = %+v, want the real run %s", item.LastRun, real[0].ID)
	}
	if item.CatchUp {
		t.Fatal("catch-up must be off by default")
	}
}

// 开了补跑：为最近一个错过的时刻补发一次运行，来源仍是调度。
func TestCatchUpLaunchesOneRunForTheLatestMissedInstant(t *testing.T) {
	seen := minuteOf(2, 7)
	dir := t.TempDir()
	writeScheduleState(t, dir, "check", "* * * * *", seen)
	svc, _ := scheduleService(t, dir)
	input := validSchedule()
	input.Cron, input.CatchUp = "* * * * *", true
	if _, err := svc.SaveSchedule(input); err != nil {
		t.Fatal(err)
	}
	tickScheduler(svc, seen.Add(3*time.Minute+5*time.Second))

	if missed := svc.ListRuns(RunFilter{Status: runstore.StatusMissed}).Runs; len(missed) != 2 {
		t.Fatalf("missed records = %+v", missed)
	}
	// 补跑的那一次 + 恢复后这一分钟的常规到点。同一个目标撞上就跳过：两次里至少有一次真实运行
	if real := settledRuns(t, svc, runstore.StatusSucceeded); len(real) < 1 || len(real) > 2 || real[0].Origin != runstore.OriginSchedule {
		t.Fatalf("catch-up runs = %+v, want one or two schedule-origin runs", real)
	}
	log, _ := os.ReadFile(filepath.Join(svc.baseDir, "logs", "app.log"))
	if !strings.Contains(string(log), `"event":"schedule.catch_up"`) {
		t.Fatalf("catch-up not logged: %s", log)
	}
}

// 保存：catch_up 随调度写回 schedules.yaml，再读出来还在。
func TestSaveSchedulePersistsCatchUp(t *testing.T) {
	svc, yamlPath := scheduleService(t, "")
	input := validSchedule()
	input.CatchUp = true
	if _, err := svc.SaveSchedule(input); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(yamlPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "catch_up: true") {
		t.Fatalf("catch_up not written to schedules.yaml: %s", body)
	}
	item := svc.ListSchedules().Schedules[0]
	if !item.CatchUp {
		t.Fatalf("catch-up not projected to the schedule item: %+v", item)
	}
	if _, err := svc.SetScheduleEnabled("check", false); err != nil {
		t.Fatal(err)
	}
	if kept := svc.ListSchedules().Schedules[0]; !kept.CatchUp {
		t.Fatalf("toggling enabled dropped catch-up: %+v", kept)
	}
}

// 停止一条执行器承担的调度运行：取消入口写停止标记，执行器看到就收尾，记录落 cancelled。
func TestCancellingAScheduledRunStopsTheExecutor(t *testing.T) {
	svc, _ := newRunSvc(t)
	if _, err := svc.SaveSchedule(ScheduleInput{ID: "check", Name: "Check", Enabled: true, Cron: "7 * * * *",
		TargetKind: "action", TargetID: "sleep"}); err != nil {
		t.Fatal(err)
	}
	if err := svc.RunScheduleNow("check"); err != nil {
		t.Fatal(err)
	}
	waitRegistered(t, svc.running, "sleep", true)
	svc.CancelAction("sleep")

	runs := waitRuns(t, svc, 1, func(runs []RunItem) bool { return allSettled(runs) })
	if len(runs) != 1 || runs[0].Status != runstore.StatusCancelled {
		t.Fatalf("stopped scheduled run = %+v", runs)
	}
	waitRegistered(t, svc.running, "sleep", false)
	item := waitForSchedule(t, svc, "check", func(item ScheduleItem) bool { return item.LastRun != nil && !item.Running })
	if item.LastRun.Status != runstore.StatusCancelled {
		t.Fatalf("schedule card after a stop = %+v", item.LastRun)
	}
}

// 应用重启时执行器还在跑：认领它——调度卡仍显示运行中，并且停得掉。
func TestRestartClaimsRunningExecutorAndCanStopIt(t *testing.T) {
	svc, dir := newRunSvc(t)
	if _, err := svc.SaveSchedule(ScheduleInput{ID: "check", Name: "Check", Enabled: true, Cron: "7 * * * *",
		TargetKind: "action", TargetID: "sleep"}); err != nil {
		t.Fatal(err)
	}
	if err := svc.RunScheduleNow("check"); err != nil {
		t.Fatal(err)
	}
	waitRegistered(t, svc.running, "sleep", true)
	oldRun := svc.ListRuns(RunFilter{Status: runstore.StatusRunning}).Runs[0]
	// 等执行器真的接手（记录里有了它的 pid 与心跳）再「重启」：接手之前进程身份无从核对
	waitExecutedBy(t, svc, oldRun.ID)

	// 重启：同一个应用目录再建一个 service。原实例的核对协程从没启动过（没调 ServiceStartup）
	restarted := New(registry.Load(filepath.Join(dir, "actions"), dir), nil, dir,
		filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
	if !restarted.running.held("sleep") {
		t.Fatal("the running executor was not claimed after restart")
	}
	item := restarted.ListSchedules().Schedules[0]
	if item.LastRun == nil || item.LastRun.Status != runstore.StatusRunning || item.LastRun.RunID != oldRun.ID {
		t.Fatalf("schedule card after restart = %+v, want the in-flight run %s", item.LastRun, oldRun.ID)
	}
	restarted.CancelAction("sleep")
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		restarted.pollExecutorRuns()
		if runs := restarted.ListRuns(RunFilter{TargetID: "sleep"}).Runs; len(runs) == 1 && runs[0].Status == runstore.StatusCancelled {
			if restarted.running.held("sleep") {
				t.Fatal("a stopped run is still registered as running")
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("the claimed executor run was not stopped: %+v", restarted.ListRuns(RunFilter{}).Runs)
}

// 续跑：以同一份输入加 resume: <session_id> 发起一次新的 AI 运行。
func TestResumeRunStartsANewRunWithTheSessionID(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	if err := svc.RunAi("t-ask", map[string]any{"TOPIC": "crash"}); err != nil {
		t.Fatal(err)
	}
	first := waitRuns(t, svc, 1, allSettled)[0]

	newID, err := svc.ResumeRun(first.ID)
	if err != nil {
		t.Fatal(err)
	}
	if newID == first.ID || !strings.HasPrefix(newID, "r") {
		t.Fatalf("ResumeRun returned %q, want a new run id", newID)
	}
	runs := waitRuns(t, svc, 2, allSettled)
	var resumed RunItem
	for _, run := range runs {
		if run.ID == newID {
			resumed = run
		}
	}
	if resumed.ID == "" || resumed.Status != runstore.StatusSucceeded || resumed.TargetID != "t-ask" ||
		resumed.Params["resume"] != "sess-1" || resumed.Params["TOPIC"] != "crash" || resumed.Origin != runstore.OriginManual {
		t.Fatalf("resumed run = %+v", resumed)
	}
}

// 续跑只对 AI 运行、且上一次得留下会话 id。
func TestResumeRunRejectsWhatItCannotResume(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	if _, err := svc.ResumeRun("no-such-run"); err == nil {
		t.Fatal("resumed an unknown run")
	}
	svc, _ = newRunSvc(t)
	if err := svc.RunAction("ok", nil); err != nil {
		t.Fatal(err)
	}
	done := waitRuns(t, svc, 1, allSettled)[0]
	if _, err := svc.ResumeRun(done.ID); err == nil || !strings.Contains(err.Error(), "AI") {
		t.Fatalf("resumed a non-AI run: %v", err)
	}
}

// 续跑撞上正在运行的任务：是「手动运行撞锁」，返回「正在运行」——不能落成跳过的留痕，
// 也不能在 scheduleRuns 里造出空 schedule_id 的幻影状态。
func TestResumeRunOnBusyTargetReturnsBusyNotSkipped(t *testing.T) {
	svc, _ := newAiSvc(t, "")
	if err := svc.RunAi("t-ask", map[string]any{"TOPIC": "crash"}); err != nil {
		t.Fatal(err)
	}
	first := waitRuns(t, svc, 1, allSettled)[0]

	// 再占住任务：续跑这次发起撞上它
	if _, ok := svc.aiRunning.begin("t-ask"); !ok {
		t.Fatal("cannot reserve the AI task")
	}
	defer svc.aiRunning.end("t-ask")

	if _, err := svc.ResumeRun(first.ID); err == nil || !strings.Contains(err.Error(), "正在运行") {
		t.Fatalf("a busy target must refuse the resume with 正在运行, got %v", err)
	}
	runs := svc.ListRuns(RunFilter{TargetKind: "ai"}).Runs
	if len(runs) != 1 {
		t.Fatalf("a refused resume must not leave a run record: %+v", runs)
	}
	if _, ghost := svc.scheduleRuns[""]; ghost {
		t.Fatal("a refused resume created a phantom scheduleRuns entry with an empty id")
	}
}

// 执行器 R1 刚结束、同一目标上开始了新运行 R2：核对 R1 的结束只能清 R1 自己的登记，
// 不能按目标清掉 R2 的取消入口、释放它刚占下的锁。
func TestPollOfAFinishedExecutorRunKeepsANewerManualRunRegistered(t *testing.T) {
	svc, dir := newRunSvc(t)
	if err := svc.RunAction("sleep", nil); err != nil {
		t.Fatal(err)
	}
	waitRegistered(t, svc.running, "sleep", true)

	// 伪造一条同目标的执行器记录并直接落终态（模拟执行器刚跑完、记录先于 R2 存在）
	sess, err := svc.runs.Start(runstore.Record{
		Target: target.Target{Kind: target.Action, ID: "sleep"}, Origin: runstore.OriginSchedule,
		ScheduleID: "check", Params: map[string]any{},
		Process: &runstore.Process{Mode: runstore.ProcessExecutor},
	})
	if err != nil {
		t.Fatal(err)
	}
	exit := 0
	sess.Finish(runstore.StatusSucceeded, "", &exit, nil)
	svc.pollExecutorRun(sess.ID())

	if !svc.running.held("sleep") {
		t.Fatal("the newer manual run lost its cancellation registration")
	}
	if !targetlock.New(dir).Busy(target.Action, "sleep") {
		t.Fatal("the newer manual run's target lock was released")
	}
	// 它仍然停得掉
	svc.CancelAction("sleep")
	waitRegistered(t, svc.running, "sleep", false)
}

// 执行器把到点落成 skipped（撞上运行中的目标）：比对账把它登记为 LastRun——skipped 不覆盖
// 上一次真实运行的结果，只在「上次到点」留痕。
func TestPollOfSkippedExecutorRecordSetsLastSkipNotLastRun(t *testing.T) {
	svc, _ := scheduleService(t, "")
	if _, err := svc.SaveSchedule(validSchedule()); err != nil {
		t.Fatal(err)
	}
	sess, err := svc.runs.Start(runstore.Record{
		Target: target.Target{Kind: target.Action, ID: "patrol"}, Origin: runstore.OriginSchedule,
		ScheduleID: "check", Params: map[string]any{},
		Process: &runstore.Process{Mode: runstore.ProcessExecutor},
	})
	if err != nil {
		t.Fatal(err)
	}
	sess.Finish(runstore.StatusSkipped, `动作 "patrol" 正在运行`, nil, nil)
	svc.pollExecutorRun(sess.ID())

	item := svc.ListSchedules().Schedules[0]
	if item.LastRun != nil {
		t.Fatalf("a skipped executor run must not become LastRun: %+v", item.LastRun)
	}
	if item.LastSkip == nil || !strings.Contains(item.LastSkip.Reason, "正在运行") {
		t.Fatalf("the skip must be noted as last skipped: %+v", item.LastSkip)
	}
}
