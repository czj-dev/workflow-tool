package runstore

import (
	"sync"
	"testing"
	"time"
)

// LogEmitter 的 payload 是运行日志与前端事件的共同契约，形状在这里钉死。
func TestLogEmitterPayloadShape(t *testing.T) {
	store, dir, _ := newStore(t)
	sess, err := store.Start(Record{Target: Target{Kind: KindAction, ID: "patrol"}, Origin: OriginManual, Params: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	action := &LogEmitter{Sink: sess}

	first := action.Output("stdout", "hello")
	if first["stream"] != "stdout" || first["line"] != "hello" || first["seq"] != int64(1) {
		t.Fatalf("action output payload = %v", first)
	}
	if _, hasStep := first["step"]; hasStep {
		t.Fatalf("action output must not carry a step: %v", first)
	}
	done := action.Done(0, "", time.Second, map[string]any{"sessionId": "s1"}, true)
	// done 独占一个号：第一条 output 是 1，done 占 2
	if done["seq"] != int64(2) || done["exitCode"] != 0 || done["duration"] != "1s" || done["readout"] == nil {
		t.Fatalf("ordered done payload = %v", done)
	}
	// 不取号的 done（启动前早退）不带 seq，也没有 readout
	early := action.Done(-1, "boom", 0, nil, false)
	if _, has := early["seq"]; has || early["err"] != "boom" || early["readout"] != nil {
		t.Fatalf("unordered done payload = %v", early)
	}

	wf := &LogEmitter{Workflow: true}
	wf.Output("step-start", "2")
	stepOut := wf.Output("ai", "你好")
	if stepOut["step"] != "2" || stepOut["seq"] != int64(2) {
		t.Fatalf("workflow output payload = %v", stepOut)
	}
	if wfDone := wf.Done(0, "", 0, nil, false); wfDone["seq"] != nil {
		t.Fatalf("workflow done must not take a seq: %v", wfDone)
	}

	// 落盘的行与 payload 同构，另带相对偏移 t 与 event
	lines := readEventLines(t, dir, sess.ID())
	if len(lines) != 3 || lines[0]["event"] != "output" || lines[0]["seq"] != float64(1) ||
		lines[1]["event"] != "done" || lines[1]["seq"] != float64(2) || lines[2]["event"] != "done" {
		t.Fatalf("log lines = %v", lines)
	}
}

// 没有记录会话（运行记录不可用）时落盘为空操作，取号照常。
func TestLogEmitterWithoutSink(t *testing.T) {
	e := &LogEmitter{}
	e.Output("stdout", "x")
	e.Done(0, "", 0, nil, true)
	if got := e.Output("stdout", "y"); got["seq"] != int64(3) {
		t.Fatalf("seq must keep advancing without a sink: %v", got)
	}
}

// seq 必须原子递增：logcat-stream 的 emit 来自多个 goroutine（stream.go 的
// flush ticker 协程、控制协程的拒绝告警、pidRefresher 的包未运行告警），
// 「runner.OnLine 串行回调」这个前提在该 operation 下不成立。前端 seqGate
// 依赖 seq 唯一有序，重号会让 logcat-replace 的 head 帧错序。
func TestLogEmitterSeqIsAtomic(t *testing.T) {
	const goroutines, perG = 8, 500
	e := NewLogEmitter(false)
	got := make([][]int64, goroutines)
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			out := make([]int64, 0, perG)
			for i := 0; i < perG; i++ {
				out = append(out, e.Output("stdout", "x")["seq"].(int64))
			}
			got[g] = out
		}(g)
	}
	wg.Wait()

	seen := make(map[int64]bool, goroutines*perG)
	for _, out := range got {
		for _, s := range out {
			if seen[s] {
				t.Fatalf("seq %d 重号：并发取号未原子化", s)
			}
			seen[s] = true
		}
	}
	if len(seen) != goroutines*perG {
		t.Fatalf("期望 %d 个唯一 seq，实际 %d", goroutines*perG, len(seen))
	}
}
