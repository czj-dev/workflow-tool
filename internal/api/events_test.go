package api

import (
	"sync"
	"testing"
)

// seq 必须原子递增：logcat-stream 的 emit 来自多个 goroutine（stream.go 的
// flush ticker 协程、控制协程的拒绝告警、pidRefresher 的包未运行告警），
// 「runner.OnLine 串行回调」这个前提在该 operation 下不成立。前端 seqGate
// 依赖 seq 唯一有序，重号会让 logcat-replace 的 head 帧错序。
func TestActionEventsSeqIsAtomic(t *testing.T) {
	const goroutines, perG = 8, 500
	ev := &actionEvents{}
	got := make([][]int64, goroutines)
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			out := make([]int64, 0, perG)
			for i := 0; i < perG; i++ {
				out = append(out, ev.nextSeq())
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
