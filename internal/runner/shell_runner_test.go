package runner

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// requireBash 保证本机可解析 bash（Git Bash/MSYS2），否则跳过——
// 真实执行类测试依赖 bash 存在。
func requireBash(t *testing.T) {
	t.Helper()
	if _, err := resolveInterpreter("bash", ""); err != nil {
		t.Skipf("bash 不可用: %v", err)
	}
}

func TestShellRunner_Success(t *testing.T) {
	requireBash(t)
	r := &ShellRunner{Cfg: ShellConfig{Run: "echo hello", Timeout: 5 * time.Second}}
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
	requireBash(t)
	r := &ShellRunner{Cfg: ShellConfig{Run: "sh -c 'exit 7'", Timeout: 5 * time.Second}}
	res := r.Run(context.Background(), nil, func(s, l string) {})
	if res.ExitCode != 7 {
		t.Fatalf("exit=%d want 7", res.ExitCode)
	}
}

func TestShellRunner_Timeout(t *testing.T) {
	requireBash(t)
	r := &ShellRunner{Cfg: ShellConfig{Run: "sleep 10", Timeout: 100 * time.Millisecond}}
	res := r.Run(context.Background(), nil, func(s, l string) {})
	if res.Err == nil {
		t.Fatalf("期望超时错误")
	}
}

func TestShellRunner_Cancel(t *testing.T) {
	requireBash(t)
	ctx, cancel := context.WithCancel(context.Background())
	r := &ShellRunner{Cfg: ShellConfig{Run: "sleep 10", Timeout: 30 * time.Second}}
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
	requireBash(t)
	r := &ShellRunner{Cfg: ShellConfig{Run: "sh -c 'echo err >&2'", Timeout: 5 * time.Second}}
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
		t.Fatalf("run/script 都空时应报错")
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

// TestShellRunnerUsesParams 验证 Run 用 params 替换 ${VAR}（统一 bash 语法）。
func TestShellRunnerUsesParams(t *testing.T) {
	requireBash(t)
	r := &ShellRunner{Cfg: ShellConfig{
		Run:     "echo hello ${NAME}",
		Timeout: 5 * time.Second,
	}}
	var out []string
	res := r.Run(context.Background(), map[string]any{"NAME": "world"}, collectEmit(&out))
	if res.Err != nil {
		t.Fatalf("run err: %v", res.Err)
	}
	joined := strings.Join(collectLines(out), "\n")
	if !strings.Contains(joined, "world") {
		t.Fatalf("params 未注入，输出: %q", joined)
	}
}

// TestShellRunnerUsesStepEnvInText 验证 cfg.Env 的终值能被 ${VAR} 文本展开命中——
// Go 侧统一展开保证跨解释器一致（demo-all-features 的 env 注入 artifact= 空值即此缺陷）。
func TestShellRunnerUsesStepEnvInText(t *testing.T) {
	requireBash(t)
	r := &ShellRunner{Cfg: ShellConfig{
		Run:     "echo artifact=${ARTIFACT} mode=${MODE}",
		Env:     map[string]string{"ARTIFACT": "demo-app.apk"},
		Timeout: 5 * time.Second,
	}}
	var out []string
	res := r.Run(context.Background(), map[string]any{"MODE": "fast"}, collectEmit(&out))
	if res.Err != nil {
		t.Fatalf("run err: %v", res.Err)
	}
	joined := strings.Join(collectLines(out), "\n")
	if !strings.Contains(joined, "demo-app.apk") {
		t.Fatalf("env 终值未参与 ${VAR} 展开，输出: %q", joined)
	}
	if !strings.Contains(joined, "fast") {
		t.Fatalf("params 展开被破坏，输出: %q", joined)
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

// TestBuildCommand_WindowsDefaultBash 验证 Windows 下默认（不写 shell）走 bash
// 且 argv 含 -eo pipefail 错误语义、run 内容落临时文件（.sh 后缀）。
func TestBuildCommand_WindowsDefaultBash(t *testing.T) {
	requireBash(t)
	cmd, cleanup, err := buildCommandFromCfg(ShellConfig{Run: `echo "hi"`})
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	joined := strings.Join(cmd.Args, " ")
	if !strings.Contains(joined, "bash") {
		t.Fatalf("默认应走 bash: %s", joined)
	}
	if !strings.Contains(joined, "-eo") || !strings.Contains(joined, "pipefail") {
		t.Fatalf("bash 应带 -eo pipefail: %s", joined)
	}
	script := cmd.Args[len(cmd.Args)-1]
	if !strings.HasSuffix(script, ".sh") {
		t.Fatalf("run 内容应落 .sh 临时文件: %s", script)
	}
}

// TestBuildCommand_ScriptShellOverride script 形态显式 shell 覆盖扩展名推断
// （design 第 53/112/178 行）。刻意用自定义模板 + 不受支持的 .pl 扩展名：
// 扩展名推断若没让位就会报「script 扩展名不受支持」；resolveInterpreter 对非内置
// 名原样返回，所以本机没装 perl 也能断言 argv。
func TestBuildCommand_ScriptShellOverride(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "hello.pl")
	if err := os.WriteFile(script, []byte("print 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd, cleanup, err := buildCommandFromCfg(ShellConfig{Script: script, Shell: "perl -w {0}"})
	if err != nil {
		t.Fatalf("script + 显式 shell 应可构造: %v", err)
	}
	defer cleanup()
	want := []string{"perl", "-w", script}
	if !reflect.DeepEqual(cmd.Args, want) {
		t.Fatalf("argv = %v, want %v", cmd.Args, want)
	}
}

// TestBuildCommand_ScriptUnknownExtWithoutShell 反向锁住：不写 shell 时未知扩展名必须报错
// （让位只在显式 shell 时发生，不是把校验整体拆了）。
func TestBuildCommand_ScriptUnknownExtWithoutShell(t *testing.T) {
	// 不需要真实文件：扩展名推断（ShellNameByScript）早于路径存在性校验（resolveScriptPath），
	// 错误必然先由前者抛出，所以只拼一个不存在的 .pl 路径即可。
	script := filepath.Join(t.TempDir(), "hello.pl")
	_, _, err := buildCommandFromCfg(ShellConfig{Script: script})
	if err == nil {
		t.Fatal("未写 shell 且扩展名不受支持，应报错")
	}
	// 校验错误来自扩展名推断，而非别处（否则这条防线会因错误的理由变绿）
	if !strings.Contains(err.Error(), "扩展名不受支持") {
		t.Fatalf("错误应来自扩展名推断，got %v", err)
	}
}

func TestShellRunner_CaptureOutput_DefaultOn(t *testing.T) {
	requireBash(t)
	r := &ShellRunner{Cfg: ShellConfig{
		Run:     `echo "hello"; echo "err" >&2`,
		Timeout: 5 * time.Second,
	}}
	res := r.Run(context.Background(), nil, func(string, string) {})
	if res.ExitCode != 0 {
		t.Fatalf("exit code = %d, want 0", res.ExitCode)
	}
	if res.Stdout != "hello\n" {
		t.Fatalf("stdout = %q, want %q", res.Stdout, "hello\n")
	}
	if res.Stderr != "err\n" {
		t.Fatalf("stderr = %q, want %q", res.Stderr, "err\n")
	}
	if res.Outputs["exit_code"] != "0" || res.Outputs["success"] != "true" {
		t.Fatalf("outputs = %+v, want exit_code=0 success=true", res.Outputs)
	}
}

func TestShellRunner_CaptureOutput_ExplicitOff(t *testing.T) {
	requireBash(t)
	off := false
	r := &ShellRunner{Cfg: ShellConfig{
		Run:           `echo "hello"`,
		Timeout:       5 * time.Second,
		CaptureOutput: &off,
	}}
	res := r.Run(context.Background(), nil, func(string, string) {})
	if res.Stdout != "" {
		t.Fatalf("stdout = %q, want empty when capture_output=false", res.Stdout)
	}
	if res.Outputs["exit_code"] != "0" {
		t.Fatalf("exit_code output 仍应存在（不依赖 capture_output）: %+v", res.Outputs)
	}
}

func TestShellRunner_CaptureOutput_ProtocolLine(t *testing.T) {
	requireBash(t)
	r := &ShellRunner{Cfg: ShellConfig{
		Run:     `echo "normal line"; echo "##[output build_id=42]"`,
		Timeout: 5 * time.Second,
	}}
	res := r.Run(context.Background(), nil, func(string, string) {})
	if res.Outputs["build_id"] != "42" {
		t.Fatalf("outputs[build_id] = %q, want 42; outputs=%+v", res.Outputs["build_id"], res.Outputs)
	}
	// 协议行仍照常流式输出（不吞掉），保持现有前端行为不变
	if !strings.Contains(res.Stdout, "##[output build_id=42]") {
		t.Fatalf("协议行应仍出现在原始 stdout 里: %q", res.Stdout)
	}
}

// ##[progress ...] 行改走 progress 流：不进 stdout 捕获、不当普通 stdout emit，
// 前端据此原地覆盖上一条进度（\r 已被 splitLines 切行，只能靠该协议刷新单行）。
func TestShellRunner_ProgressLine(t *testing.T) {
	requireBash(t)
	r := &ShellRunner{Cfg: ShellConfig{
		Run:     `echo "普通行"; echo "##[progress 下载 50%]"; echo "##[progress 下载 100%]"`,
		Timeout: 5 * time.Second,
	}}
	var got []string
	res := r.Run(context.Background(), nil, func(s, l string) { got = append(got, s+":"+l) })
	if !contains(got, "progress:下载 50%") || !contains(got, "progress:下载 100%") {
		t.Fatalf("协议行应以 progress 流 emit（文本已剥协议壳），got=%v", got)
	}
	if strings.Contains(res.Stdout, "##[progress") {
		t.Fatalf("progress 行不应进 stdout 捕获: %q", res.Stdout)
	}
	if !strings.Contains(res.Stdout, "普通行") {
		t.Fatalf("普通 stdout 行仍应被捕获: %q", res.Stdout)
	}
}

func TestShellRunner_CaptureOutput_ReservedKeyOverride(t *testing.T) {
	requireBash(t)
	r := &ShellRunner{Cfg: ShellConfig{
		Run:     `echo "##[output exit_code=999]"`,
		Timeout: 5 * time.Second,
	}}
	res := r.Run(context.Background(), nil, func(string, string) {})
	// 协议值覆盖 reserved key（已在 spec 中确认此优先级）
	if res.Outputs["exit_code"] != "999" {
		t.Fatalf("reserved key 应被协议行覆盖，got %q", res.Outputs["exit_code"])
	}
}

func TestShellRunner_StdoutCapped(t *testing.T) {
	requireBash(t)
	// 生成超过 256KB 的输出：300000 个 'x'，每行1个字符+\n，共约 600KB
	r := &ShellRunner{Cfg: ShellConfig{
		Run:     "yes x | head -n 300000",
		Timeout: 10 * time.Second,
	}}
	res := r.Run(context.Background(), nil, func(s, l string) {})
	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if len(res.Stdout) > maxCaptureBytes {
		t.Fatalf("len(Stdout)=%d 超过上限 %d", len(res.Stdout), maxCaptureBytes)
	}
	if len(res.Stdout) == 0 {
		t.Fatal("Stdout 不应为空")
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
