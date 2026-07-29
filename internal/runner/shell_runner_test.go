package runner

import (
	"context"
	"runtime"
	"strings"
	"testing"
	"time"
)

func skipWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix 专属行为，windows 由 script 测试覆盖")
	}
}

func TestShellRunner_Success(t *testing.T) {
	skipWindows(t)
	r := &ShellRunner{Cfg: ShellConfig{Shell: "echo hello", Timeout: 5 * time.Second}}
	var got []string
	res := r.Run(context.Background(), nil, func(s, l string) { got = append(got, s+":"+l) })
	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit=%d want 0", res.ExitCode)
	}
	if !contains(got, "stdout:hello") {
		t.Fatalf("缺少 stdout:hello，got=%v", got)
	}
}

func TestShellRunner_NonZeroExit(t *testing.T) {
	skipWindows(t)
	r := &ShellRunner{Cfg: ShellConfig{Shell: "sh -c 'exit 7'", Timeout: 5 * time.Second}}
	res := r.Run(context.Background(), nil, func(s, l string) {})
	if res.ExitCode != 7 {
		t.Fatalf("exit=%d want 7", res.ExitCode)
	}
}

func TestShellRunner_Timeout(t *testing.T) {
	skipWindows(t)
	r := &ShellRunner{Cfg: ShellConfig{Shell: "sleep 10", Timeout: 100 * time.Millisecond}}
	res := r.Run(context.Background(), nil, func(s, l string) {})
	if res.Err == nil {
		t.Fatalf("期望超时错误")
	}
}

func TestShellRunner_Cancel(t *testing.T) {
	skipWindows(t)
	ctx, cancel := context.WithCancel(context.Background())
	r := &ShellRunner{Cfg: ShellConfig{Shell: "sleep 10", Timeout: 30 * time.Second}}
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	res := r.Run(ctx, nil, func(s, l string) {})
	if res.Err == nil {
		t.Fatalf("期望取消错误")
	}
}

func TestShellRunner_Stderr(t *testing.T) {
	skipWindows(t)
	r := &ShellRunner{Cfg: ShellConfig{Shell: "sh -c 'echo err >&2'", Timeout: 5 * time.Second}}
	var saw bool
	r.Run(context.Background(), nil, func(s, l string) {
		if s == "stderr" && l == "err" {
			saw = true
		}
	})
	if !saw {
		t.Fatalf("期望 stderr:err")
	}
}

func TestShellRunner_MissingCommand(t *testing.T) {
	r := &ShellRunner{Cfg: ShellConfig{Timeout: time.Second}}
	res := r.Run(context.Background(), nil, func(s, l string) {})
	if res.Err == nil {
		t.Fatalf("shell/script 都空时应报错")
	}
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// collectEmit 把输出收集到 slice（形如 "stream:line"）。
func collectEmit(out *[]string) EmitFunc {
	return func(stream, line string) {
		*out = append(*out, stream+":"+line)
	}
}

// collectLines 从 collectEmit 收集的 slice 中取出纯行内容。
func collectLines(out []string) []string {
	var lines []string
	for _, s := range out {
		if i := strings.Index(s, ":"); i >= 0 {
			lines = append(lines, s[i+1:])
		}
	}
	return lines
}

// TestShellRunnerUsesParams 验证 Run 用 params 替换 ${VAR}（跨平台：echo 在 cmd/sh 都可用）。
func TestShellRunnerUsesParams(t *testing.T) {
	r := &ShellRunner{Cfg: ShellConfig{
		Shell:   "echo hello ${NAME}",
		Timeout: 5 * time.Second,
	}}
	var out []string
	res := r.Run(context.Background(), map[string]any{"NAME": "world"}, collectEmit(&out))
	if res.Err != nil {
		t.Fatalf("run err: %v", res.Err)
	}
	joined := strings.Join(collectLines(out), "\n")
	if !strings.Contains(joined, "hello world") {
		t.Fatalf("params 未注入，输出: %q", joined)
	}
}
