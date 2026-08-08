package runner

import (
	"context"
	"os/exec"
	"runtime"
	"testing"
	"time"
)

func skipExecWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix 专属 shell 行为，windows 场景不在本测试覆盖范围")
	}
}

func TestExecRun_Success(t *testing.T) {
	skipExecWindows(t)
	cmd := exec.Command("sh", "-c", "echo out1; echo err1 1>&2")
	var lines []string
	outcome := Run(context.Background(), ExecRequest{Cmd: cmd, Timeout: 5 * time.Second}, func(stream, line string) {
		lines = append(lines, stream+":"+line)
	})
	if outcome.Err != nil {
		t.Fatalf("err: %v", outcome.Err)
	}
	if outcome.ExitCode != 0 {
		t.Fatalf("exit=%d want 0", outcome.ExitCode)
	}
	if !contains(lines, "stdout:out1") {
		t.Fatalf("缺少 stdout:out1，got=%v", lines)
	}
	if !contains(lines, "stderr:err1") {
		t.Fatalf("缺少 stderr:err1，got=%v", lines)
	}
}

func TestExecRun_NonZeroExit(t *testing.T) {
	skipExecWindows(t)
	cmd := exec.Command("sh", "-c", "exit 7")
	outcome := Run(context.Background(), ExecRequest{Cmd: cmd, Timeout: 5 * time.Second}, func(stream, line string) {})
	if outcome.ExitCode != 7 {
		t.Fatalf("exit=%d want 7", outcome.ExitCode)
	}
}

func TestExecRun_Timeout(t *testing.T) {
	skipExecWindows(t)
	cmd := exec.Command("sh", "-c", "sleep 10")
	setPgid(cmd)
	outcome := Run(context.Background(), ExecRequest{Cmd: cmd, Timeout: 100 * time.Millisecond}, func(stream, line string) {})
	if outcome.Err == nil {
		t.Fatal("期望超时错误")
	}
	if outcome.ExitCode != -1 {
		t.Fatalf("exit=%d want -1", outcome.ExitCode)
	}
}

func TestExecRun_CarriageReturnSplitsLines(t *testing.T) {
	skipExecWindows(t)
	// printf 不追加尾随换行，模拟 adb push 用 \r 覆写同一行显示进度
	cmd := exec.Command("sh", "-c", `printf 'a\rb\rc\n'`)
	var stdoutLines []string
	outcome := Run(context.Background(), ExecRequest{Cmd: cmd, Timeout: 5 * time.Second}, func(stream, line string) {
		if stream == "stdout" {
			stdoutLines = append(stdoutLines, line)
		}
	})
	if outcome.Err != nil {
		t.Fatalf("err: %v", outcome.Err)
	}
	want := []string{"a", "b", "c"}
	if len(stdoutLines) != len(want) {
		t.Fatalf("got %v, want %v", stdoutLines, want)
	}
	for i, w := range want {
		if stdoutLines[i] != w {
			t.Fatalf("line[%d]=%q want %q", i, stdoutLines[i], w)
		}
	}
}
