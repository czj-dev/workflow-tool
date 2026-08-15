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

// TestSplitLines 跨平台直接测 splitLines：CRLF（Windows PowerShell 等子进程行尾）
// 视作单个行结束、单 \r 仍切行（adb 进度覆写）、\r 落在缓冲末尾时等待后续字节。
func TestSplitLines(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  []string
	}{
		{"LF only", "a\nb\n", []string{"a", "b"}},
		{"CRLF is one break", "a\r\nb\r\n", []string{"a", "b"}},
		{"lone CR splits", "a\rb\r", []string{"a", "b"}},
		{"mixed", "a\r\nb\rc\n", []string{"a", "b", "c"}},
		{"no trailing break", "tail", []string{"tail"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got []string
			rest := []byte(tc.input)
			for {
				// 先模拟"还有数据"（atEOF=false）扫描，读不尽时再以 atEOF=true 收尾，
				// 复刻 bufio.Scanner 的调用方式
				adv, token, err := splitLines(rest, false)
				if err != nil {
					t.Fatal(err)
				}
				if adv > 0 {
					got = append(got, string(token))
					rest = rest[adv:]
					continue
				}
				// atEOF=false 无进展 → 以 atEOF=true 收尾
				adv, token, err = splitLines(rest, true)
				if err != nil {
					t.Fatal(err)
				}
				if adv == 0 && token == nil {
					break
				}
				if adv == 0 {
					t.Fatalf("atEOF 仍无进展，剩余 %q", rest)
				}
				got = append(got, string(token))
				rest = rest[adv:]
				if len(rest) == 0 {
					break
				}
			}
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for i, w := range tc.want {
				if got[i] != w {
					t.Fatalf("line[%d]=%q want %q (all: %v)", i, got[i], w, got)
				}
			}
		})
	}
}
