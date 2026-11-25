package runstore

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"workflow-tool/internal/applog"
	"workflow-tool/internal/procinfo"
)

// 执行器（M4）：调度到点与立即运行交给独立进程。应用这边要认领仍在运行的执行器、
// 给确认不在的留中断、把停止请求递过去；执行器那边要接着写运行日志与心跳。

func neverAlive(int, string) bool  { return false }
func alwaysAlive(int, string) bool { return true }

// executorStore 以应用的身份打开 dir；alive 决定「某个 pid 是不是那个进程」，now 是时钟。
func executorStore(t *testing.T, dir string, alive AliveFunc, now func() time.Time) *Store {
	t.Helper()
	logger, err := applog.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = logger.Close() })
	store, err := open(dir, logger, options{alive: alive, now: now})
	if err != nil {
		t.Fatal(err)
	}
	return store
}

// executorRun 以应用的身份发起一条「交给执行器」的运行并交出记录；随后把盘上的进程信息
// 与心跳改写成指定值，模拟执行器已经接手。
func executorRun(t *testing.T, app *Store, heartbeatAt string) string {
	t.Helper()
	sess, err := app.Start(Record{Target: Target{Kind: KindAI, ID: "review-bot"}, Origin: OriginSchedule,
		ScheduleID: "nightly", Params: map[string]any{}, Process: &Process{Mode: ProcessExecutor}})
	if err != nil {
		t.Fatal(err)
	}
	sess.Detach() // 应用把记录交给执行器，自己不再写
	if heartbeatAt != "" {
		rec, err := app.Get(sess.ID())
		if err != nil {
			t.Fatal(err)
		}
		rec.Process.PID, rec.Process.StartedAt, rec.Process.HeartbeatAt = 4242, "2026-11-01T00:00:00+08:00", heartbeatAt
		data, err := encodeJSONIndent(rec)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(app.dir, sess.ID(), RecordFile), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return sess.ID()
}

var claimClock = time.Date(2026, 11, 25, 10, 0, 0, 0, time.Local)

// 心跳新鲜的执行器运行：认领，仍是 running。
func TestReopenClaimsExecutorWithFreshHeartbeat(t *testing.T) {
	dir := t.TempDir()
	id := executorRun(t, executorStore(t, dir, neverAlive, time.Now), claimClock.Add(-5*time.Second).Format(time.RFC3339Nano))

	reopened := executorStore(t, dir, neverAlive, func() time.Time { return claimClock })
	if rec := reopened.List(Filter{})[0]; rec.Status != StatusRunning || rec.ID != id {
		t.Fatalf("executor run with a fresh heartbeat = %+v, want still running", rec)
	}
}

// 心跳过期但进程仍在（比如机器刚从睡眠恢复）：再等，不改写。
func TestReopenKeepsExecutorWhoseProcessIsAlive(t *testing.T) {
	dir := t.TempDir()
	executorRun(t, executorStore(t, dir, neverAlive, time.Now), claimClock.Add(-2*time.Minute).Format(time.RFC3339Nano))

	reopened := executorStore(t, dir, alwaysAlive, func() time.Time { return claimClock })
	if rec := reopened.List(Filter{})[0]; rec.Status != StatusRunning {
		t.Fatalf("stale heartbeat but live process = %+v, want still running", rec)
	}
}

// 心跳过期、进程也不在：中断留档，原因说明是执行器退出。
func TestReopenInterruptsExecutorWhoseProcessIsGone(t *testing.T) {
	dir := t.TempDir()
	id := executorRun(t, executorStore(t, dir, neverAlive, time.Now), claimClock.Add(-2*time.Minute).Format(time.RFC3339Nano))

	reopened := executorStore(t, dir, neverAlive, func() time.Time { return claimClock })
	rec := readRecord(t, dir, id)
	if rec.Status != StatusInterrupted || rec.Reason != ExecutorInterruptedReason || rec.FinishedAt != nil {
		t.Fatalf("dead executor run = %+v", rec)
	}
	if got := reopened.List(Filter{})[0].Status; got != StatusInterrupted {
		t.Fatalf("index still says %q", got)
	}
}

// 应用内的运行照旧：应用重启即中断，原因不变。
func TestReopenStillInterruptsInAppRuns(t *testing.T) {
	dir := t.TempDir()
	executorStore(t, dir, alwaysAlive, time.Now).Start(aiRecord("nightly"))

	reopened := executorStore(t, dir, alwaysAlive, time.Now)
	if rec := reopened.List(Filter{})[0]; rec.Status != StatusInterrupted || rec.Reason != InterruptedReason {
		t.Fatalf("in-app run across restart = %+v", rec)
	}
}

// Attach 让执行器接着写同一条记录：进程信息换成执行器自己的，日志续在同一个文件里，
// 心跳写回 run.json，终态由执行器落。
func TestAttachResumesRecordForExecutor(t *testing.T) {
	dir := t.TempDir()
	id := executorRun(t, executorStore(t, dir, neverAlive, time.Now), "")

	sess, err := Attach(dir, id)
	if err != nil {
		t.Fatal(err)
	}
	pid, startedAt := procinfo.Self()
	rec := readRecord(t, dir, id)
	if rec.Status != StatusRunning || rec.Process == nil || rec.Process.Mode != ProcessExecutor ||
		rec.Process.PID != pid || rec.Process.StartedAt != startedAt || rec.Process.HeartbeatAt == "" {
		t.Fatalf("after attach run.json = %+v / process %+v", rec, rec.Process)
	}

	sess.Output(map[string]any{"stream": "stdout", "line": "hello", "seq": 1})
	clock := time.Now().Add(time.Minute)
	sess.store.now = func() time.Time { return clock }
	sess.Heartbeat()
	if hb := readRecord(t, dir, id).Process.HeartbeatAt; hb != clock.Format(time.RFC3339Nano) {
		t.Fatalf("heartbeat_at = %q, want the moment Heartbeat was called", hb)
	}

	exit := 0
	if !sess.Finish(StatusSucceeded, "", &exit, map[string]string{"text": "done"}) {
		t.Fatal("executor could not write the terminal state")
	}
	if final := readRecord(t, dir, id); final.Status != StatusSucceeded || final.ExitCode == nil || *final.ExitCode != 0 || final.Outputs["text"] != "done" {
		t.Fatalf("terminal record = %+v", final)
	}
	events, _ := executorStore(t, dir, neverAlive, time.Now).Events(id)
	if len(events) != 1 || events[0].Line != "hello" || events[0].T < 0 || events[0].Seq != 1 {
		t.Fatalf("events after attach = %+v", events)
	}
}

// 已经终结的记录不能再被接手：终态只写一次。
func TestAttachRejectsFinishedOrUnknownRun(t *testing.T) {
	dir := t.TempDir()
	sess, err := executorStore(t, dir, neverAlive, time.Now).Start(aiRecord("nightly"))
	if err != nil {
		t.Fatal(err)
	}
	finishNow(sess)
	if _, err := Attach(dir, sess.ID()); err == nil {
		t.Fatal("attached to a finished run")
	}
	if _, err := Attach(dir, "no-such-run"); err == nil {
		t.Fatal("attached to a missing run")
	}
	if _, err := Attach(dir, "../escape"); err == nil {
		t.Fatal("attached through a path that is not a run id")
	}
}

// 执行器自己写完终态：Poll 从盘上看到，应用这边的索引随之更新。
func TestPollSeesTerminalStateWrittenByExecutor(t *testing.T) {
	dir := t.TempDir()
	app := executorStore(t, dir, neverAlive, time.Now)
	id := executorRun(t, app, "")

	executor, err := Attach(dir, id)
	if err != nil {
		t.Fatal(err)
	}
	executor.Output(map[string]any{"stream": "ai", "line": "…", "seq": 1})
	if _, ended := app.Poll(id); ended {
		t.Fatal("poll reported an end while the executor is still writing")
	}
	exit := 1
	executor.Finish(StatusFailed, "boom", &exit, nil)

	rec, ended := app.Poll(id)
	if !ended || rec.Status != StatusFailed || rec.Reason != "boom" {
		t.Fatalf("poll = (%+v, %v), want the executor's failed terminal state", rec, ended)
	}
	if got := app.List(Filter{})[0].Status; got != StatusFailed {
		t.Fatalf("index still says %q", got)
	}
	if _, ended := app.Poll(id); ended {
		t.Fatal("a finished run must not report an end twice")
	}
}

// 应用开着的时候执行器没了：心跳过期且进程不在 → Poll 改写为中断。
func TestPollInterruptsExecutorThatDiedWhileAppWasOpen(t *testing.T) {
	dir := t.TempDir()
	app := executorStore(t, dir, neverAlive, func() time.Time { return claimClock })
	id := executorRun(t, app, claimClock.Format(time.RFC3339Nano))

	if _, ended := app.Poll(id); ended {
		t.Fatal("fresh heartbeat must not end the run")
	}
	stale := claimClock.Add(HeartbeatStale + time.Minute)
	app.now = func() time.Time { return stale }
	rec, ended := app.Poll(id)
	if !ended || rec.Status != StatusInterrupted || rec.Reason != ExecutorInterruptedReason {
		t.Fatalf("poll after the executor died = (%+v, %v)", rec, ended)
	}
}

// Poll 只管执行器运行：应用内自己的运行不读盘、不改写。
func TestPollIgnoresInAppRuns(t *testing.T) {
	dir := t.TempDir()
	app := executorStore(t, dir, neverAlive, time.Now)
	sess, err := app.Start(aiRecord("nightly"))
	if err != nil {
		t.Fatal(err)
	}
	if _, ended := app.Poll(sess.ID()); ended {
		t.Fatal("poll touched an in-app run")
	}
	if rec := readRecord(t, dir, sess.ID()); rec.Status != StatusRunning {
		t.Fatalf("in-app run was rewritten: %+v", rec)
	}
}

// 停止标记：应用写下，执行器轮询到就取消；终态落定后标记一并清掉。
func TestRequestStopWritesMarkerThatFinishClears(t *testing.T) {
	dir := t.TempDir()
	app := executorStore(t, dir, neverAlive, time.Now)
	id := executorRun(t, app, "")
	stop := filepath.Join(dir, DirName, id, StopFile)

	if err := app.RequestStop(id); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stop); err != nil {
		t.Fatalf("stop marker was not written: %v", err)
	}
	if err := app.RequestStop("no-such-run"); err == nil {
		t.Fatal("writing a stop marker for a run without a directory must fail")
	}

	sess, _ := Attach(dir, id)
	finishNow(sess)
	if _, err := os.Stat(stop); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stop marker survived the terminal state: %v", err)
	}
}

// 错过的到点留一条 missed：是终态、没有过程，自己按配额封顶，且不挤占真实运行的保留配额。
func TestMissedNotesAreCappedAndNeverEvictRealRuns(t *testing.T) {
	store, _, _ := newStore(t)
	store.opts.keepPerTarget = 2
	for i := range 3 {
		if _, err := store.Note(aiRecord("nightly"), StatusMissed, fmt.Sprintf("应用未在运行，错过第 %d 次到点", i)); err != nil {
			t.Fatal(err)
		}
	}
	missed := store.List(Filter{Status: StatusMissed})
	if len(missed) != 2 {
		t.Fatalf("kept %d missed notes, want the cap of 2", len(missed))
	}
	events, _ := store.Events(missed[0].ID)
	if len(events) != 0 {
		t.Fatalf("a missed note must not have an event log: %+v", events)
	}

	for range 3 {
		real, err := store.Start(aiRecord("nightly"))
		if err != nil {
			t.Fatal(err)
		}
		finishNow(real)
	}
	if got := len(store.List(Filter{Status: StatusSucceeded})); got != 2 {
		t.Fatalf("kept %d real runs, want the cap of 2", got)
	}
	if latest, ok := store.Latest(KindAI, "review-bot", "", true); !ok || latest.Status != StatusSucceeded {
		t.Fatalf("latest real run = (%+v, %v); missed notes must not shadow it", latest, ok)
	}
}
