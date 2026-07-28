package runner

import (
	"context"
	"runtime"
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
