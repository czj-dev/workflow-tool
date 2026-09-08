//go:build !windows

package adbcore

import (
	"context"
	"errors"
	"testing"
	"time"
)

// RunCommand 必须受 ctx 控制：无设备时 adb 会挂在 "- waiting for device -" 上永不退出，
// 若 ctx 取消不生效，动作就永远停在「运行中」且停止按钮无效（曾用 exec.Command 而非
// CommandContext 导致）。用 sleep 模拟挂住的子进程。
func TestRunCommandRespectsCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()

	done := make(chan error, 1)
	go func() {
		_, err := RunCommand(ctx, ExecRequest{Command: "sleep", Args: []string{"30"}})
		done <- err
	}()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("期望 context.Canceled，实际 %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("ctx 取消后 RunCommand 未返回（子进程未被杀）")
	}
}

// req.Timeout 必须真正生效（此前派生的 ctx 未传给子进程，超时形同虚设）。
func TestRunCommandRespectsTimeout(t *testing.T) {
	start := time.Now()
	_, err := RunCommand(context.Background(), ExecRequest{
		Command: "sleep", Args: []string{"30"}, Timeout: 200 * time.Millisecond,
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("期望 context.DeadlineExceeded，实际 %v", err)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("超时未按 200ms 生效，耗时 %v", elapsed)
	}
}

// 带 stdin 的路径同样受 ctx 控制（input-text 等 operation 走这条）。
func TestRunCommandWithStdinRespectsTimeout(t *testing.T) {
	_, err := RunCommandWithStdin(context.Background(), ExecRequest{
		Command: "sleep", Args: []string{"30"}, Timeout: 200 * time.Millisecond,
	}, "ignored")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("期望 context.DeadlineExceeded，实际 %v", err)
	}
}

// 正常退出路径不受影响：ctx 未取消时照常返回输出与 exit code。
func TestRunCommandNormalExit(t *testing.T) {
	res, err := RunCommand(context.Background(), ExecRequest{Command: "echo", Args: []string{"hi"}})
	if err != nil {
		t.Fatalf("意外错误: %v", err)
	}
	if res.Stdout != "hi\n" || res.ExitCode != 0 {
		t.Fatalf("stdout=%q exit=%d", res.Stdout, res.ExitCode)
	}
}
