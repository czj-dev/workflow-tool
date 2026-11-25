package procinfo

import (
	"os"
	"os/exec"
	"testing"
	"time"
)

// 本进程必然「活着且启动时刻相符」。
func TestAliveAcceptsOwnProcess(t *testing.T) {
	pid, startedAt := Self()
	if !Alive(pid, startedAt) {
		t.Fatalf("own process (pid %d, started %s) reported as not alive", pid, startedAt)
	}
}

// pid 相同但启动时刻对不上 = pid 被别的进程复用，不算存活。
func TestAliveRejectsMismatchedStartTime(t *testing.T) {
	pid, _ := Self()
	foreign := time.Now().Add(-time.Hour).Format(time.RFC3339Nano)
	if Alive(pid, foreign) {
		t.Fatalf("pid %d with a start time an hour earlier reported as alive", pid)
	}
}

// 已经退出的进程不算存活；非法输入同样不算。
func TestAliveRejectsDeadProcessAndBadInput(t *testing.T) {
	dead := exec.Command("true")
	if err := dead.Run(); err != nil {
		t.Fatal(err)
	}
	for _, startedAt := range []string{time.Now().Format(time.RFC3339Nano), "", "not-a-time"} {
		if Alive(dead.Process.Pid, startedAt) {
			t.Fatalf("dead pid %d (startedAt %q) reported as alive", dead.Process.Pid, startedAt)
		}
	}
	if Alive(0, time.Now().Format(time.RFC3339Nano)) || Alive(-1, time.Now().Format(time.RFC3339Nano)) {
		t.Fatal("non-positive pid reported as alive")
	}
}

// Self 给出的 pid 就是本进程，启动时刻可解析。
func TestSelfDescribesThisProcess(t *testing.T) {
	pid, startedAt := Self()
	if pid != os.Getpid() {
		t.Fatalf("Self pid = %d, want %d", pid, os.Getpid())
	}
	if _, err := time.Parse(time.RFC3339Nano, startedAt); err != nil {
		t.Fatalf("Self startedAt %q is not RFC3339Nano: %v", startedAt, err)
	}
}
