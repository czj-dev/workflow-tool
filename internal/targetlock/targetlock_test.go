package targetlock

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"workflow-tool/internal/target"
)

func acquire(t *testing.T, l *Locks, kind target.Kind, id string) func() {
	t.Helper()
	release, err := l.Acquire(kind, id)
	if err != nil {
		t.Fatalf("Acquire(%s, %s): %v", kind, id, err)
	}
	return release
}

// 同一目标第二次占锁被拒；释放后可以再占。
func TestAcquireRejectsSecondHolderUntilReleased(t *testing.T) {
	l := New(t.TempDir())
	release := acquire(t, l, target.Action, "patrol")
	if _, err := l.Acquire(target.Action, "patrol"); !errors.Is(err, ErrBusy) {
		t.Fatalf("second acquire while held = %v, want ErrBusy", err)
	}
	release()
	release() // 重复释放是空操作
	if again := acquire(t, l, target.Action, "patrol"); again == nil {
		t.Fatal("acquire after release failed")
	}
}

// 不同目标、不同种类互不相干：同一个 id 可以同时是动作与 AI 任务。
func TestLocksArePerTarget(t *testing.T) {
	l := New(t.TempDir())
	defer acquire(t, l, target.Action, "shared")()
	defer acquire(t, l, target.AI, "shared")()
	acquire(t, l, target.Workflow, "other")()
}

// 持有者进程已经不在（或 pid 被别的进程复用）：锁是残留的，接管。
func TestStaleLockIsTakenOver(t *testing.T) {
	dir := t.TempDir()
	startedAt := time.Now().Format(time.RFC3339Nano)
	writeLock(t, dir, "action-patrol.lock", lockFile{PID: 4242, StartedAt: startedAt})

	dead := New(dir)
	dead.alive = func(gotPID int, gotStartedAt string) bool {
		if gotPID != 4242 && gotPID != os.Getpid() {
			t.Fatalf("holder check got an unknown pid %d", gotPID)
		}
		if gotPID == 4242 && gotStartedAt != startedAt {
			t.Fatalf("holder check got started %q, want the value in the lock file %q", gotStartedAt, startedAt)
		}
		return gotPID != 4242 // 残留的持有者已死；接管之后本进程就是持有者
	}
	release := acquire(t, dead, target.Action, "patrol")
	if _, err := dead.Acquire(target.Action, "patrol"); !errors.Is(err, ErrBusy) {
		t.Fatalf("takeover did not replace the stale holder: %v", err)
	}
	release()

	writeLock(t, dir, "action-patrol.lock", lockFile{PID: 4242, StartedAt: startedAt})
	live := New(dir)
	live.alive = func(int, string) bool { return true }
	if _, err := live.Acquire(target.Action, "patrol"); !errors.Is(err, ErrBusy) {
		t.Fatalf("lock held by a live process was taken over: %v", err)
	}
}

// 读不出持有者信息的锁文件：刚建不久的当作被占着（持有者可能还没写完），放了很久的当残留接管。
func TestUnreadableLockDependsOnAge(t *testing.T) {
	dir := t.TempDir()
	path := writeLock(t, dir, "ai-review.lock", lockFile{})
	fresh := time.Now().Add(-5 * time.Second)
	if err := os.Chtimes(path, fresh, fresh); err != nil {
		t.Fatal(err)
	}
	l := New(dir)
	l.now = func() time.Time { return fresh.Add(10 * time.Second) }
	if _, err := l.Acquire(target.AI, "review"); !errors.Is(err, ErrBusy) {
		t.Fatalf("fresh empty lock = %v, want ErrBusy", err)
	}
	l.now = func() time.Time { return fresh.Add(unreadableGrace + time.Minute) }
	acquire(t, l, target.AI, "review")()
}

// Busy 只探测不占住。
func TestBusyProbesWithoutHolding(t *testing.T) {
	l := New(t.TempDir())
	if l.Busy(target.Workflow, "daily") {
		t.Fatal("Busy on an unheld target")
	}
	release := acquire(t, l, target.Workflow, "daily")
	if !l.Busy(target.Workflow, "daily") {
		t.Fatal("Busy on a held target returned false")
	}
	release()
	if l.Busy(target.Workflow, "daily") {
		t.Fatal("Busy after release returned true")
	}
}

// 真实进程身份核对：本进程持有的锁，在同一个进程里看也是「持有者存活」。
func TestOwnProcessCountsAsLiveHolder(t *testing.T) {
	l := New(t.TempDir())
	release := acquire(t, l, target.Action, "mine")
	if _, err := l.Acquire(target.Action, "mine"); !errors.Is(err, ErrBusy) {
		t.Fatalf("own live lock was taken over: %v", err)
	}
	release()
}

func writeLock(t *testing.T, dir, name string, holder lockFile) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "runs", "locks"), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "runs", "locks", name)
	data := []byte("not json")
	if holder.PID != 0 {
		data = []byte(fmt.Sprintf(`{"pid":%d,"started_at":%q}`, holder.PID, holder.StartedAt))
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}
