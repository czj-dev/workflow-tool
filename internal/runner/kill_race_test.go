//go:build !windows

package runner

import (
	"context"
	"errors"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

// 取消时目标正在 fork：组长在 fork 途中被 SIGKILL 杀掉，刚 fork 出来的子进程会躲过这一次
// 组杀（它诞生在内核遍历进程组之后），继续握着管道不松手，Run 就永远等不到管道关闭。
// 所以杀完之后管道若没 promptly 关闭，必须再补杀一次进程组。
func TestRunCancelKillsChildrenForkedDuringTheKill(t *testing.T) {
	// 脚本在头几十毫秒里持续 fork 出长活的子进程：取消落在这段窗口里就会撞上竞态
	const script = `i=0
while [ $i -lt 400 ]; do sleep 30 & i=$((i+1)); done
wait
`
	for attempt := range 20 {
		ctx, cancel := context.WithCancel(context.Background())
		cmd := exec.Command("sh", "-c", script)
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		timer := time.AfterFunc(time.Duration(attempt)*time.Millisecond, cancel)

		started := time.Now()
		outcome := Run(ctx, ExecRequest{Cmd: cmd, Timeout: 10 * time.Second}, func(string, string) {})
		elapsed := time.Since(started)
		timer.Stop()
		if !errors.Is(outcome.Err, context.Canceled) {
			t.Fatalf("attempt %d: outcome = %+v, want a cancelled run", attempt, outcome.Err)
		}
		if elapsed > 5*time.Second {
			t.Fatalf("attempt %d (cancel after %dms): Run took %v to return; a forked child survived the group kill", attempt, attempt, elapsed)
		}
	}
}
