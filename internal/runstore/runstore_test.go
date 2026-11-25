package runstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"workflow-tool/internal/applog"
	"workflow-tool/internal/procinfo"
)

func newStore(t *testing.T) (*Store, string, *applog.Logger) {
	t.Helper()
	dir := t.TempDir()
	logger, err := applog.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = logger.Close() })
	store, err := open(dir, logger, options{})
	if err != nil {
		t.Fatal(err)
	}
	return store, dir, logger
}

func aiRecord(scheduleID string) Record {
	return Record{
		Target:     Target{Kind: KindAI, ID: "review-bot"},
		Origin:     OriginSchedule,
		ScheduleID: scheduleID,
		Params:     map[string]any{"prompt": "只看崩溃线程", "TOPIC": "crash"},
	}
}

func readRecord(t *testing.T, dir, id string) Record {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, DirName, id, RecordFile))
	if err != nil {
		t.Fatal(err)
	}
	var rec Record
	if err := json.Unmarshal(data, &rec); err != nil {
		t.Fatalf("run.json is not valid JSON: %v\n%s", err, data)
	}
	return rec
}

func readEventLines(t *testing.T, dir, id string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, DirName, id, EventsFile))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		if line == "" {
			continue
		}
		var ev map[string]any
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("events.ndjson holds a non-JSON line %q: %v", line, err)
		}
		out = append(out, ev)
	}
	return out
}

func finishNow(s *Session) {
	s.Finish(StatusSucceeded, "", intPtr(0), nil)
}

func intPtr(i int) *int { return &i }

func TestOpenWithNoRunsIsEmpty(t *testing.T) {
	store, dir, _ := newStore(t)
	if got := store.List(Filter{}); len(got) != 0 {
		t.Fatalf("empty store listed %v", got)
	}
	if _, err := os.Stat(filepath.Join(dir, DirName)); !os.IsNotExist(err) {
		t.Fatalf("Open created %s/ before any run: %v", DirName, err)
	}
}

func TestStartWritesRunningRecordAndEventsLog(t *testing.T) {
	store, dir, _ := newStore(t)
	s, err := store.Start(aiRecord("nightly"))
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^r\d{8}-\d{6}-[0-9a-f]{6}$`).MatchString(s.ID()) {
		t.Fatalf("run id = %q, want r<YYYYMMDD-HHMMSS>-<6 hex>", s.ID())
	}
	if _, err := os.Stat(filepath.Join(dir, DirName, s.ID(), RecordFile)); err != nil {
		t.Fatalf("directory name is not the run id: %v", err)
	}
	rec := readRecord(t, dir, s.ID())
	if rec.ID != s.ID() || rec.Status != StatusRunning || rec.Target.Kind != KindAI || rec.Target.ID != "review-bot" ||
		rec.Origin != OriginSchedule || rec.ScheduleID != "nightly" || rec.FinishedAt != nil || rec.StartedAt.IsZero() {
		t.Fatalf("running record = %+v", rec)
	}
	if rec.Params["prompt"] != "只看崩溃线程" || rec.Process == nil || rec.Process.Mode != ProcessInApp || rec.Process.PID != os.Getpid() {
		t.Fatalf("params/process not persisted: %+v", rec)
	}
	// 进程启动时刻随每条记录落档（认领时与 pid 一起核对进程身份）；同一进程内恒定
	if _, startedAt := procinfo.Self(); rec.Process.StartedAt != startedAt {
		t.Fatalf("process start time not archived: %+v", rec.Process)
	}

	s.Output(map[string]any{"stream": "ai", "line": "你好", "seq": 1})
	s.Output(map[string]any{"stream": "ai-tool", "line": `{"id":"t1","name":"Read"}`, "step": "0"})
	s.Done(map[string]any{"exitCode": 0, "err": "", "duration": "1.5s", "seq": 3})

	lines := readEventLines(t, dir, s.ID())
	if len(lines) != 3 {
		t.Fatalf("events = %d lines, want 3", len(lines))
	}
	for i, line := range lines {
		if _, ok := line["t"].(float64); !ok {
			t.Fatalf("line %d has no relative timestamp: %v", i, line)
		}
	}
	if lines[0]["event"] != "output" || lines[0]["stream"] != "ai" || lines[0]["line"] != "你好" || lines[0]["seq"] != float64(1) {
		t.Fatalf("first output event = %v", lines[0])
	}
	if lines[1]["step"] != "0" || lines[1]["stream"] != "ai-tool" {
		t.Fatalf("second output event = %v", lines[1])
	}
	if lines[2]["event"] != "done" || lines[2]["exitCode"] != float64(0) || lines[2]["duration"] != "1.5s" {
		t.Fatalf("done event = %v", lines[2])
	}
}

func TestFinishWritesTerminalStateExactlyOnce(t *testing.T) {
	store, dir, _ := newStore(t)
	s, err := store.Start(aiRecord(""))
	if err != nil {
		t.Fatal(err)
	}
	rules := "# 无人值守守则\n自行决断。"
	s.SetRules(rules)
	s.Output(map[string]any{"stream": "stdout", "line": "x", "seq": 1})
	code := 1
	if !s.Finish(StatusFailed, "超时", &code, map[string]string{"session_id": "sess-1", "cost_usd": "0.12"}) {
		t.Fatal("first Finish was refused")
	}
	first := readRecord(t, dir, s.ID())
	if first.Status != StatusFailed || first.Reason != "超时" || first.FinishedAt == nil || first.ExitCode == nil || *first.ExitCode != 1 {
		t.Fatalf("terminal record = %+v", first)
	}
	if first.Outputs["session_id"] != "sess-1" || first.Outputs["cost_usd"] != "0.12" || first.Rules != rules {
		t.Fatalf("outputs/rules not persisted: %+v", first)
	}
	if !first.FinishedAt.After(first.StartedAt) && !first.FinishedAt.Equal(first.StartedAt) {
		t.Fatalf("finished_at precedes started_at: %+v", first)
	}
	// 磁盘上的 JSON 键名遵循规格的 snake_case；空的可选字段省略
	raw, _ := os.ReadFile(filepath.Join(dir, DirName, s.ID(), RecordFile))
	for _, key := range []string{`"id"`, `"target"`, `"origin"`, `"params"`, `"status"`, `"reason"`,
		`"started_at"`, `"finished_at"`, `"exit_code"`, `"outputs"`, `"process"`, `"rules"`} {
		if !strings.Contains(string(raw), key) {
			t.Fatalf("run.json lacks %s: %s", key, raw)
		}
	}
	if strings.Contains(string(raw), "schedule_id") {
		t.Fatalf("empty schedule_id should be omitted: %s", raw)
	}

	// 终态只写一次：任何路径不得二次改写
	if s.Finish(StatusSucceeded, "", intPtr(0), nil) {
		t.Fatal("second Finish was accepted")
	}
	// 会话结束后不再接收事件
	s.Output(map[string]any{"stream": "stdout", "line": "late", "seq": 2})
	if again := readRecord(t, dir, s.ID()); again.Status != StatusFailed || again.Reason != "超时" {
		t.Fatalf("terminal state was rewritten: %+v", again)
	}
	if lines := readEventLines(t, dir, s.ID()); len(lines) != 1 {
		t.Fatalf("late event appended after finish: %v", lines)
	}
}

func TestFinishWithoutCodeOmitsExitCode(t *testing.T) {
	store, dir, _ := newStore(t)
	s, _ := store.Start(aiRecord(""))
	if !s.Finish(StatusCancelled, "", nil, nil) {
		t.Fatal("Finish was refused")
	}
	raw, _ := os.ReadFile(filepath.Join(dir, DirName, s.ID(), RecordFile))
	if strings.Contains(string(raw), "exit_code") || strings.Contains(string(raw), "outputs") {
		t.Fatalf("absent fields should be omitted: %s", raw)
	}
}

func TestReopenMarksStaleRunningAsInterrupted(t *testing.T) {
	store, dir, logger := newStore(t)
	s, _ := store.Start(aiRecord("nightly"))
	done, _ := store.Start(Record{Target: Target{Kind: KindAction, ID: "patrol"}, Origin: OriginManual, Params: map[string]any{}})
	finishNow(done)

	// 模拟应用退出：不 Finish，直接丢弃 Store，再按下次启动重新打开
	reopened, err := open(dir, logger, options{})
	if err != nil {
		t.Fatal(err)
	}
	rec := readRecord(t, dir, s.ID())
	// 结束时刻不可知：不编造 finished_at，原因里说明
	if rec.Status != StatusInterrupted || rec.Reason == "" || rec.FinishedAt != nil {
		t.Fatalf("stale running record = %+v", rec)
	}
	if kept := readRecord(t, dir, done.ID()); kept.Status != StatusSucceeded {
		t.Fatalf("terminal record must not be touched on reopen: %+v", kept)
	}
	if got := len(reopened.List(Filter{})); got != 2 {
		t.Fatalf("reopened index has %d records, want 2", got)
	}
	logData, _ := os.ReadFile(filepath.Join(dir, applog.DirName, applog.FileName))
	if !strings.Contains(string(logData), `"event":"run.interrupted"`) || !strings.Contains(string(logData), s.ID()) {
		t.Fatalf("interruption not logged: %s", logData)
	}
}

func TestReopenToleratesCorruptAndForeignEntries(t *testing.T) {
	store, dir, logger := newStore(t)
	s, _ := store.Start(aiRecord(""))
	finishNow(s)
	runs := filepath.Join(dir, DirName)
	for name, body := range map[string]string{
		"r20260101-000000-badbad": "{not json",
		"r20260101-000000-empty1": "",
	} {
		if err := os.MkdirAll(filepath.Join(runs, name), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(runs, name, RecordFile), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(runs, "stray-file"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(runs, "no-record"), 0o755); err != nil {
		t.Fatal(err)
	}
	reopened, err := open(dir, logger, options{})
	if err != nil {
		t.Fatalf("corrupt entries must not block startup: %v", err)
	}
	if got := len(reopened.List(Filter{})); got != 1 {
		t.Fatalf("valid record lost among corrupt entries: %d", got)
	}
	logData, _ := os.ReadFile(filepath.Join(dir, applog.DirName, applog.FileName))
	if strings.Count(string(logData), `"event":"run.record.unreadable"`) != 2 {
		t.Fatalf("corrupt records not reported once each: %s", logData)
	}
	// 损坏的目录原样保留，不被清理逻辑当成自己的记录删除
	if _, err := os.Stat(filepath.Join(runs, "r20260101-000000-badbad")); err != nil {
		t.Fatalf("foreign entry removed: %v", err)
	}
}

func TestListSortsNewestFirstAndFilters(t *testing.T) {
	store, _, _ := newStore(t)
	base := time.Date(2026, 11, 25, 2, 0, 0, 0, time.Local)
	store.now = func() time.Time { return base.Add(time.Hour) }
	type spec struct {
		target Target
		origin string
		status string
		sched  string
	}
	specs := []spec{
		{Target{Kind: KindAI, ID: "review-bot"}, OriginSchedule, StatusSucceeded, "nightly"},
		{Target{Kind: KindAction, ID: "patrol"}, OriginManual, StatusFailed, ""},
		{Target{Kind: KindWorkflow, ID: "daily"}, OriginRunNow, StatusSucceeded, "noon"},
		{Target{Kind: KindAI, ID: "review-bot"}, OriginManual, StatusSkipped, ""},
	}
	sessions := make([]*Session, len(specs))
	for i, sp := range specs {
		store.now = func() time.Time { return base.Add(time.Duration(i) * time.Minute) }
		s, err := store.Start(Record{Target: sp.target, Origin: sp.origin, ScheduleID: sp.sched, Params: map[string]any{}})
		if err != nil {
			t.Fatal(err)
		}
		sessions[i] = s
	}
	store.now = func() time.Time { return base.Add(time.Hour) }
	for i, sp := range specs {
		status := sp.status
		if status == StatusSkipped {
			status = StatusSucceeded
		}
		finishWith(sessions[i], status)
	}

	ids := func(recs []Record) []string {
		out := make([]string, len(recs))
		for i, r := range recs {
			out[i] = r.ID
		}
		return out
	}
	want := []string{sessions[3].ID(), sessions[2].ID(), sessions[1].ID(), sessions[0].ID()}
	if got := ids(store.List(Filter{})); !equalStrings(got, want) {
		t.Fatalf("List order = %v, want newest first %v", got, want)
	}
	if got := store.List(Filter{TargetKind: KindAI}); len(got) != 2 || got[0].ID != sessions[3].ID() || got[1].ID != sessions[0].ID() {
		t.Fatalf("kind filter = %+v", got)
	}
	if got := store.List(Filter{TargetKind: KindAction, TargetID: "patrol"}); len(got) != 1 || got[0].ID != sessions[1].ID() {
		t.Fatalf("target filter = %+v", got)
	}
	if got := store.List(Filter{Status: StatusSucceeded}); len(got) != 3 {
		t.Fatalf("status filter = %v", ids(got))
	}
	if got := store.List(Filter{Origin: OriginSchedule}); len(got) != 1 || got[0].ScheduleID != "nightly" {
		t.Fatalf("origin filter = %+v", got)
	}
	if got := store.List(Filter{Limit: 2}); len(got) != 2 || got[0].ID != sessions[3].ID() {
		t.Fatalf("limit = %v", ids(got))
	}
	if got := store.List(Filter{TargetKind: KindWorkflow, TargetID: "daily"}); got[0].Origin != OriginRunNow || got[0].ScheduleID != "noon" {
		t.Fatalf("origin/schedule not indexed: %+v", got[0])
	}
}

func finishWith(s *Session, status string) {
	s.Finish(status, "", intPtr(0), nil)
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestLatestReturnsNewestMatchAndCanSkipSkipped(t *testing.T) {
	store, _, _ := newStore(t)
	base := time.Date(2026, 11, 25, 2, 0, 0, 0, time.Local)
	store.now = func() time.Time { return base }
	real, _ := store.Start(aiRecord("nightly"))
	finishWith(real, StatusSucceeded)
	store.now = func() time.Time { return base.Add(time.Minute) }
	skipped, err := store.Note(aiRecord("nightly"), StatusSkipped, "目标正在运行")
	if err != nil {
		t.Fatal(err)
	}
	manual, _ := store.Start(Record{Target: Target{Kind: KindAI, ID: "review-bot"}, Origin: OriginManual, Params: map[string]any{}})
	finishWith(manual, StatusFailed)

	got, ok := store.Latest(KindAI, "review-bot", "nightly", true)
	if !ok || got.ID != real.ID() {
		t.Fatalf("schedule's latest real run = %+v ok=%v", got, ok)
	}
	got, ok = store.Latest(KindAI, "review-bot", "nightly", false)
	if !ok || got.ID != skipped.ID() || got.Status != StatusSkipped {
		t.Fatalf("schedule's latest including skipped = %+v ok=%v", got, ok)
	}
	got, ok = store.Latest(KindAI, "review-bot", "", true)
	if !ok || got.ID != manual.ID() {
		t.Fatalf("target's latest regardless of schedule = %+v ok=%v", got, ok)
	}
	if _, ok := store.Latest(KindAI, "nobody", "", false); ok {
		t.Fatal("unknown target must not match")
	}
	// LatestScheduled 不论结果：此刻该调度最新一条是 skipped
	if got, ok := store.LatestScheduled("nightly"); !ok || got.ID != skipped.ID() {
		t.Fatalf("LatestScheduled = %+v ok=%v, want the skip", got, ok)
	}
	store.now = func() time.Time { return base.Add(2 * time.Minute) }
	later, _ := store.Start(aiRecord("nightly"))
	finishWith(later, StatusSucceeded)
	if got, ok := store.LatestScheduled("nightly"); !ok || got.ID != later.ID() {
		t.Fatalf("LatestScheduled after a real run = %+v ok=%v", got, ok)
	}
	if _, ok := store.LatestScheduled("nobody"); ok {
		t.Fatal("unknown schedule must not match")
	}
}

func TestSkipWritesTerminalRecordWithoutEventLog(t *testing.T) {
	store, dir, _ := newStore(t)
	skipped, err := store.Note(aiRecord("nightly"), StatusSkipped, "目标正在运行")
	if err != nil {
		t.Fatal(err)
	}
	got := readRecord(t, dir, skipped.ID())
	if got.Status != StatusSkipped || got.Reason != "目标正在运行" || got.FinishedAt == nil || got.ExitCode != nil || got.Process != nil {
		t.Fatalf("skipped record = %+v", got)
	}
	// 没有运行过程的记录不接受事件，也不可再改写终态
	skipped.Output(map[string]any{"stream": "stdout", "line": "x", "seq": 1})
	if skipped.Finish(StatusSucceeded, "", nil, nil) {
		t.Fatal("noted record accepted a second terminal state")
	}
	if lines := readEventLines(t, dir, skipped.ID()); len(lines) != 0 {
		t.Fatalf("noted record logged events: %v", lines)
	}
	// 启动失败同样是没有过程的运行：留一条 failed 终态
	failed, err := store.Note(Record{Target: Target{Kind: KindAction, ID: "patrol"}, Origin: OriginSchedule, ScheduleID: "check"},
		StatusFailed, "未知动作")
	if err != nil {
		t.Fatal(err)
	}
	if got := readRecord(t, dir, failed.ID()); got.Status != StatusFailed || got.Reason != "未知动作" || got.ScheduleID != "check" {
		t.Fatalf("failed note = %+v", got)
	}
	if _, err := os.Stat(filepath.Join(dir, DirName, skipped.ID(), EventsFile)); !os.IsNotExist(err) {
		t.Fatalf("skipped run must not create an event log: %v", err)
	}
}

// base 是保留策略测试共用的起点时刻。
var base = time.Date(2026, 11, 25, 2, 0, 0, 0, time.Local)

func TestPruneKeepsFiftyPerTargetAndDropsExpired(t *testing.T) {
	store, dir, _ := newStore(t)
	store.now = func() time.Time { return base }
	var old *Session
	// 同一目标 51 次：最老的一次被清掉
	var ids []string
	for i := 0; i < 51; i++ {
		// 启动时刻逐秒递增：「最老」= 最先创建的那次
		store.now = func() time.Time { return base.Add(time.Duration(i) * time.Second) }
		s, err := store.Start(Record{Target: Target{Kind: KindAction, ID: "patrol"}, Origin: OriginManual, Params: map[string]any{}})
		if err != nil {
			t.Fatal(err)
		}
		finishWith(s, StatusSucceeded)
		ids = append(ids, s.ID())
	}
	store.now = func() time.Time { return base }
	if got := len(store.List(Filter{TargetKind: KindAction})); got != KeepPerTarget {
		t.Fatalf("kept %d runs, want %d", got, KeepPerTarget)
	}
	if _, err := os.Stat(filepath.Join(dir, DirName, ids[0])); !os.IsNotExist(err) {
		t.Fatalf("oldest run beyond the per-target cap survived: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, DirName, ids[1])); err != nil {
		t.Fatalf("run inside the cap removed: %v", err)
	}
	// 超过 30 天的记录一律清理，但正在运行的不动
	store.now = func() time.Time { return base.Add(-40 * 24 * time.Hour) }
	old, _ = store.Start(Record{Target: Target{Kind: KindWorkflow, ID: "daily"}, Origin: OriginManual, Params: map[string]any{}})
	finishWith(old, StatusSucceeded)
	running, _ := store.Start(Record{Target: Target{Kind: KindWorkflow, ID: "daily"}, Origin: OriginManual, Params: map[string]any{}})
	store.now = func() time.Time { return base }
	// 触发一次清理：再起一个运行
	trigger, _ := store.Start(Record{Target: Target{Kind: KindAI, ID: "x"}, Origin: OriginManual, Params: map[string]any{}})
	finishWith(trigger, StatusSucceeded)
	if _, err := os.Stat(filepath.Join(dir, DirName, old.ID())); !os.IsNotExist(err) {
		t.Fatalf("expired run survived: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, DirName, running.ID())); err != nil {
		t.Fatalf("expired-but-running run removed: %v", err)
	}
}

func TestEventLogStopsAtSizeLimit(t *testing.T) {
	dir := t.TempDir()
	store, err := open(dir, nil, options{maxEventLogBytes: 200})
	if err != nil {
		t.Fatal(err)
	}
	s, _ := store.Start(Record{Target: Target{Kind: KindAction, ID: "patrol"}, Origin: OriginManual, Params: map[string]any{}})
	payload := strings.Repeat("x", 60)
	for i := 1; i <= 20; i++ {
		s.Output(map[string]any{"stream": "stdout", "line": payload, "seq": i})
	}
	finishWith(s, StatusSucceeded)
	lines := readEventLines(t, dir, s.ID())
	data, _ := os.ReadFile(filepath.Join(dir, DirName, s.ID(), EventsFile))
	if len(data) > 200+len(`{"event":"truncated","limit":200,"t":123456789}`) {
		t.Fatalf("event log grew past its limit: %d bytes", len(data))
	}
	if len(lines) == 0 || lines[len(lines)-1]["event"] != "truncated" || lines[len(lines)-1]["limit"] != float64(200) {
		t.Fatalf("event log lacks a trailing truncated marker: %v", lines[len(lines)-1])
	}
	// 上限之前写入的行都是完整的
	for i, line := range lines[:len(lines)-1] {
		if line["event"] != "output" || line["line"] != payload {
			t.Fatalf("line %d torn: %v", i, line)
		}
	}
}

func TestGetReturnsFullRecordAndEvents(t *testing.T) {
	store, _, _ := newStore(t)
	s, _ := store.Start(aiRecord("nightly"))
	s.SetRules("rules text")
	s.Output(map[string]any{"stream": "ai", "line": "hi", "seq": 1})
	s.Output(map[string]any{"stream": "ai", "line": "there", "seq": 2})
	s.Done(map[string]any{"exitCode": 0, "err": "", "duration": "1s", "seq": 3, "readout": map[string]any{"costUsd": 0.5}})
	s.Finish(StatusSucceeded, "", intPtr(0), map[string]string{"text": "hithere"})

	got, err := store.Get(s.ID())
	if err != nil {
		t.Fatal(err)
	}
	if got.Outputs["text"] != "hithere" || got.Rules != "rules text" || got.Status != StatusSucceeded {
		t.Fatalf("Get = %+v", got)
	}
	events, err := store.Events(s.ID())
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 || events[0].Event != "output" || events[0].Stream != "ai" || events[0].Line != "hi" || events[0].Seq != 1 || events[0].T < 0 {
		t.Fatalf("events = %+v", events)
	}
	if events[2].Event != "done" || events[2].ExitCode != 0 || events[2].Duration != "1s" || events[2].Readout["costUsd"] != 0.5 || events[2].Seq != 3 {
		t.Fatalf("done event = %+v", events[2])
	}
	if _, err := store.Get("r20260101-000000-nope"); err == nil {
		t.Fatal("unknown run id must not resolve")
	}
	// 时间戳单调不减
	for i := 1; i < len(events); i++ {
		if events[i].T < events[i-1].T {
			t.Fatalf("event timestamps went backwards: %+v", events)
		}
	}
}

func TestEventsOfSkippedRunAreEmpty(t *testing.T) {
	store, _, _ := newStore(t)
	skipped, _ := store.Note(aiRecord(""), StatusSkipped, "目标正在运行")
	events, err := store.Events(skipped.ID())
	if err != nil || len(events) != 0 {
		t.Fatalf("events = %v, err = %v", events, err)
	}
}

func TestStartRejectsUnencodableParamsWithoutLeavingDirectory(t *testing.T) {
	store, dir, _ := newStore(t)
	if _, err := store.Start(Record{Target: Target{Kind: KindAction, ID: "patrol"}, Origin: OriginManual,
		Params: map[string]any{"bad": make(chan int)}}); err == nil {
		t.Fatal("unencodable params accepted")
	}
	entries, _ := os.ReadDir(filepath.Join(dir, DirName))
	if len(entries) != 0 {
		t.Fatalf("rejected start left directories behind: %v", entries)
	}
}

func TestNilSessionAndNilStoreAreSafe(t *testing.T) {
	var session *Session
	session.Output(map[string]any{"stream": "stdout", "line": "x", "seq": 1})
	session.Done(map[string]any{"exitCode": 0})
	if session.Finish(StatusSucceeded, "", nil, nil) {
		t.Fatal("nil session accepted Finish")
	}
	if session.ID() != "" {
		t.Fatalf("nil session id = %q", session.ID())
	}
	var store *Store
	store.List(Filter{})
	store.Get("x")
	store.Events("x")
	store.Latest(KindAI, "x", "", false)
	store.Note(aiRecord(""), StatusSkipped, "")
	store.Start(aiRecord(""))
}

func TestConcurrentStartsAndFinishesAreSafe(t *testing.T) {
	store, _, _ := newStore(t)
	const workers = 8
	const each = 10
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < each; i++ {
				s, err := store.Start(Record{Target: Target{Kind: KindAction, ID: fmt.Sprintf("a-%d-%d", w, i)}, Origin: OriginManual, Params: map[string]any{}})
				if err != nil {
					t.Error(err)
					return
				}
				s.Output(map[string]any{"stream": "stdout", "line": "x", "seq": 1})
				finishWith(s, StatusSucceeded)
			}
		}(w)
	}
	wg.Wait()
	if got := len(store.List(Filter{})); got != workers*each {
		t.Fatalf("indexed %d runs, want %d", got, workers*each)
	}
}

func TestRunIDsAreUniqueWithinTheSameSecond(t *testing.T) {
	store, _, _ := newStore(t)
	store.now = func() time.Time { return time.Date(2026, 11, 24, 2, 15, 0, 0, time.Local) }
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		s, err := store.Start(Record{Target: Target{Kind: KindAction, ID: "patrol"}, Origin: OriginManual, Params: map[string]any{}})
		if err != nil {
			t.Fatal(err)
		}
		if seen[s.ID()] {
			t.Fatalf("duplicate run id %q", s.ID())
		}
		seen[s.ID()] = true
		if !strings.HasPrefix(s.ID(), "r20261124-021500-") {
			t.Fatalf("run id %q does not start with the local start time", s.ID())
		}
	}
}

func TestIndexKeepsSmallReadoutsButNotBodies(t *testing.T) {
	store, _, _ := newStore(t)
	s, _ := store.Start(aiRecord(""))
	code := 0
	s.Finish(StatusSucceeded, "", &code, map[string]string{
		"text": strings.Repeat("答", 5000), "thinking": "想", "stdout": "out", "stderr": "",
		"session_id": "sess-9", "cost_usd": "0.12", "input_tokens": "10", "output_tokens": "5", "total_tokens": "15",
		"exit_code": "0", "success": "true",
	})
	got, ok := store.Latest(KindAI, "review-bot", "", false)
	if !ok {
		t.Fatal("run not indexed")
	}
	for key := range got.Outputs {
		if !smallOutputs[key] {
			t.Fatalf("body output %q kept in the in-memory index: %v", key, got.Outputs)
		}
	}
	if got.Outputs["session_id"] != "sess-9" || got.Outputs["cost_usd"] != "0.12" || got.Outputs["input_tokens"] != "10" || got.Outputs["success"] != "true" {
		t.Fatalf("readouts missing from index: %v", got.Outputs)
	}
	full, err := store.Get(s.ID())
	if err != nil || len(full.Outputs["text"]) != 15000 || full.Outputs["stdout"] != "out" {
		t.Fatalf("full record lost bodies: err=%v len(text)=%d", err, len(full.Outputs["text"]))
	}
}

func TestStartSnapshotsParams(t *testing.T) {
	store, _, _ := newStore(t)
	params := map[string]any{"prompt": "original", "nested": map[string]any{"a": "1"}}
	s, _ := store.Start(Record{Target: Target{Kind: KindAI, ID: "review-bot"}, Origin: OriginManual, Params: params})
	params["prompt"] = "mutated"
	params["nested"].(map[string]any)["a"] = "2"
	s.Finish(StatusSucceeded, "", nil, nil)
	got, _ := store.Get(s.ID())
	if got.Params["prompt"] != "original" || got.Params["nested"].(map[string]any)["a"] != "1" {
		t.Fatalf("caller mutations leaked into the run record: %v", got.Params)
	}
}

func TestOutcomeMapsResultsToStatusVocabulary(t *testing.T) {
	for _, tc := range []struct {
		name       string
		exitCode   int
		err        error
		status     string
		reasonKind string // "" = 空；"exact" = 指定文案；"exit" = 退出码 N
		exact      string
	}{
		{"success", 0, nil, StatusSucceeded, "", ""},
		{"non-zero exit", 3, nil, StatusFailed, "exit", ""},
		{"error with text", -1, errors.New("工作目录不存在: /x"), StatusFailed, "exact", "工作目录不存在: /x"},
		{"cancelled by user", -1, context.Canceled, StatusCancelled, "", ""},
		{"wrapped cancel", -1, fmt.Errorf("run: %w", context.Canceled), StatusCancelled, "", ""},
		{"timeout", -1, context.DeadlineExceeded, StatusFailed, "exact", "超时"},
		{"wrapped timeout keeps actionable text", -1, fmt.Errorf("AI 运行超时（上限 30m0s）: %w", context.DeadlineExceeded), StatusFailed, "exact", "AI 运行超时（上限 30m0s）: context deadline exceeded"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, reason := Outcome(tc.exitCode, tc.err)
			if status != tc.status {
				t.Fatalf("status = %q, want %q", status, tc.status)
			}
			switch tc.reasonKind {
			case "":
				if reason != "" {
					t.Fatalf("reason = %q, want empty", reason)
				}
			case "exit":
				if reason != "退出码 3" {
					t.Fatalf("reason = %q, want 退出码 3", reason)
				}
			default:
				if reason != tc.exact {
					t.Fatalf("reason = %q, want %q", reason, tc.exact)
				}
			}
		})
	}
}

func TestNoteRejectsRunningStatus(t *testing.T) {
	store, _, _ := newStore(t)
	if _, err := store.Note(aiRecord(""), StatusRunning, ""); err == nil {
		t.Fatal("Note accepted a non-terminal status")
	}
	if got := store.List(Filter{}); len(got) != 0 {
		t.Fatalf("rejected note left a record: %+v", got)
	}
}

func TestSkippedTicksDoNotCrowdOutRealRuns(t *testing.T) {
	store, _, _ := newStore(t)
	base := time.Date(2026, 11, 25, 2, 0, 0, 0, time.Local)
	store.now = func() time.Time { return base }
	target := Target{Kind: KindAction, ID: "patrol"}
	// 一次真实运行之后，同一条调度连续 80 次到点都被跳过
	real, err := store.Start(Record{Target: target, Origin: OriginSchedule, ScheduleID: "check", Params: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	finishWith(real, StatusSucceeded)
	store.now = func() time.Time { return base.Add(time.Minute) }
	for i := 0; i < 80; i++ {
		if _, err := store.Note(Record{Target: target, Origin: OriginSchedule, ScheduleID: "check"}, StatusSkipped, "正在运行"); err != nil {
			t.Fatal(err)
		}
	}
	// 真实运行只被真实运行挤出：它还在，最近一次真实运行仍查得到
	if _, err := store.Get(real.ID()); err != nil {
		t.Fatalf("real run was crowded out by skips: %v", err)
	}
	got, ok := store.Latest(KindAction, "patrol", "check", true)
	if !ok || got.ID != real.ID() {
		t.Fatalf("latest real run = %+v ok=%v", got, ok)
	}
	// 跳过记录自己受同一上限约束
	if skipped := store.List(Filter{TargetKind: KindAction, Status: StatusSkipped}); len(skipped) != KeepPerTarget {
		t.Fatalf("kept %d skipped ticks, want %d", len(skipped), KeepPerTarget)
	}
	// 51 次真实运行仍然把最老的那次挤出去（上限对真实运行本身照常生效）
	for i := 0; i < 50; i++ {
		s, err := store.Start(Record{Target: target, Origin: OriginManual, Params: map[string]any{}})
		if err != nil {
			t.Fatal(err)
		}
		finishWith(s, StatusSucceeded)
	}
	if _, err := store.Get(real.ID()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cap no longer applies to real runs: %v", err)
	}
}

// 一条运行中的记录不会被保留策略清掉（运行中的不动），所以「记录没了才结束」在正常路径上
// 不可达；这里直接造出「索引与目录都不在了」，确认收尾时无处可写也不重建、不 panic。
func TestFinishWritesNothingOnceTheRecordIsGone(t *testing.T) {
	store, dir, _ := newStore(t)
	s, _ := store.Start(Record{Target: Target{Kind: KindAction, ID: "patrol"}, Origin: OriginManual, Params: map[string]any{}})
	delete(store.records, s.ID())
	if err := os.RemoveAll(filepath.Join(dir, DirName, s.ID())); err != nil {
		t.Fatal(err)
	}
	if s.Finish(StatusSucceeded, "", intPtr(0), nil) {
		t.Fatal("Finish rebuilt a record whose directory is gone")
	}
	if got := store.List(Filter{}); len(got) != 0 {
		t.Fatalf("Finish left a phantom record: %+v", got)
	}
}
