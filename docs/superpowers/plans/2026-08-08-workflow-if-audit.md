# workflow if 功能缺口审计 + Runner 拆分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 workflow `if` 功能的 3 个审计缺口：(1) `if` 引用不存在/前向 step id 会中断整条 workflow → 改为加载期静态报错；(2) `Result.Stdout`/`Stderr` 累积无总量上限 → 加 256KB 上限防 OOM；(3) LLM 解析逻辑寄生在 `ShellRunner` 内部分支、`\r` 单独进度行会丢失 → 抽通用进程编排层 + LLM 拆成独立 Runner。

**Architecture:** 三层改动，自底向上：`internal/runner/exec.go`（新，纯进程编排，`\n`/`\r` 双切行）→ `ShellRunner` 改用它 + 加 256KB capBuffer → `LLMRunner`（新，独立文件，替代 `ShellRunner` 内 `cfg.Stream=="llm"` 分支）→ api 层两处按 `Command.Stream` 选 Runner → `workflow.Validate` 用 expr AST 静态提取 `if` 引用的 step id 校验存在性。`Runner` 接口签名不变。

**Tech Stack:** Go 1.x（沿用项目现有版本）、`github.com/expr-lang/expr`（已是依赖，本次新增使用其 `parser`/`ast` 子包）、标准库 `bufio`/`os/exec`/`context`。

## Global Constraints

- `Runner.Run(ctx, params, emit) Result` 接口签名不变（CLAUDE.md 红线）——只扩 `Result` 字段，不改方法签名。
- `Stdout`/`Stderr` 累积上限：256KB（超出保留尾部，丢弃最旧内容）。
- 不引入新的第三方依赖——`expr-lang/expr` 已在 `go.mod`（`v1.17.8`），只是新用其 `parser`/`ast` 子包。
- 现有 action/workflow YAML 向后兼容不变；`registry.CommandDef.Stream` 字段保留（YAML 层不变），只是消费方从 ShellRunner 内部改成 api 层。
- 改 `internal/api/api.go` 的 Service 方法签名/类型后需要 `wails3 generate bindings`；本计划改动只涉及内部私有方法体（`execute`/`makeActionRun` 内部 runner 选择逻辑），不改签名，故本计划不需要重跑 bindings（如某任务发现确需改签名，任务内会明确标注）。
- 每个任务完成后运行 `go test ./internal/runner ./internal/workflow ./internal/registry ./internal/api`，全绿才进入下一任务。
- Go 测试文件命名/风格沿用项目现状（如 `skipWindows(t)` helper、`context.Background()`、`t.Fatalf`）。

---

### Task 1: `internal/runner/exec.go` — 通用进程编排 + `\r`/`\n` 双切行

**Files:**
- Create: `internal/runner/exec.go`
- Test: `internal/runner/exec_test.go`

**Interfaces:**
- Produces:
  - `type OnLine func(stream, line string)` — stream 为 `"stdout"` 或 `"stderr"`
  - `type ExecRequest struct { Cmd *exec.Cmd; Timeout time.Duration }`
  - `type ExecOutcome struct { ExitCode int; Err error; Duration time.Duration }`
  - `func Run(ctx context.Context, req ExecRequest, onLine OnLine) ExecOutcome`
  - （包内私有）`func splitLines(data []byte, atEOF bool) (advance int, token []byte, err error)` — `bufio.SplitFunc`，`\n`/`\r` 均切行
  - （包内私有）`func scanLines(r io.Reader, stream string, onLine OnLine, done chan<- struct{})`
- Consumes: 项目现有 `killGroup(cmd *exec.Cmd)`（`internal/runner/pgid_unix.go`/`pgid_windows.go`，无需改动）、`stripANSI(s string) string`（`internal/runner/util.go`，无需改动）

- [ ] **Step 1: 写失败测试 — 正常执行 + stdout/stderr 分流**

```go
// internal/runner/exec_test.go
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
```

- [ ] **Step 2: 运行测试验证失败（编译错误，包不存在）**

Run: `go test ./internal/runner -run TestExecRun_Success -v`
Expected: FAIL，编译错误 `undefined: Run` / `undefined: ExecRequest`（`exec.go` 尚未创建）

- [ ] **Step 3: 创建 `exec.go` 最小实现（先支持 Step 1 用例）**

```go
// internal/runner/exec.go
package runner

import (
	"bufio"
	"context"
	"io"
	"os/exec"
	"time"
)

// OnLine 是逐行回调；stream 为 "stdout" 或 "stderr"。
// 调用方（ShellRunner/LLMRunner）在回调里做自己的 buffer 累积和 emit。
type OnLine func(stream, line string)

// ExecRequest 是一次进程执行的入参。
type ExecRequest struct {
	Cmd     *exec.Cmd
	Timeout time.Duration
}

// ExecOutcome 是进程执行的产物（不含 stdout/stderr 内容——由调用方在 onLine 里累积）。
type ExecOutcome struct {
	ExitCode int
	Err      error
	Duration time.Duration
}

// Run 启动 req.Cmd，stdout/stderr 按行回调 onLine（\n 与 \r 都切行，
// 修复 adb push/install 等 \r 刷新进度条的场景）；超时则杀整个进程组。
// hideWindow/setPgid 需由调用方在传入 req.Cmd 前完成（沿用现有跨平台实现）。
func Run(ctx context.Context, req ExecRequest, onLine OnLine) ExecOutcome {
	start := time.Now()
	timeoutCtx, cancel := context.WithTimeout(ctx, req.Timeout)
	defer cancel()

	cmd := req.Cmd
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return ExecOutcome{ExitCode: -1, Err: err, Duration: time.Since(start)}
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return ExecOutcome{ExitCode: -1, Err: err, Duration: time.Since(start)}
	}
	if err := cmd.Start(); err != nil {
		return ExecOutcome{ExitCode: -1, Err: err, Duration: time.Since(start)}
	}

	doneOut := make(chan struct{})
	doneErr := make(chan struct{})
	go scanLines(stdoutPipe, "stdout", onLine, doneOut)
	go scanLines(stderrPipe, "stderr", onLine, doneErr)

	waitCh := make(chan error, 1)
	go func() {
		<-doneOut
		<-doneErr
		waitCh <- cmd.Wait()
	}()

	select {
	case <-timeoutCtx.Done():
		killGroup(cmd)
		<-waitCh
		return ExecOutcome{ExitCode: -1, Err: timeoutCtx.Err(), Duration: time.Since(start)}
	case werr := <-waitCh:
		exitCode := 0
		if werr != nil {
			if ee, ok := werr.(*exec.ExitError); ok {
				exitCode = ee.ExitCode()
			} else {
				return ExecOutcome{ExitCode: -1, Err: werr, Duration: time.Since(start)}
			}
		}
		return ExecOutcome{ExitCode: exitCode, Duration: time.Since(start)}
	}
}

// scanLines 用 bufio.Scanner 配 splitLines（\n 与 \r 都切行）逐行回调，并去除 ANSI 转义序列。
func scanLines(r io.Reader, stream string, onLine OnLine, done chan<- struct{}) {
	defer close(done)
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	sc.Split(splitLines)
	for sc.Scan() {
		onLine(stream, stripANSI(sc.Text()))
	}
}

// splitLines 是 bufio.SplitFunc：\n 或 \r 均视为行结束（adb push/install
// 等命令用 \r 刷新同一行显示进度，标准 bufio.ScanLines 只认 \n 会把整条进度流当一行）。
func splitLines(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	for i, b := range data {
		if b == '\n' || b == '\r' {
			return i + 1, data[:i], nil
		}
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `go test ./internal/runner -run TestExecRun_Success -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add internal/runner/exec.go internal/runner/exec_test.go
git commit -m "feat: 抽通用进程编排 exec.Run，替代 ShellRunner 内嵌逻辑"
```

- [ ] **Step 6: 补充测试 — 非零 exit code**

```go
// internal/runner/exec_test.go 追加
func TestExecRun_NonZeroExit(t *testing.T) {
	skipExecWindows(t)
	cmd := exec.Command("sh", "-c", "exit 7")
	outcome := Run(context.Background(), ExecRequest{Cmd: cmd, Timeout: 5 * time.Second}, func(stream, line string) {})
	if outcome.ExitCode != 7 {
		t.Fatalf("exit=%d want 7", outcome.ExitCode)
	}
}
```

Run: `go test ./internal/runner -run TestExecRun_NonZeroExit -v`
Expected: PASS（Step 3 实现已覆盖此分支，无需改动代码）

- [ ] **Step 7: 补充测试 — 超时触发 kill**

```go
// internal/runner/exec_test.go 追加
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
```

Run: `go test ./internal/runner -run TestExecRun_Timeout -v`
Expected: PASS（约 100ms 内返回，不等到 10s）

- [ ] **Step 8: 补充测试 — `\r` 分隔的进度行被切成独立行**

```go
// internal/runner/exec_test.go 追加
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
```

Run: `go test ./internal/runner -run TestExecRun_CarriageReturnSplitsLines -v`
Expected: PASS（验证 `splitLines` 按 `\r` 也切行）

- [ ] **Step 9: 运行 exec.go 全部测试确认无回归**

Run: `go test ./internal/runner -run TestExecRun -v`
Expected: 全部 PASS（4 个测试：Success/NonZeroExit/Timeout/CarriageReturnSplitsLines）

- [ ] **Step 10: 提交**

```bash
git add internal/runner/exec_test.go
git commit -m "test: exec.Run 补非零退出/超时/\\r切行测试"
```

---

### Task 2: `capBuffer` — 累积上限 256KB（防 OOM）

**Files:**
- Modify: `internal/runner/util.go`
- Test: `internal/runner/util_test.go`

**Interfaces:**
- Produces:
  - `const maxCaptureBytes = 256 * 1024`
  - `type capBuffer struct { limit int; buf []byte }`
  - `func newCapBuffer(limit int) *capBuffer`
  - `func (c *capBuffer) WriteLine(line string)` — nil-safe
  - `func (c *capBuffer) String() string` — nil-safe，返回空字符串
- Consumes: 无（纯新增，不依赖 Task 1）

- [ ] **Step 1: 写失败测试**

```go
// internal/runner/util_test.go 追加（该文件已存在，若无则新建 package runner 并加 import "testing"）
func TestCapBuffer_UnderLimit(t *testing.T) {
	c := newCapBuffer(100)
	c.WriteLine("hello")
	c.WriteLine("world")
	got := c.String()
	want := "hello\nworld\n"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestCapBuffer_OverLimit_KeepsTail(t *testing.T) {
	c := newCapBuffer(10)
	c.WriteLine("0123456789") // 11 bytes（含\n），已超限
	c.WriteLine("abcde")      // 追加后更超限，应只保留尾部 10 bytes
	got := c.String()
	if len(got) != 10 {
		t.Fatalf("len(got)=%d want 10, got=%q", len(got), got)
	}
	if got != "6789abcde\n" {
		t.Fatalf("got %q want %q", got, "6789abcde\n")
	}
}

func TestCapBuffer_Nil_Safe(t *testing.T) {
	var c *capBuffer
	c.WriteLine("noop") // 不应 panic
	if got := c.String(); got != "" {
		t.Fatalf("got %q want empty", got)
	}
}
```

- [ ] **Step 2: 运行测试验证失败**

Run: `go test ./internal/runner -run TestCapBuffer -v`
Expected: FAIL，编译错误 `undefined: newCapBuffer`

- [ ] **Step 3: 在 `util.go` 追加实现**

```go
// internal/runner/util.go 追加（文件已有 package runner + import，直接追加函数/类型）

// maxCaptureBytes 是 Stdout/Stderr 累积的软上限：超出只保留尾部，
// 防长跑输出（如误开 capture_output 的持续输出 action）撑爆内存。
// contains/matches 场景通常只关心最近输出，保留尾部足够。
const maxCaptureBytes = 256 * 1024

// capBuffer 是带总量上限的行累积器，超限保留尾部（丢弃最旧内容）。
type capBuffer struct {
	limit int
	buf   []byte
}

func newCapBuffer(limit int) *capBuffer {
	return &capBuffer{limit: limit}
}

// WriteLine 追加一行（自动补 \n）；超过 limit 时从头部截断，只留尾部。
func (c *capBuffer) WriteLine(line string) {
	if c == nil {
		return
	}
	c.buf = append(c.buf, line...)
	c.buf = append(c.buf, '\n')
	if len(c.buf) > c.limit {
		c.buf = c.buf[len(c.buf)-c.limit:]
	}
}

// String 返回累积内容；c 为 nil（capture_output=false）时返回空字符串。
func (c *capBuffer) String() string {
	if c == nil {
		return ""
	}
	return string(c.buf)
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `go test ./internal/runner -run TestCapBuffer -v`
Expected: PASS（3 个测试全绿）

- [ ] **Step 5: 提交**

```bash
git add internal/runner/util.go internal/runner/util_test.go
git commit -m "feat: 加 capBuffer 256KB 上限，防长跑输出撑爆内存"
```

---

### Task 3: `ShellRunner` 改用 `exec.Run` + `capBuffer`，删 `Stream` 字段

**Files:**
- Modify: `internal/runner/shell_runner.go`
- Modify: `internal/runner/shell_runner_test.go`

**Interfaces:**
- Consumes:
  - `runner.Run(ctx, ExecRequest, OnLine) ExecOutcome`（Task 1）
  - `newCapBuffer(limit int) *capBuffer`、`(*capBuffer).WriteLine`、`(*capBuffer).String()`（Task 2）
  - 已有 `Expand`/`ExpandMap`（`expand.go`，不变）、`buildCommandFromCfg`/`buildEnv`（本文件内，不变）、`hideWindow`/`setPgid`（不变）、`parseOutputLine`（`output.go`，不变）、`finalizeOutputs`（本文件内，保留）
- Produces:
  - `ShellConfig` 结构体**删除 `Stream` 字段**（下游 Task 5 的 api.go 两处调用点需同步删除 `Stream:` 赋值）
  - `ShellRunner.Run` 签名不变：`func (r *ShellRunner) Run(ctx context.Context, params map[string]any, emit EmitFunc) Result`

**重要说明：** 这一步会让 `internal/api/api.go` 里两处 `ShellConfig{..., Stream: la.Def.Command.Stream}` 编译失败（`Stream` 字段已删除）。Task 3 范围**只改 runner 包**，为了保持每个任务可独立编译测试，本任务额外要求：在删除 `ShellConfig.Stream` 字段的同一提交里，临时给 `internal/api/api.go` 两处调用点也删除 `Stream:` 那一行赋值（不改其他逻辑、不改函数签名），使整个仓库保持可编译。Task 5 会正式给 api.go 加 Runner 选择分发逻辑。

- [ ] **Step 1: 写失败测试 — 验证行为不变（复用现有测试用例语义，改验证 256KB 上限）**

```go
// internal/runner/shell_runner_test.go 追加
func TestShellRunner_StdoutCapped(t *testing.T) {
	skipWindows(t)
	// 生成超过 256KB 的输出：300000 个 'x'，每行1个字符+\n，共约 600KB
	r := &ShellRunner{Cfg: ShellConfig{
		Shell:   "yes x | head -n 300000",
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
```

- [ ] **Step 2: 运行测试验证失败**

Run: `go test ./internal/runner -run TestShellRunner_StdoutCapped -v`
Expected: FAIL（当前实现无上限，`len(res.Stdout)` 会远超 `maxCaptureBytes`；测试大概率会跑很久或直接失败在长度断言上）

- [ ] **Step 3: 重写 `shell_runner.go`**

先删除以下内容：`Stream` 字段（`ShellConfig` 结构体里）、`pump` 函数、`bufString` 函数、`Run` 方法里手写的 pipe/start/goroutine/select 逻辑。

```go
// internal/runner/shell_runner.go
package runner

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"time"
)

// ShellConfig 是已解析、待执行的命令配置。
type ShellConfig struct {
	Shell         string            // 内联命令（与 Script 二选一）
	Script        string            // 脚本路径不含扩展名（与 Shell 二选一）
	Cwd           string            // 工作目录（必须存在）
	Timeout       time.Duration     // 超时
	Env           map[string]string // 额外环境变量
	BaseDir       string            // exe 目录，用于解析相对 script 路径
	CaptureOutput *bool             // nil 或指向 true = 捕获全量 stdout/stderr 供 outputs 使用；指向 false = 关闭（长跑/持续输出 action 用）
}

// ShellRunner 执行单条 shell 命令或脚本文件，流式输出。
type ShellRunner struct {
	Cfg ShellConfig
}

// Run 执行配置的命令，通过 emit 流式推送输出。
func (r *ShellRunner) Run(ctx context.Context, params map[string]any, emit EmitFunc) Result {
	start := time.Now()

	// Phase 3：所有 Runner 实现都用 params 替换 ${VAR}（params>env，未定义保留+warning）
	cfg := r.Cfg
	cfg.Shell = Expand(cfg.Shell, params)
	cfg.Script = Expand(cfg.Script, params)
	cfg.Cwd = Expand(cfg.Cwd, params)
	cfg.Env = ExpandMap(cfg.Env, params)

	cmd, err := buildCommandFromCfg(cfg)
	if err != nil {
		return Result{Err: err, Duration: time.Since(start)}
	}
	hideWindow(cmd) // Windows 上隐藏子进程控制台窗口
	setPgid(cmd)    // Unix: 新进程组，cancel 时杀整组
	if cfg.Cwd != "" {
		cmd.Dir = cfg.Cwd
	}
	cmd.Env = buildEnv(params, cfg.Env)

	captureOn := cfg.CaptureOutput == nil || *cfg.CaptureOutput
	var stdoutBuf, stderrBuf *capBuffer
	outputs := map[string]string{}
	if captureOn {
		stdoutBuf = newCapBuffer(maxCaptureBytes)
		stderrBuf = newCapBuffer(maxCaptureBytes)
	}

	outcome := Run(ctx, ExecRequest{Cmd: cmd, Timeout: cfg.Timeout}, func(stream, line string) {
		emit(stream, line)
		if stream == "stdout" {
			stdoutBuf.WriteLine(line)
			if key, value, ok := parseOutputLine(line); ok {
				outputs[key] = value
			}
		} else {
			stderrBuf.WriteLine(line)
		}
	})

	stdout, stderr := stdoutBuf.String(), stderrBuf.String()
	return Result{
		ExitCode: outcome.ExitCode, Err: outcome.Err, Duration: outcome.Duration,
		Stdout: stdout, Stderr: stderr, Outputs: finalizeOutputs(outputs, outcome.ExitCode, stdout, stderr),
	}
}

// buildCommandFromCfg 按 Shell/Script 和 OS 构造 exec.Cmd。
func buildCommandFromCfg(cfg ShellConfig) (*exec.Cmd, error) {
	if cfg.Shell == "" && cfg.Script == "" {
		return nil, fmt.Errorf("command: shell 和 script 必须二选一")
	}
	if cfg.Shell != "" && cfg.Script != "" {
		return nil, fmt.Errorf("command: shell 和 script 互斥")
	}
	if runtime.GOOS == "windows" {
		if cfg.Shell != "" {
			if path, err := exec.LookPath("pwsh"); err == nil {
				return exec.Command(path, "-NoProfile", "-Command", cfg.Shell), nil
			}
			return exec.Command("powershell", "-NoProfile", "-Command", cfg.Shell), nil
		}
		script, err := resolveScript(cfg.Script, ".ps1", cfg.BaseDir)
		if err != nil {
			return nil, err
		}
		if path, err := exec.LookPath("pwsh"); err == nil {
			return exec.Command(path, "-NoProfile", "-File", script), nil
		}
		return exec.Command("powershell", "-NoProfile", "-File", script), nil
	}
	if cfg.Shell != "" {
		return exec.Command("sh", "-c", cfg.Shell), nil
	}
	script, err := resolveScript(cfg.Script, ".sh", cfg.BaseDir)
	if err != nil {
		return nil, err
	}
	return exec.Command("sh", script), nil
}

// buildEnv 构造子进程环境变量：父进程 env + params + 动作 env（后者覆盖前者）。
func buildEnv(params map[string]any, cfgEnv map[string]string) []string {
	env := os.Environ()
	for k, v := range params {
		env = append(env, k+"="+fmt.Sprint(v))
	}
	for k, v := range cfgEnv {
		env = append(env, k+"="+v)
	}
	return env
}

// finalizeOutputs 补齐通用 Layer 1 outputs：exit_code/stdout/stderr/success。
// 协议行已提前写入 outputs，若与 reserved key 同名则协议值优先（不覆盖回退）。
func finalizeOutputs(outputs map[string]string, exitCode int, stdout, stderr string) map[string]string {
	if _, ok := outputs["exit_code"]; !ok {
		outputs["exit_code"] = fmt.Sprint(exitCode)
	}
	if _, ok := outputs["stdout"]; !ok {
		outputs["stdout"] = stdout
	}
	if _, ok := outputs["stderr"]; !ok {
		outputs["stderr"] = stderr
	}
	if _, ok := outputs["success"]; !ok {
		outputs["success"] = fmt.Sprint(exitCode == 0)
	}
	return outputs
}
```

- [ ] **Step 4: 临时修 `internal/api/api.go` 两处调用点，删除 `Stream:` 赋值以保持可编译**

在 `internal/api/api.go` 找到以下两处（`execute` 方法与 `makeActionRun` 方法内），各删除一行 `Stream: la.Def.Command.Stream,`：

```go
// 第一处（execute 方法内）—— 删除 Stream 那一行，其余不变
r := &runner.ShellRunner{Cfg: runner.ShellConfig{
    Shell:   la.Def.Command.Shell,
    Script:  la.Def.Command.Script,
    Cwd:     la.Cwd,
    Timeout: la.Timeout,
    Env:     la.Def.Command.Env,
    BaseDir: s.baseDir,
}}
```

```go
// 第二处（makeActionRun 方法内）—— 删除 Stream 那一行，其余不变
r := &runner.ShellRunner{Cfg: runner.ShellConfig{
    Shell:         la.Def.Command.Shell,
    Script:        la.Def.Command.Script,
    Cwd:           la.Cwd,
    Timeout:       la.Timeout,
    Env:           mergedEnv,
    BaseDir:       s.baseDir,
    CaptureOutput: capture,
}}
```

（第三处 `makeShellRun` 方法内的 `ShellConfig` 本来就没有 `Stream` 字段，不用改。）

这是**临时状态**——`stream: llm` 的 action 现在会被 `ShellRunner` 当普通 shell 命令跑，claude stream-json 原始行会被逐行 emit 成普通 stdout（行为退化，非最终状态）。Task 5 会补上正确的 Runner 选择分发。此处只求编译通过、既有非 LLM 测试不受影响，Task 4/5 完成前不要跑 LLM 相关的 api 集成测试。

- [ ] **Step 5: 运行 shell_runner 测试确认无回归**

Run: `go test ./internal/runner -run TestShellRunner -v`
Expected: 全部 PASS，包括新增的 `TestShellRunner_StdoutCapped`

- [ ] **Step 6: 运行全仓库编译检查**

Run: `go build ./...`
Expected: 编译成功（无残留 `Stream` 字段引用）

- [ ] **Step 7: 运行完整测试套件确认无回归**

Run: `go test ./internal/runner ./internal/registry ./internal/workflow ./internal/api`
Expected: 全部 PASS（`internal/api` 的 `TestLoadParsesStream`/`TestValidateBadStream` 类测试测的是 registry 解析层，不受影响；若有直接依赖 `ShellConfig.Stream` 字段的 api 测试失败，按 Step 4 的方式同步删除）

- [ ] **Step 8: 提交**

```bash
git add internal/runner/shell_runner.go internal/runner/shell_runner_test.go internal/api/api.go
git commit -m "refactor: ShellRunner 收瘦为 exec.Run+capBuffer，删 Stream 字段（LLM 分发临时退化，Task5补上）"
```

---

### Task 4: `LLMRunner`（新独立文件）+ 删 `llm.go` 里的 `pumpLLM`

**Files:**
- Create: `internal/runner/llm_runner.go`
- Create: `internal/runner/llm_runner_test.go`
- Modify: `internal/runner/llm.go`（删除 `pumpLLM` 函数，保留 `parseLLMLine`/`recordStructuredFields`/`llmStreamEvent`）
- Modify: `internal/runner/llm_test.go`（若其中有测试 `pumpLLM`，需迁移或删除——先读一遍确认）

**Interfaces:**
- Consumes:
  - `runner.Run(ctx, ExecRequest, OnLine) ExecOutcome`（Task 1）
  - `Expand`/`ExpandMap`（`expand.go`，不变）
  - `buildCommandFromCfg`/`buildEnv`（`shell_runner.go`，Task 3 后仍存在，包内可见）
  - `hideWindow`/`setPgid`（不变）
  - `parseLLMLine(line string) (kind, delta string, ok bool)`（`llm.go`，不变）
  - `recordStructuredFields(line string, outputs map[string]string)`（`llm.go`，不变）
  - `finalizeOutputs(outputs map[string]string, exitCode int, stdout, stderr string) map[string]string`（`shell_runner.go`，不变）
- Produces:
  - `type LLMConfig = ShellConfig`（类型别名，字段完全一致）
  - `type LLMRunner struct { Cfg LLMConfig }`
  - `func (r *LLMRunner) Run(ctx context.Context, params map[string]any, emit EmitFunc) Result` — 实现 `Runner` 接口

- [ ] **Step 1: 先读 `llm_test.go`，确认是否有测试直接调用 `pumpLLM`**

Run: `grep -n "pumpLLM" internal/runner/llm_test.go`
Expected: 记录下命中的测试函数名，下一步需要迁移它们的断言逻辑到 `llm_runner_test.go`（用 `LLMRunner.Run` 整体测，而不是单测 `pumpLLM` 内部）

- [ ] **Step 2: 写失败测试 — `LLMRunner` 解析 stream-json 并 emit**

```go
// internal/runner/llm_runner_test.go
package runner

import (
	"context"
	"runtime"
	"testing"
	"time"
)

func skipLLMWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix 专属 shell 行为")
	}
}

func TestLLMRunner_ParsesAssistantText(t *testing.T) {
	skipLLMWindows(t)
	// 模拟 claude stream-json：一行 assistant text 事件
	line := `{"type":"assistant","message":{"content":[{"type":"text","text":"hello world"}]}}`
	cmdStr := "echo '" + line + "'"
	r := &LLMRunner{Cfg: LLMConfig{Shell: cmdStr, Timeout: 5 * time.Second}}

	var llmEvents []string
	res := r.Run(context.Background(), nil, func(stream, l string) {
		if stream == "llm" {
			llmEvents = append(llmEvents, l)
		}
	})

	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit=%d want 0", res.ExitCode)
	}
	if res.Stdout != "hello world" {
		t.Fatalf("Stdout=%q want %q", res.Stdout, "hello world")
	}
	if len(llmEvents) == 0 || llmEvents[0] != "hello world" {
		t.Fatalf("llm events=%v want [\"hello world\"]", llmEvents)
	}
}

func TestLLMRunner_NonJSONLineSkipped(t *testing.T) {
	skipLLMWindows(t)
	r := &LLMRunner{Cfg: LLMConfig{Shell: "echo 'not json'", Timeout: 5 * time.Second}}
	res := r.Run(context.Background(), nil, func(stream, l string) {})
	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if res.Stdout != "" {
		t.Fatalf("Stdout=%q want empty（非法 JSON 应跳过）", res.Stdout)
	}
}

func TestLLMRunner_StderrEmittedNotCaptured(t *testing.T) {
	skipLLMWindows(t)
	r := &LLMRunner{Cfg: LLMConfig{Shell: "echo 'diagnostic' 1>&2", Timeout: 5 * time.Second}}
	var stderrLines []string
	res := r.Run(context.Background(), nil, func(stream, l string) {
		if stream == "stderr" {
			stderrLines = append(stderrLines, l)
		}
	})
	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if len(stderrLines) != 1 || stderrLines[0] != "diagnostic" {
		t.Fatalf("stderr lines=%v want [\"diagnostic\"]", stderrLines)
	}
	if res.Stderr != "" {
		t.Fatalf("Result.Stderr=%q want empty（stderr 只 emit，不进 Result）", res.Stderr)
	}
}
```

- [ ] **Step 3: 运行测试验证失败**

Run: `go test ./internal/runner -run TestLLMRunner -v`
Expected: FAIL，编译错误 `undefined: LLMRunner`

- [ ] **Step 4: 创建 `llm_runner.go`**

```go
// internal/runner/llm_runner.go
package runner

import (
	"context"
	"strings"
	"time"
)

// LLMConfig 是 LLM action 的执行配置（与 ShellConfig 字段一致）。
type LLMConfig = ShellConfig

// LLMRunner 执行 claude CLI 命令，解析 stream-json，只把 assistant 的
// text/thinking 增量 emit 为 "llm"/"llm-thinking"；Result.Stdout 只放
// assistant text（供 if 表达式判断 LLM 回答内容，如 outputs.ask.stdout contains "重试"）。
type LLMRunner struct {
	Cfg LLMConfig
}

// Run 执行配置的 claude 命令，流式解析 stream-json 并推送。
func (r *LLMRunner) Run(ctx context.Context, params map[string]any, emit EmitFunc) Result {
	start := time.Now()

	cfg := r.Cfg
	cfg.Shell = Expand(cfg.Shell, params)
	cfg.Script = Expand(cfg.Script, params)
	cfg.Cwd = Expand(cfg.Cwd, params)
	cfg.Env = ExpandMap(cfg.Env, params)

	cmd, err := buildCommandFromCfg(cfg)
	if err != nil {
		return Result{Err: err, Duration: time.Since(start)}
	}
	hideWindow(cmd)
	setPgid(cmd)
	if cfg.Cwd != "" {
		cmd.Dir = cfg.Cwd
	}
	cmd.Env = buildEnv(params, cfg.Env)

	var textBuf strings.Builder
	outputs := map[string]string{}

	outcome := Run(ctx, ExecRequest{Cmd: cmd, Timeout: cfg.Timeout}, func(stream, line string) {
		if stream == "stderr" {
			emit("stderr", line) // claude 诊断信息，原样推前端，不进 Result
			return
		}
		recordStructuredFields(line, outputs)
		kind, delta, ok := parseLLMLine(line)
		if !ok {
			return
		}
		if kind == "thinking" {
			emit("llm-thinking", delta)
		} else {
			textBuf.WriteString(delta)
			emit("llm", delta)
		}
	})

	stdout := textBuf.String()
	return Result{
		ExitCode: outcome.ExitCode, Err: outcome.Err, Duration: outcome.Duration,
		Stdout: stdout, Outputs: finalizeOutputs(outputs, outcome.ExitCode, stdout, ""),
	}
}
```

- [ ] **Step 5: 删除 `llm.go` 里的 `pumpLLM` 函数**

在 `internal/runner/llm.go` 中删除整个 `pumpLLM` 函数定义（原 66-96 行附近），保留 `llmStreamEvent`/`parseLLMLine`/`recordStructuredFields`。删除后检查文件头部 `import` 是否有变量因此变成未使用（`pumpLLM` 用到的 `bufio`/`io` 若 `parseLLMLine`/`recordStructuredFields` 不再需要则一并删除对应 import；`bufio`/`io` 具体是否还需要取决于删除后剩余函数是否用到，实现时以 `go build` 报错为准逐一修正）。

- [ ] **Step 6: 若 Step 1 发现 `llm_test.go` 里有测试直接调 `pumpLLM`，删除或迁移这些测试**

对每个命中的测试函数：若测试的是"stream-json 一行怎么解析"这类语义，改为直接测 `parseLLMLine`/`recordStructuredFields`（这两个函数保留，测试应该已经覆盖，检查是否重复）；若测试的是"pumpLLM 整体行为"（起 goroutine、emit、done 信号），删除该测试——等价场景已被 Step 2 新增的 `TestLLMRunner_*` 覆盖。

- [ ] **Step 7: 运行测试验证通过**

Run: `go test ./internal/runner -run "TestLLMRunner|TestParseLLMLine|TestRecordStructuredFields" -v`
Expected: 全部 PASS

- [ ] **Step 8: 运行全仓库编译检查**

Run: `go build ./...`
Expected: 编译成功

- [ ] **Step 9: 运行 runner 包完整测试**

Run: `go test ./internal/runner -v`
Expected: 全部 PASS，无残留对 `pumpLLM` 的引用

- [ ] **Step 10: 提交**

```bash
git add internal/runner/llm_runner.go internal/runner/llm_runner_test.go internal/runner/llm.go internal/runner/llm_test.go
git commit -m "feat: LLM 解析拆成独立 LLMRunner，删 ShellRunner 内嵌 pumpLLM 分支"
```

---

### Task 5: api 层按 `Command.Stream` 分发 Runner（两处）

**Files:**
- Modify: `internal/api/api.go`

**Interfaces:**
- Consumes:
  - `runner.ShellRunner{Cfg: runner.ShellConfig{...}}`（Task 3，`ShellConfig` 已无 `Stream` 字段）
  - `runner.LLMRunner{Cfg: runner.LLMConfig{...}}`（Task 4）
  - `runner.Runner` 接口（不变）：`Run(ctx, params, emit) Result`
- Produces: 无新增导出符号，只改 `execute`/`makeActionRun` 方法体内部逻辑（方法签名不变，不影响 Wails bindings）

- [ ] **Step 1: 修改 `execute` 方法（约第 349-380 行），加 Runner 选择**

把：

```go
r := &runner.ShellRunner{Cfg: runner.ShellConfig{
    Shell:   la.Def.Command.Shell,
    Script:  la.Def.Command.Script,
    Cwd:     la.Cwd,
    Timeout: la.Timeout,
    Env:     la.Def.Command.Env,
    BaseDir: s.baseDir,
}}

res := r.Run(ctx, params, emit)
```

改为：

```go
shellCfg := runner.ShellConfig{
    Shell:   la.Def.Command.Shell,
    Script:  la.Def.Command.Script,
    Cwd:     la.Cwd,
    Timeout: la.Timeout,
    Env:     la.Def.Command.Env,
    BaseDir: s.baseDir,
}
var r runner.Runner
if la.Def.Command.Stream == "llm" {
    r = &runner.LLMRunner{Cfg: shellCfg}
} else {
    r = &runner.ShellRunner{Cfg: shellCfg}
}

res := r.Run(ctx, params, emit)
```

- [ ] **Step 2: 修改 `makeActionRun` 方法（约第 577-616 行），加 Runner 选择**

把：

```go
r := &runner.ShellRunner{Cfg: runner.ShellConfig{
    Shell:         la.Def.Command.Shell,
    Script:        la.Def.Command.Script,
    Cwd:           la.Cwd,
    Timeout:       la.Timeout,
    Env:           mergedEnv,
    BaseDir:       s.baseDir,
    CaptureOutput: capture,
}}
return r.Run(ctx, runParams, stepEmit)
```

改为：

```go
shellCfg := runner.ShellConfig{
    Shell:         la.Def.Command.Shell,
    Script:        la.Def.Command.Script,
    Cwd:           la.Cwd,
    Timeout:       la.Timeout,
    Env:           mergedEnv,
    BaseDir:       s.baseDir,
    CaptureOutput: capture,
}
var r runner.Runner
if la.Def.Command.Stream == "llm" {
    r = &runner.LLMRunner{Cfg: shellCfg}
} else {
    r = &runner.ShellRunner{Cfg: shellCfg}
}
return r.Run(ctx, runParams, stepEmit)
```

- [ ] **Step 3: 运行全仓库编译检查**

Run: `go build ./...`
Expected: 编译成功

- [ ] **Step 4: 写集成测试验证两处分发都生效（若 `api_test.go` 已有可扩展的 harness，复用；否则新增最小验证）**

先读 `internal/api/api_test.go` 中现有围绕 `execute`/action 执行的测试写法（是否有构造 `registry.LoadedAction` + 调 `s.execute` 的现成 helper），复用其模式写：

```go
// internal/api/api_test.go 追加（若已有类似 helper 函数，调整为复用它们而非重复搭建 Service/registry）
func TestExecute_LLMStream_UsesLLMRunner(t *testing.T) {
	// 参考本文件已有测试的 Service/LoadedAction 构造方式，
	// 关键断言点：Command.Stream == "llm" 时，输出经 emit("llm", ...) 而非普通 emit("stdout", 原始 JSON 行)
	// 用一个 echo 假 stream-json 行的 shell 命令作为 la.Def.Command.Shell，
	// 断言 emit 收到过 stream=="llm" 的调用，且没有把原始 JSON 文本当 stdout 整行 emit 出去。
}
```

**给实现者的具体指引（无现成 harness 时的最小实现）**：

```go
func TestExecute_LLMStream_UsesLLMRunner(t *testing.T) {
	la := registry.LoadedAction{
		Def: registry.ActionDef{
			ID:    "fake-llm",
			Title: "fake",
			Command: registry.CommandDef{
				Shell:  `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}'`,
				Stream: "llm",
			},
		},
		Timeout: 5 * time.Second,
	}
	s := &Service{
		app:     testAppStub(t), // 若已有测试用的 app stub 构造方式，替换为现成的；否则参照本文件其他测试如何构造 Service
		running: map[string]bool{},
		baseDir: ".",
	}
	var gotStreams []string
	// execute 内部通过 s.app.Event.Emit 推事件；若现有测试是这样断言完成的，复用该机制而非直接调 emit closure
	s.execute(context.Background(), "fake-llm", la, nil)
	// 断言：不应该有 stream=="stdout" 且内容是原始 JSON 大括号文本的事件
	for _, line := range gotStreams {
		if strings.HasPrefix(line, "{") {
			t.Fatalf("原始 JSON 行被当 stdout 直接 emit，说明未走 LLMRunner: %q", line)
		}
	}
}
```

> 注：这一步的具体断言机制（如何拿到 `s.app.Event.Emit` 的调用记录）依赖 `internal/api/api_test.go` 现有的测试基础设施（app/事件 mock 方式）。实现时先读该文件已有测试（如围绕 `TestLoadParsesStream` 附近或其他 `s.execute` 调用点）复用其 mock/stub 模式，不要重新发明一套。若现有测试基础设施不支持捕获 emit 事件，改为最小验证：直接构造 `runner.LLMRunner{Cfg: shellCfg}` 和 `runner.ShellRunner{Cfg: shellCfg}` 分别 `Run` 同一个 fake stream-json 命令，断言 `LLMRunner` 结果 `Result.Stdout == "hi"` 而 `ShellRunner` 结果 `Result.Stdout` 包含原始 JSON 文本——这个层面的测试已经在 Task 4 的 `llm_runner_test.go` 覆盖，此处 Task 5 的重点是"api 层选对了 Runner"，可以退化为读代码确认 `execute`/`makeActionRun` 的 if 分支逻辑正确，配合 Step 5 的手动回归即可，不强制要求这条自动化测试硬跑通复杂的 mock。

- [ ] **Step 5: 手动回归 — 跑一个真实 `stream: llm` action 确认端到端行为不变**

Run: `bash deploy/build.sh` 然后手动在应用里触发一个已有的 `stream: llm` action（如仓库里已有的 claude 相关 action），确认前端 LLM 面板正常显示流式回复，无原始 JSON 泄露到普通输出区。

Expected: 行为与改动前一致（用户不可感知差异）

- [ ] **Step 6: 运行完整测试套件**

Run: `go test ./internal/runner ./internal/workflow ./internal/registry ./internal/api`
Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
git add internal/api/api.go internal/api/api_test.go
git commit -m "fix: api 层按 Command.Stream 分发 ShellRunner/LLMRunner（补上 Task3 临时退化）"
```

---

### Task 6: `referencedStepIDs` — 用 expr AST 提取 `if` 表达式引用的 step id

**Files:**
- Create: `internal/workflow/expr_refs.go`
- Create: `internal/workflow/expr_refs_test.go`

**Interfaces:**
- Consumes: `github.com/expr-lang/expr/parser`（已是 go.mod 依赖）、`github.com/expr-lang/expr/ast`
- Produces: `func referencedStepIDs(exprStr string) []string`（包内私有，Task 7 消费）

- [ ] **Step 1: 写失败测试**

```go
// internal/workflow/expr_refs_test.go
package workflow

import (
	"reflect"
	"sort"
	"testing"
)

func sortedStrings(s []string) []string {
	out := append([]string{}, s...)
	sort.Strings(out)
	return out
}

func TestReferencedStepIDs_SingleRef(t *testing.T) {
	got := referencedStepIDs(`steps.build.outputs.exit_code == '0'`)
	want := []string{"build"}
	if !reflect.DeepEqual(sortedStrings(got), want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestReferencedStepIDs_MultipleRefs(t *testing.T) {
	got := referencedStepIDs(`steps.a.outputs.success == 'true' && steps.b.outputs.exit_code == '0'`)
	want := []string{"a", "b"}
	if !reflect.DeepEqual(sortedStrings(got), want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestReferencedStepIDs_NoStepsRef(t *testing.T) {
	got := referencedStepIDs(`env.LOG_LEVEL == 'debug' && params.MODE == 'fast'`)
	if len(got) != 0 {
		t.Fatalf("got %v want empty", got)
	}
}

func TestReferencedStepIDs_EmptyExpr(t *testing.T) {
	got := referencedStepIDs("")
	if len(got) != 0 {
		t.Fatalf("got %v want empty", got)
	}
}

func TestReferencedStepIDs_SyntaxError_ReturnsNil(t *testing.T) {
	got := referencedStepIDs(`steps.build.outputs.`) // 语法不完整
	if len(got) != 0 {
		t.Fatalf("语法错误应返回空，got %v", got)
	}
}

func TestReferencedStepIDs_StringLiteralNotMatched(t *testing.T) {
	// 字符串常量里恰好包含 "steps.x.outputs" 文本，不应被误识别为引用
	got := referencedStepIDs(`env.MSG == 'steps.x.outputs'`)
	if len(got) != 0 {
		t.Fatalf("字符串常量不应被识别为引用，got %v", got)
	}
}
```

- [ ] **Step 2: 运行测试验证失败**

Run: `go test ./internal/workflow -run TestReferencedStepIDs -v`
Expected: FAIL，编译错误 `undefined: referencedStepIDs`

- [ ] **Step 3: 创建 `expr_refs.go`**

```go
// internal/workflow/expr_refs.go
package workflow

import (
	"github.com/expr-lang/expr/ast"
	"github.com/expr-lang/expr/parser"
)

// referencedStepIDs 解析 exprStr 的 AST，提取所有形如
// steps.<id>.outputs.<key> 的成员访问链中的 <id>。
// 解析失败（语法错误）时返回 nil——语法校验交给 EvalCondition 在运行时兜底，
// 此函数只负责"能解析时提取引用"，不重复做语法校验。
func referencedStepIDs(exprStr string) []string {
	if exprStr == "" {
		return nil
	}
	tree, err := parser.Parse(exprStr)
	if err != nil {
		return nil
	}
	var ids []string
	ast.Walk(&tree.Node, &stepRefVisitor{ids: &ids})
	return ids
}

// stepRefVisitor 在 AST 中查找 steps.<id>.outputs 形状的 MemberNode 链，
// 命中时把 <id> 追加进 ids。
type stepRefVisitor struct {
	ids *[]string
}

func (v *stepRefVisitor) Visit(node *ast.Node) {
	outer, ok := (*node).(*ast.MemberNode) // steps.<id>.outputs
	if !ok {
		return
	}
	outputsProp, ok := outer.Property.(*ast.StringNode)
	if !ok || outputsProp.Value != "outputs" {
		return
	}
	inner, ok := outer.Node.(*ast.MemberNode) // steps.<id>
	if !ok {
		return
	}
	idProp, ok := inner.Property.(*ast.StringNode)
	if !ok {
		return
	}
	base, ok := inner.Node.(*ast.IdentifierNode) // steps
	if !ok || base.Value != "steps" {
		return
	}
	*v.ids = append(*v.ids, idProp.Value)
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `go test ./internal/workflow -run TestReferencedStepIDs -v`
Expected: 全部 PASS（6 个测试）

- [ ] **Step 5: 提交**

```bash
git add internal/workflow/expr_refs.go internal/workflow/expr_refs_test.go
git commit -m "feat: referencedStepIDs 用 expr AST 提取 if 表达式引用的 step id"
```

---

### Task 7: `workflow.Validate` 接入静态校验

**Files:**
- Modify: `internal/workflow/schema.go`
- Modify: `internal/workflow/loader_test.go`

**Interfaces:**
- Consumes: `referencedStepIDs(exprStr string) []string`（Task 6）
- Produces: 无新增导出符号，`Validate` 函数行为增强（签名不变）

- [ ] **Step 1: 写失败测试**

```go
// internal/workflow/loader_test.go 追加
func TestValidate_IfReferencesUnknownStepID(t *testing.T) {
	def := &WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{ID: "build", Shell: "echo 1"},
			{Shell: "echo 2", If: `steps.notexist.outputs.success == 'true'`},
		},
	}
	if err := Validate(def); err == nil {
		t.Error("if 引用不存在的 step id 应报错")
	}
}

func TestValidate_IfReferencesForwardStepID(t *testing.T) {
	def := &WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{Shell: "echo 1", If: `steps.later.outputs.success == 'true'`},
			{ID: "later", Shell: "echo 2"},
		},
	}
	if err := Validate(def); err == nil {
		t.Error("if 引用尚未执行（后面才声明）的 step id 应报错")
	}
}

func TestValidate_IfReferencesValidPriorStepID(t *testing.T) {
	def := &WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{ID: "build", Shell: "echo 1"},
			{Shell: "echo 2", If: `steps.build.outputs.exit_code == '0'`},
		},
	}
	if err := Validate(def); err != nil {
		t.Errorf("if 引用前面已声明的 step id 应合法，got %v", err)
	}
}

func TestValidate_IfWithoutStepsRef_Unaffected(t *testing.T) {
	def := &WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{Shell: "echo 1", If: `env.LOG_LEVEL == 'debug'`},
		},
	}
	if err := Validate(def); err != nil {
		t.Errorf("if 只用 env/params 不应受影响，got %v", err)
	}
}

func TestValidate_IfSyntaxError_NotFalselyReportedAsUnknownRef(t *testing.T) {
	def := &WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{ID: "build", Shell: "echo 1"},
			{Shell: "echo 2", If: `steps.build.outputs.`}, // 语法错误
		},
	}
	// referencedStepIDs 对语法错误返回 nil，Validate 本次不新增 if 语法预检，
	// 因此这里应该"不因引用校验报错"（语法错误由运行时 EvalCondition 兜底）。
	if err := Validate(def); err != nil {
		t.Errorf("语法错误的 if 不应在引用校验阶段报错，got %v", err)
	}
}
```

- [ ] **Step 2: 运行测试验证失败**

Run: `go test ./internal/workflow -run TestValidate_If -v`
Expected: `TestValidate_IfReferencesUnknownStepID` 和 `TestValidate_IfReferencesForwardStepID` FAIL（当前 `Validate` 不做此检查，不会报错）；其余 3 个 PASS（因为当前逻辑本来就不报错）

- [ ] **Step 3: 修改 `schema.go` 的 `Validate` 函数**

在现有 `for i, s := range def.Steps` 循环里，`if s.ID != "" { ... }` 校验块之后，追加 if 引用校验（注意：必须放在 `seenStepID[s.ID] = i` 赋值**之后**才能保证"只能引用前面的 step"，因为当前 step 自己的 id 此刻已经写入 map，需要用引用校验时排除自引用场景——实际上自引用 `steps.<自己id>.outputs` 在自己执行完之前也是不存在的，所以也应该报错，天然被现有循序处理覆盖，不需要特殊排除）：

```go
// internal/workflow/schema.go 的 Validate 函数内，
// 在 "if s.ID != "" { ... seenStepID[s.ID] = i }" 代码块之后追加：
if s.If != "" {
    for _, refID := range referencedStepIDs(s.If) {
        if _, ok := seenStepID[refID]; !ok {
            return fmt.Errorf("steps[%d].if 引用了不存在或尚未执行的 step id %q", i, refID)
        }
    }
}
```

完整上下文（`Validate` 函数内 for 循环部分，供对照）：

```go
	seenStepID := map[string]int{}
	for i, s := range def.Steps {
		count := 0
		if s.Action != "" {
			count++
		}
		if s.Sleep > 0 {
			count++
		}
		if s.Shell != "" {
			count++
		}
		if count == 0 {
			return fmt.Errorf("steps[%d]: 必须指定 action、sleep 或 shell 之一", i)
		}
		if count > 1 {
			return fmt.Errorf("steps[%d]: action、sleep、shell 三者互斥", i)
		}
		if s.ID != "" {
			if !idPattern.MatchString(s.ID) {
				return fmt.Errorf("steps[%d].id 必须匹配 ^[a-z0-9-]+$，got %q", i, s.ID)
			}
			if prev, ok := seenStepID[s.ID]; ok {
				return fmt.Errorf("steps[%d].id 重复（与 steps[%d] 冲突）: %q", i, prev, s.ID)
			}
			seenStepID[s.ID] = i
		}
		if s.If != "" {
			for _, refID := range referencedStepIDs(s.If) {
				if _, ok := seenStepID[refID]; !ok {
					return fmt.Errorf("steps[%d].if 引用了不存在或尚未执行的 step id %q", i, refID)
				}
			}
		}
	}
	return nil
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `go test ./internal/workflow -run TestValidate_If -v`
Expected: 全部 PASS（5 个测试）

- [ ] **Step 5: 运行 workflow 包完整测试确认无回归**

Run: `go test ./internal/workflow -v`
Expected: 全部 PASS，包括既有的 `TestValidate_*`/`TestLoad_*`/`TestEvalCondition_*`/`TestSubstitute_*`

- [ ] **Step 6: 检查 demo-if-outputs 示例 workflow 仍能通过新校验**

Run: `grep -rl "if:" workflows/*.yaml 2>/dev/null`

对每个命中文件，确认其 `if` 引用的 step id 都在前面声明过（阅读 YAML 内容核对）。若发现现有 demo workflow 因新校验报错，修正该 YAML 文件的 step 顺序或 id（这属于示例数据订正，不是校验逻辑的 bug）。

Run: `go build -o /tmp/wf-check . && echo OK`（确认整体编译通过，模拟应用会在启动时加载 workflows 目录做校验）

- [ ] **Step 7: 提交**

```bash
git add internal/workflow/schema.go internal/workflow/loader_test.go
git commit -m "fix: Validate 静态校验 if 引用的 step id，缺失/前向引用改为加载期报错（缺口1修复）"
```

---

### Task 8: 文档同步

**Files:**
- Modify: `docs/action.md`
- Modify: `docs/workflow.md`

**Interfaces:** 无代码接口，纯文档。

- [ ] **Step 1: 读取 `docs/action.md` 中 `stream` 字段的现有描述**

Run: `grep -n "stream" docs/action.md`

- [ ] **Step 2: 更新 `docs/action.md` 的 `stream` 字段说明**

找到 `stream` 字段的描述段落，补充一句说明其消费方变化：`stream: "llm"` 现在由 api 层选择使用 `LLMRunner` 执行（而非 `ShellRunner` 内部按 `Stream` 字段分支处理），字段本身的 YAML 语义（`""` 或 `"llm"`）不变，向后兼容不受影响。

- [ ] **Step 3: 读取 `docs/workflow.md` 中 `if` 字段的现有描述**

Run: `grep -n "^.*if.*字段\|if:" docs/workflow.md | head -20`

- [ ] **Step 4: 更新 `docs/workflow.md` 的 `if` 字段说明**

在 `if` 字段描述附近补充一段：

> `if` 表达式若引用了不存在的 step id，或引用了排在当前 step **后面**才声明的 step id（前向引用），会在 workflow 加载时报错（而非等到运行时才失败）。只能引用当前 step 之前已声明并即将/已经执行过的 step id。

- [ ] **Step 5: 提交**

```bash
git add docs/action.md docs/workflow.md
git commit -m "docs: 同步 stream/if 字段说明 — LLMRunner 分发 + if 引用静态校验"
```

---

## Self-Review Notes（供实施者参考，非待执行步骤）

- **Spec 覆盖**：缺口1（Task 6/7）、缺口2（Task 2/3）、缺口3（Task 1/3/4/5）均有对应任务。文档同步（Task 8）覆盖 spec §4 的 docs 改动范围。
- **类型一致性**：`ExecRequest`/`ExecOutcome`/`OnLine`（Task 1）→ `ShellRunner`/`LLMRunner` 消费（Task 3/4）→ 字段名一致（`ExitCode`/`Err`/`Duration`）。`capBuffer`/`newCapBuffer`/`WriteLine`/`String`（Task 2）→ `ShellRunner` 消费（Task 3），命名一致。`referencedStepIDs`（Task 6）→ `Validate` 消费（Task 7），签名一致。
- **已知的任务间临时状态**：Task 3 会让 `stream: llm` action 短暂退化为普通 shell 输出（原始 JSON 行会被 emit 成 stdout），这是**有意为之**的最小可编译中间态，Task 5 修复。若中途暂停（例如只做到 Task 3 就要发布），必须连带完成 Task 4/5 才能发布，不能停在 Task 3。建议按 subagent-driven-development 或 executing-plans 连续执行 Task 1→7，Task 8 可稍后补。

