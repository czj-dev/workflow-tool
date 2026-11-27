package cli

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"workflow-tool/internal/registry"
	"workflow-tool/internal/runstore"
	targetkind "workflow-tool/internal/target"
	"workflow-tool/internal/targetlock"
)

// 执行器（M4）与 CLI 放行：调度到点与立即运行交给同一可执行文件的 run 子命令，它接手
// 应用建好的运行记录——占目标锁、写心跳、续写日志、落终态；AI 任务经 --allow-ai 放行。

// fakeAICli 模拟 pi --mode json 的事件流：先给 session id，再吐回复增量（ai 流）、
// 收口消息（usage 权威值随 message_end）与 agent_settled。事件形状对齐
// runner/testdata/pi_stream.jsonl。
const fakeAICli = `#!/bin/sh
cat > /dev/null
printf '%s\n' '{"type":"session","id":"sess-1"}'
printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"你好"}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"你好"}],"stopReason":"stop","usage":{"input":10,"output":5,"totalTokens":15,"cost":{"total":0.0125}}}}'
printf '%s\n' '{"type":"agent_settled","aborted":false}'
`

// executorBaseDir 建一个应用目录：ok / sleep 两个动作、ask 一个 AI 任务（假 CLI）。
func executorBaseDir(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("假 AI CLI 与 sleep 动作是 sh 脚本")
	}
	dir := t.TempDir()
	write := func(rel, body string, mode os.FileMode) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, rel)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, rel), []byte(body), mode); err != nil {
			t.Fatal(err)
		}
	}
	write("fake-ai.sh", fakeAICli, 0o755)
	write("actions/ok.yaml", "id: ok\ntitle: OK\ncommand:\n  run: echo hello\n", 0o644)
	write("actions/sleep.yaml", "id: sleep\ntitle: Sleep\ncommand:\n  run: sleep 30\n", 0o644)
	write("workflows/with-ai.yaml", "id: with-ai\ntitle: With AI\nsteps:\n  - run: echo step-one\n  - id: analyze\n    ai: ask\n", 0o644)
	write("ai/ask.yaml", "id: ask\ntitle: Ask\nprompt: 介绍一下部署流程\n", 0o644)
	// 用户目录重定向到空临时目录：AI 运行会读 auth.json（AgentConfig），不碰真实
	// ~/.workflow-tool，也不受它当前内容的影响（本包测试全部经此 fixture）。
	t.Setenv("WORKFLOW_TOOL_USER_HOME", t.TempDir())
	// pi 三键 + AI_PI_BIN 指向假 pi：假脚本不消费端点与模型，但 Build 的三键校验
	// 与可执行解析必须照常通过。
	if err := registry.SaveGlobal(filepath.Join(dir, "config.yaml"), map[string]string{
		"AI_BASE_URL": "http://oneapi.example/v1", "AI_AUTH_KEY": "k-test", "AI_MODEL": "M-TEST",
		"AI_PI_BIN": filepath.Join(dir, "fake-ai.sh"),
	}); err != nil {
		t.Fatal(err)
	}
	return dir
}

// executorRecord 以应用的身份建一条「交给执行器」的运行记录：建好即交出，不占任何簿记。
func executorRecord(t *testing.T, dir string, kind targetkind.Kind, id string) string {
	t.Helper()
	store, err := runstore.Open(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	sess, err := store.Start(runstore.Record{
		Target: targetkind.Target{Kind: kind, ID: id}, Origin: runstore.OriginSchedule, ScheduleID: "nightly",
		Params: map[string]any{}, Process: &runstore.Process{Mode: runstore.ProcessExecutor},
	})
	if err != nil {
		t.Fatal(err)
	}
	sess.Detach()
	return sess.ID()
}

// reopen 重新打开运行记录，读到的是盘上的终态。
func reopen(t *testing.T, dir string) *runstore.Store {
	t.Helper()
	store, err := runstore.Open(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

// quickExecutor 建一个心跳与停止标记轮询都很快的执行环境（每个用例自己一份，没有共享状态）。
func quickExecutor(t *testing.T, dir string) *env {
	t.Helper()
	e := loadEnv(dir)
	e.heartbeatEvery, e.stopPollEvery = 20*time.Millisecond, 20*time.Millisecond
	return e
}

// waitTakenOver 等执行器把进程信息写进这条记录。在那之前不能重新打开运行记录：启动对账
// 核对不到进程身份，会把记录判成中断。
func waitTakenOver(t *testing.T, dir, id string) {
	t.Helper()
	path := filepath.Join(dir, runstore.DirName, id, runstore.RecordFile)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		if err == nil {
			var rec struct {
				Process *struct {
					PID         int    `json:"pid"`
					HeartbeatAt string `json:"heartbeat_at"`
				} `json:"process"`
			}
			if json.Unmarshal(data, &rec) == nil && rec.Process != nil && rec.Process.PID != 0 && rec.Process.HeartbeatAt != "" {
				return
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("the executor never took over run %s", id)
}

// 执行器接手一条动作运行：日志与终态落进同一条记录，跑完释放目标锁。
func TestExecuteRecordRunsActionToTerminalState(t *testing.T) {
	dir := executorBaseDir(t)
	id := executorRecord(t, dir, targetkind.Action, "ok")

	if code := ExecuteRecord(context.Background(), dir, id, false); code != 0 {
		t.Fatalf("executor exit code = %d", code)
	}
	rec, err := reopen(t, dir).Get(id)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Status != runstore.StatusSucceeded || rec.ExitCode == nil || *rec.ExitCode != 0 ||
		rec.FinishedAt == nil || rec.Outputs["stdout"] != "hello\n" {
		t.Fatalf("terminal record = %+v", rec)
	}
	if rec.Process == nil || rec.Process.Mode != runstore.ProcessExecutor || rec.Process.PID != os.Getpid() || rec.Process.HeartbeatAt == "" {
		t.Fatalf("process info not archived by the executor: %+v", rec.Process)
	}
	events, _ := reopen(t, dir).Events(id)
	if len(events) != 2 || events[0].Event != "output" || events[0].Line != "hello" || events[0].Seq != 1 ||
		events[1].Event != "done" || events[1].ExitCode != 0 || events[1].Seq != 2 {
		t.Fatalf("run log = %+v", events)
	}
	if targetlock.New(dir).Busy(targetkind.Action, "ok") {
		t.Fatal("target lock was not released")
	}
}

// 执行器跑 AI 任务：放行标志随调度一并给出，守则全文与会话 id 留在记录里，done 行带终点读数。
func TestExecuteRecordRunsAITaskAndArchivesRules(t *testing.T) {
	dir := executorBaseDir(t)
	id := executorRecord(t, dir, targetkind.AI, "ask")

	if code := ExecuteRecord(context.Background(), dir, id, true); code != 0 {
		t.Fatalf("executor exit code = %d", code)
	}
	rec, err := reopen(t, dir).Get(id)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Status != runstore.StatusSucceeded || rec.Outputs["text"] != "你好" || rec.Outputs["session_id"] != "sess-1" || !strings.Contains(rec.Rules, "无人值守") {
		t.Fatalf("AI run record = status %s outputs %v rules %q", rec.Status, rec.Outputs, rec.Rules)
	}
	events, _ := reopen(t, dir).Events(id)
	if last := events[len(events)-1]; last.Event != "done" || last.Readout["sessionId"] != "sess-1" {
		t.Fatalf("done line = %+v", last)
	}
}

// 含 AI 步骤的工作流：放行时步骤真的执行，输出带步骤归属落在父工作流的日志里。
func TestExecuteRecordRunsWorkflowWithAIStepWhenAllowed(t *testing.T) {
	dir := executorBaseDir(t)
	id := executorRecord(t, dir, targetkind.Workflow, "with-ai")

	if code := ExecuteRecord(context.Background(), dir, id, true); code != 0 {
		t.Fatalf("executor exit code = %d", code)
	}
	if rec, _ := reopen(t, dir).Get(id); rec.Status != runstore.StatusSucceeded {
		t.Fatalf("workflow record = %+v", rec)
	}
	events, _ := reopen(t, dir).Events(id)
	var replied bool
	for _, ev := range events {
		if ev.Stream == "ai" && ev.Line == "你好" {
			replied = true
			if ev.Step == "" {
				t.Fatalf("AI step output must carry its step: %+v", ev)
			}
		}
	}
	if !replied {
		t.Fatalf("AI step did not run: %+v", events)
	}
}

// 目标已被别的运行占着：执行器不跑。调度到点的记录留档为 skipped（规格：冲突只跳过，
// 不覆盖上一次真实运行的结果），别的来源是 failed；别人的锁原样保留。
func TestExecuteRecordRefusesLockedTarget(t *testing.T) {
	for _, origin := range []string{runstore.OriginSchedule, runstore.OriginRunNow} {
		t.Run(origin, func(t *testing.T) {
			dir := executorBaseDir(t)
			id := executorRecord(t, dir, targetkind.Action, "ok")
			recBefore := readDiskRecord(t, dir, id)
			recBefore.Origin = origin
			writeRecord(t, dir, id, recBefore)

			release, err := targetlock.New(dir).Acquire(targetkind.Action, "ok")
			if err != nil {
				t.Fatal(err)
			}
			defer release()

			ExecuteRecord(context.Background(), dir, id, false)
			rec, _ := reopen(t, dir).Get(id)
			want := runstore.StatusSkipped
			if origin == runstore.OriginRunNow {
				want = runstore.StatusFailed
			}
			if rec.Status != want || !strings.Contains(rec.Reason, "正在运行") {
				t.Fatalf("locked target record = %+v, want %s", rec, want)
			}
			if !targetlock.New(dir).Busy(targetkind.Action, "ok") {
				t.Fatal("the other holder's lock was released")
			}
		})
	}
}

// readDiskRecord 直读盘上的记录，不经过 runstore.Open——Open 会做启动对账，把执行器
// 还没接手的 running 记录判成中断。
func readDiskRecord(t *testing.T, dir, id string) runstore.Record {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, runstore.DirName, id, runstore.RecordFile))
	if err != nil {
		t.Fatal(err)
	}
	var rec runstore.Record
	if err := json.Unmarshal(data, &rec); err != nil {
		t.Fatal(err)
	}
	return rec
}

// writeRecord 直接改写盘上的一条记录（测试里调整 origin 用）。
func writeRecord(t *testing.T, dir, id string, rec runstore.Record) {
	t.Helper()
	data, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, runstore.DirName, id, runstore.RecordFile), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// 停止标记：应用写下，执行器轮询到就取消——记录落 cancelled，标记随终态清掉。
func TestExecuteRecordStopsOnMarker(t *testing.T) {
	dir := executorBaseDir(t)
	id := executorRecord(t, dir, targetkind.Action, "sleep")
	if err := os.WriteFile(filepath.Join(dir, runstore.DirName, id, runstore.StopFile), nil, 0o644); err != nil {
		t.Fatal(err)
	}

	e := quickExecutor(t, dir)
	done := make(chan int, 1)
	go func() { done <- e.executeRecord(context.Background(), id) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("executor ignored the stop marker")
	}
	rec, _ := reopen(t, dir).Get(id)
	if rec.Status != runstore.StatusCancelled {
		t.Fatalf("stopped run = %+v", rec)
	}
	if _, err := os.Stat(filepath.Join(dir, runstore.DirName, id, runstore.StopFile)); !os.IsNotExist(err) {
		t.Fatalf("stop marker survived: %v", err)
	}
	if targetlock.New(dir).Busy(targetkind.Action, "sleep") {
		t.Fatal("target lock was not released after a stop")
	}
}

// 执行器运行期间心跳持续推进：应用据此知道它还活着。
func TestExecuteRecordBeatsHeartbeatWhileRunning(t *testing.T) {
	dir := executorBaseDir(t)
	id := executorRecord(t, dir, targetkind.Action, "sleep")

	e := quickExecutor(t, dir)
	go e.executeRecord(context.Background(), id)
	waitTakenOver(t, dir, id)

	// 应用这边：打开运行记录（认领这条仍在运行的执行器运行），然后持续核对
	store := reopen(t, dir)
	first, advances := "", 0
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		rec, ended := store.Poll(id)
		if ended {
			// 收尾只可能来自下面的停止请求；此前结束就是执行器自己停了
			if advances == 0 || rec.Status != runstore.StatusCancelled {
				t.Fatalf("run ended unexpectedly (heartbeat advances %d): %+v", advances, rec)
			}
			return
		}
		rec, err := store.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if heartbeat := rec.Process.HeartbeatAt; heartbeat != "" && first != "" && heartbeat != first {
			advances++
		} else if heartbeat != "" {
			first = heartbeat
		}
		if advances >= 1 {
			// 心跳推进过：请求停止。执行器收尾前它还要往这个用例的临时目录里写，等到它结束
			if err := store.RequestStop(id); err != nil {
				t.Fatal(err)
			}
			for time.Now().Before(deadline) {
				if rec, ended := store.Poll(id); ended {
					if rec.Status != runstore.StatusCancelled {
						t.Fatalf("stopped run = %+v", rec)
					}
					return
				}
				time.Sleep(5 * time.Millisecond)
			}
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("heartbeat never advanced (first %q) or the executor ignored the stop marker", first)
}

// 接手不了就退出：没有这条记录，或它已经终结（终态只写一次）。
func TestExecuteRecordRejectsUnknownOrFinishedRun(t *testing.T) {
	dir := executorBaseDir(t)
	if code := ExecuteRecord(context.Background(), dir, "no-such-run", false); code != exitCLIError {
		t.Fatalf("unknown run exit code = %d", code)
	}
	id := executorRecord(t, dir, targetkind.Action, "ok")
	if code := ExecuteRecord(context.Background(), dir, id, false); code != 0 {
		t.Fatal(code)
	}
	if code := ExecuteRecord(context.Background(), dir, id, false); code != exitCLIError {
		t.Fatalf("re-attaching to a finished run exit code = %d", code)
	}
	rec, _ := reopen(t, dir).Get(id)
	if rec.Status != runstore.StatusSucceeded {
		t.Fatalf("finished record was rewritten: %+v", rec)
	}
}

// CLI 运行同样占目标锁：应用里的运行进行中，Agent 从 shell 发起的运行被拒而不是并发跑。
func TestCLIRunRefusesLockedTargetAndReleasesAfterRun(t *testing.T) {
	dir := executorBaseDir(t)
	e := loadEnv(dir)
	tgt, cerr := e.resolve("ok", "")
	if cerr != nil {
		t.Fatal(cerr)
	}
	release, err := targetlock.New(dir).Acquire(targetkind.Action, "ok")
	if err != nil {
		t.Fatal(err)
	}
	res, _ := e.runTarget(context.Background(), tgt, map[string]any{}, "", func(string, string) {})
	var cliErr *cliError
	if !errors.As(res.Err, &cliErr) || cliErr.Kind != "target_locked" {
		t.Fatalf("locked target = %+v, want a target_locked CLI error", res.Err)
	}
	release()

	if res, _ := e.runTarget(context.Background(), tgt, map[string]any{}, "", func(string, string) {}); res.ExitCode != 0 {
		t.Fatalf("run after release = %+v", res)
	}
	if targetlock.New(dir).Busy(targetkind.Action, "ok") {
		t.Fatal("lock not released after a CLI run")
	}
}

// --allow-ai 是显式放行：不带它 AI 任务与含 AI 步骤的工作流照旧 ai_blocked。
func TestAllowAIFlagGatesAIRuns(t *testing.T) {
	dir := executorBaseDir(t)
	e := loadEnv(dir)
	ask, _ := e.resolve("ask", "")
	withAI, _ := e.resolve("with-ai", "")
	emit := func(string, string) {}

	for _, tgt := range []target{ask, withAI} {
		res, _ := e.runTarget(context.Background(), tgt, map[string]any{}, "", emit)
		var cliErr *cliError
		if !errors.As(res.Err, &cliErr) || cliErr.Kind != "ai_blocked" {
			t.Fatalf("%s without --allow-ai = %+v", tgt.kind, res.Err)
		}
	}

	e.allowAI = true
	if res, _ := e.runTarget(context.Background(), ask, map[string]any{}, "", emit); res.ExitCode != 0 {
		t.Fatalf("AI task with --allow-ai = %+v", res)
	}
	if res, _ := e.runTarget(context.Background(), withAI, map[string]any{}, "", emit); res.ExitCode != 0 {
		t.Fatalf("workflow with an AI step with --allow-ai = %+v", res)
	}
}

// 命令行层面：run --allow-ai --json 真的把 AI 任务跑起来，回复经 ai 流输出。
func TestCmdRunAllowAIEmitsReply(t *testing.T) {
	dir := executorBaseDir(t)
	out := captureStdout(t, func() int {
		return cmdRun([]string{"ask", "--kind", "ai", "--json", "--allow-ai", "--base-dir", dir})
	})
	if !strings.Contains(out, `"stream":"ai"`) || !strings.Contains(out, `"line":"你好"`) || !strings.Contains(out, `"type":"result"`) {
		t.Fatalf("--allow-ai run output = %s", out)
	}
}

// 命令行层面：不带 --allow-ai 仍是 ai_blocked（退出码 2）。
func TestCmdRunStillBlocksAIByDefault(t *testing.T) {
	dir := executorBaseDir(t)
	code, stderr := captureStderr(func() int {
		return cmdRun([]string{"ask", "--kind", "ai", "--base-dir", dir})
	})
	if code != exitCLIError {
		t.Fatalf("exit code = %d, stderr %s", code, stderr)
	}
	if !strings.Contains(stderr, "ai_blocked") || !strings.Contains(stderr, "--allow-ai") {
		t.Fatalf("stderr should name the flag that lifts the block: %s", stderr)
	}
}

// captureStderr 把 fn 运行期间写到 os.Stderr 的内容收下来（fail 的人读行在这里）。
func captureStderr(fn func() int) (code int, stderr string) {
	r, w, err := os.Pipe()
	if err != nil {
		panic(err)
	}
	old := os.Stderr
	os.Stderr = w
	defer func() { os.Stderr = old }()
	out := make(chan string, 1)
	go func() { data, _ := io.ReadAll(r); out <- string(data) }()
	code = fn()
	_ = w.Close()
	return code, <-out
}

func captureStdout(t *testing.T, fn func() int) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdout
	os.Stdout = w
	code := fn()
	os.Stdout = old
	_ = w.Close()
	out, _ := io.ReadAll(r)
	_ = r.Close()
	if code != 0 {
		t.Fatalf("cmdRun exit code = %d, output %s", code, out)
	}
	return string(out)
}

// CLI 的 auth.json 接线：config.yaml 不带三键、用户级 auth.json（设置页保存的同一
// 份文件）提供三键时，--allow-ai 运行照常通过校验——GUI 与 shell 路径同一合并语义。
func TestCLIRunUsesAgentConfigAuth(t *testing.T) {
	dir := executorBaseDir(t)
	// config.yaml 清三键，只留假 pi
	if err := registry.SaveGlobal(filepath.Join(dir, "config.yaml"), map[string]string{
		"AI_PI_BIN": filepath.Join(dir, "fake-ai.sh"),
	}); err != nil {
		t.Fatal(err)
	}
	userDir, _ := os.LookupEnv("WORKFLOW_TOOL_USER_HOME")
	if err := registry.SaveAuth(filepath.Join(userDir, "auth.json"), map[string]string{
		"AI_BASE_URL": "http://oneapi.example/v1", "AI_AUTH_KEY": "k-test", "AI_MODEL": "M-TEST",
	}); err != nil {
		t.Fatal(err)
	}

	e := loadEnv(dir)
	e.allowAI = true
	ask, cerr := e.resolve("ask", "ai")
	if cerr != nil {
		t.Fatal(cerr)
	}
	res, _ := e.runTarget(context.Background(), ask, map[string]any{}, "", func(string, string) {})
	if res.ExitCode != 0 || res.Err != nil {
		t.Fatalf("三键来自 auth.json 的 AI 运行应成功: exit=%d err=%v", res.ExitCode, res.Err)
	}
	if res.Outputs["text"] != "你好" {
		t.Fatalf("回复不符: %v", res.Outputs)
	}
}
