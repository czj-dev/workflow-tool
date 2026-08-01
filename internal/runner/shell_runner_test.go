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
	// 跨 shell 校验：cmd 的 echo 输出 "hello world" 一行；PowerShell 的 echo 多参数会分行，
	// 只要出现 NAME 的值 "world" 即说明 ${NAME} 已被 params 替换
	if !strings.Contains(joined, "world") {
		t.Fatalf("params 未注入，输出: %q", joined)
	}
}

// TestBuildEnvInjectsParamsAndKeepsParent 验证 params（全局+动作参数）与动作 env
// 都注入子进程环境变量，且父进程 env（如 PATH）保留——脚本内部 $env:VAR / ${VAR} 才能读到。
func TestBuildEnvInjectsParamsAndKeepsParent(t *testing.T) {
	env := buildEnv(map[string]any{"PROJECT_DIR": "D:/proj"}, map[string]string{"USER_AGENT": "M"})
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "PROJECT_DIR=D:/proj") {
		t.Fatalf("params 未注入 env: %v", env)
	}
	if !strings.Contains(joined, "USER_AGENT=M") {
		t.Fatalf("动作 env 未注入: %v", env)
	}
	// 父进程 env 保留（os.Environ 通常几十项）
	if len(env) <= 2 {
		t.Fatalf("父进程 env 似乎丢失（len=%d）", len(env))
	}
}

// TestBuildCommandWindowsShellUsesPowerShell 验证 Windows 下 shell 形态默认走 PowerShell
// （而非 cmd /c），shell 内容作为 -Command 参数完整传递（引号不被吃掉）。
func TestBuildCommandWindowsShellUsesPowerShell(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("windows 专属行为")
	}
	cmd, err := buildCommandFromCfg(ShellConfig{Shell: `claude -p "hi"`})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(cmd.Args, " ")
	if strings.Contains(joined, " /c ") {
		t.Fatalf("不应再用 cmd /c: %s", joined)
	}
	if !strings.Contains(joined, "powershell") && !strings.Contains(joined, "pwsh") {
		t.Fatalf("Windows shell 应用 powershell/pwsh: %s", joined)
	}
	if !strings.Contains(joined, "-Command") {
		t.Fatalf("应用 -Command 传 shell: %s", joined)
	}
	if !strings.Contains(joined, `claude -p "hi"`) {
		t.Fatalf("shell 内容应完整保留（含引号）: %s", joined)
	}
}

// TestStripANSI 验证剥离 ANSI 颜色/样式控制序列，避免前端把 PowerShell 等输出的
// 彩色码（如 \x1b[31;1m）渲染成可见乱码。
func TestStripANSI(t *testing.T) {
	cases := []struct{ in, want string }{
		{"\x1b[31;1madb: error\x1b[0m", "adb: error"},
		{"plain text", "plain text"},
		{"\x1b[1mbold\x1b[22m \x1b[32mgreen\x1b[0m", "bold green"},
		{"", ""},
	}
	for _, c := range cases {
		if got := stripANSI(c.in); got != c.want {
			t.Errorf("stripANSI(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
