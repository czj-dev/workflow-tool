# Workflow 条件步骤（if）+ Runner 拆分 实现计划

> ⚠️ **存档计划 — 基于过时代码，已被 main 取代，请勿执行**
>
> 本计划基于 `feat/workflow-action-unify` 旧代码（Result 无 Stdout、executor 纯线性、schema 无 if）设计。`main` 已用 expr-lang/expr + capture_output 实现了条件步骤——**Phase 2（Task 4-6）全部重复且表达式引擎方案冲突**（手写 vs expr-lang）。Phase 1（exec.go 拆分 / LLMRunner 独立）main 未做，但动机已变（stdout 已由 capture_output 提供），若实施需基于 main 最新代码重写。本文件仅作方案对比存档。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 workflow step 加 `if` 条件守卫（可引用前序 step 的成败状态与 stdout 内容），前置重构 runner——抽通用进程编排、让 `Result` 带回 stdout、把 LLM 抽成独立 Runner——使 `if` 有数据可依。

**Architecture:** 三层重构 + 一层特性。Phase 1 把 `ShellRunner.Run` 里的"起进程/切行/超时/杀组"抽到纯函数 `exec.Run`（按 `\r`/`\n` 双切修 adb 进度丢失），`Result` 扩 `Stdout`/`Stderr`，LLM 从 `ShellRunner` 的 `stream=="llm"` 分支独立为平级 `LLMRunner`。Phase 2 给 `workflow.Step` 加 `ID`/`If`，executor 维护 `map[id]stepOutcome`，手写零依赖表达式引擎（`success`/`failure`/`outputs.<id>.* contains|matches|==`/`and|or|not`）求值 `if` 决定执行或 emit `step-skip`。Phase 3 前端展示跳过态 + docs 同步。`Runner.Run` 接口签名全程不动。

**Tech Stack:** Go 1.x（标准库 `os/exec`/`bufio`/`regexp`/`strconv`，零新依赖）、Wails v3 alpha2.119、React 19 + TypeScript + vitest、YAML。

## Global Constraints

> 以下为项目级红线（来自 CLAUDE.md 与 spec），每个 task 的需求都隐含包含这些约束。

- **`Runner.Run(ctx, params, emit) Result` 接口签名稳定不变**——只扩 `Result` 字段，绝不改方法签名。
- **Wails 锁定 `v3.0.0-alpha2.119`**（CLI 与库同版本），**禁止升到 alpha.3**（绑定机制损坏）。
- **改 `internal/api/api.go` 的 Service 方法签名/类型后**，必须按序 `wails3 generate bindings` → `npm run build`（前端）→ `go build`，否则前端报 "method ID not found"。
- **构建顺序不能乱**：前端 `dist/` embed 进二进制，binding 由 api.go 生成；统一用 `bash deploy/build.sh` 或分步 `deploy/frontend.sh` → `wails3 generate bindings` → `deploy/backend.sh`。
- **Windows 构建** `-ldflags "-H windowsgui"`（隐藏控制台）；调试时去掉该 flag 才能看到 `log`/`fmt` 输出。
- **前端静态文案只改** `frontend/src/i18n/locales/{zh,en}.json`；动作 title/description 与后端 stdout/stderr 不参与 i18n。
- **vitest 必须 `cd frontend` 跑**（cwd 在项目根会读不到 config → node 环境 → i18n localStorage 崩）。
- **多步构建每条 Bash 命令显式 `cd` 绝对路径**；exe 占用先 `taskkill /F /IM workflow-tool.exe`（Windows）。
- **Go 测试**：`go test ./internal/runner ./internal/workflow ./internal/registry ./internal/api`；带竞态 `go test -race ./...`。
- **零新依赖**：表达式引擎手写，不引入 expr-lang 等第三方库。
- **stdout buffer 上限 256KB**（`256 * 1024` 字节），超出保留尾部。

---

## Scope 判断

spec 把"runner 拆分"与"workflow if"设计为一个整体（拆分的目的是为 `if` 提供 `Result.Stdout`）。两者目标耦合：runner 拆分单独无用户价值（没有 `if` 时 `Stdout` 无人读），故保持单一 plan，按 3 个 Phase 分隔。每个 task 仍独立可测试、可提交、可回滚。若只想先落地重构，执行 Phase 1（Task 1-3）即可得到一个零行为变化的可发布版本。

---

## File Structure

### 新建

| 文件 | 职责 |
|------|------|
| `internal/runner/exec.go` | 通用进程编排：`ExecRequest`/`ExecOutcome`/`Run`（pipe/start/wait/timeout/kill 进程组）+ `scanProgressLines`（`\r`/`\n` 双切） |
| `internal/runner/exec_test.go` | `scanProgressLines` 纯函数测试 + `Run` 跨平台冒烟（成功/超时） |
| `internal/runner/llm_runner.go` | `LLMRunner`：实现 `Runner`，复用 `ShellConfig`，`onLine` 调 `parseLLMLine`，`Stdout` 累积 assistant text |
| `internal/runner/llm_runner_test.go` | `LLMRunner` 集成测试（跨平台进程产出 stream-json → emit `llm` + `Stdout` 累积） |
| `internal/workflow/expr.go` | `if` 表达式：`stepOutcome` struct + `EvalExpr` + 手写 tokenizer/parser |
| `internal/workflow/expr_test.go` | 表达式各操作符 + 缺失引用默认 false + 语法错 |

### 修改

| 文件 | 改动 |
|------|------|
| `internal/runner/runner.go` | `Result` 加 `Stdout`/`Stderr` 字段 |
| `internal/runner/util.go` | 加 `capBuffer` helper |
| `internal/runner/shell_runner.go` | 改用 `exec.Run` + `onLine` 累积 stdout/stderr；**删 `cfg.Stream=="llm"` 分支**；`ShellConfig` 删 `Stream` 字段 |
| `internal/api/api.go` | `execute` + `makeActionRun` 两处按 `Command.Stream` 分发 `ShellRunner`/`LLMRunner`；`WorkflowStepInfo` 加 `ID`/`If`；`buildStepInfos` 填充 |
| `internal/workflow/schema.go` | `Step` 加 `ID`/`If`；`Validate` 加 step id 校验（pattern + 唯一）+ `if` dry-run 解析 |
| `internal/workflow/executor.go` | 维护 `outcomes`/`lastSuccess`；`If` 求值跳过 + emit `step-skip`；记录 step 结果进 outcomes |
| `internal/runner/shell_runner_test.go` | 加 `Result.Stdout` 累积断言 |
| `internal/workflow/executor_test.go` | 加 if 真假分支 / step-skip / outcomes 引用测试 |
| `internal/api/api_test.go` | `WorkflowStepInfo` 新字段断言 |
| `frontend/src/types/events.ts` | `OutputEventData.stream` 加 `"step-skip"`；`WorkflowStepState.status` 加 `"skipped"` |
| `frontend/src/context/ActionRunnerProvider.tsx` | `onOutput` 处理 `step-skip` 帧 |
| `frontend/src/components/WorkflowView.tsx` | 4 组 `Record<status,…>` + `STATUS_I18N` 补 `skipped`；Collapsible/exit 渲染兼容 |
| `frontend/src/context/ActionRunnerProvider.test.tsx` | 加 `step-skip` 协议帧测试 |
| `frontend/src/i18n/locales/{zh,en}.json` | 加 `workflow.stepSkipped` 文案 |
| `frontend/bindings/workflow-tool/internal/api/models.js` | 重生成（`WorkflowStepInfo` 加字段后） |
| `docs/workflow.md` | Step `id`/`if` 字段、表达式语法表、守卫模型、adb 示例 |
| `docs/action.md` | `stream` 语义更新（选 runner 类型）；LLM action `Result.Stdout` = assistant text |

**不动**：`Runner` 接口签名、`registry`/`expand.go`/`sleep_runner.go`/`llm.go`（`parseLLMLine`/`pumpLLM` 纯函数保留复用）、`hide_*`/`pgid_*` 平台文件、现有 action/workflow YAML（向后兼容）。

---

## Task 依赖图

```
T1 exec.go ──► T2 Result+ShellRunner改用exec ──► T3 LLMRunner+删stream+api分发
                                                         │
T4 expr.go(stepOutcome+EvalExpr) ──► T5 Step ID/If+Validate ──► T6 executor outcomes+if
                                                                       │
                                                                       ▼
                                                              T7 前端+bindings ──► T8 docs
```

线性无回头；每个 task 一次提交。

---

## Phase 1：Runner 拆分

### Task 1: 通用进程编排 `exec.go`

**Files:**
- Create: `internal/runner/exec.go`
- Create: `internal/runner/exec_test.go`

**Interfaces:**
- Consumes: 包内已有的 `hideWindow`/`setPgid`/`killGroup`（平台文件，零改动复用）
- Produces:
  - `type ExecRequest struct { Cmd *exec.Cmd; Timeout time.Duration }`
  - `type ExecOutcome struct { ExitCode int; Err error; Duration time.Duration }`
  - `func Run(ctx context.Context, req ExecRequest, onLine func(stream, line string)) ExecOutcome`
  - `func scanProgressLines(r io.Reader, onLine func(string))`（`\r`/`\n` 双切，纯函数）

- [ ] **Step 1: 写失败测试（`scanProgressLines` 纯函数 + `Run` 冒烟）**

```go
// internal/runner/exec_test.go
package runner

import (
	"bytes"
	"context"
	"io"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestScanProgressLines 双切 \r 与 \n：adb 进度用 \r 刷新，单按 \n 切会丢。
func TestScanProgressLines(t *testing.T) {
	var got []string
	scanProgressLines(strings.NewReader("a\nb\rc\r\nd"), func(line string) {
		got = append(got, line)
	})
	want := []string{"a", "b", "c", "d"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got[%d]=%q, want %q (all=%v)", i, got[i], want[i], got)
		}
	}
}

// TestScanProgressLinesEmpty 不 emit 空行（连续分隔符不产生空 token）。
func TestScanProgressLinesEmpty(t *testing.T) {
	var n int
	scanProgressLines(strings.NewReader("\n\r\r\n"), func(string) { n++ })
	if n != 0 {
		t.Fatalf("连续分隔符不应产生空 token，got %d 次", n)
	}
}

// TestScanProgressLinesReaderType 接受任意 io.Reader（用 bytes.Reader 验证）。
func TestScanProgressLinesReaderType(t *testing.T) {
	var got []string
	scanProgressLines(bytes.NewBufferString("x\ny"), func(s string) { got = append(got, s) })
	if len(got) != 2 || got[0] != "x" || got[1] != "y" {
		t.Fatalf("got %v", got)
	}
}

// echoCmd 跨平台构造一个输出 hi 的命令（Windows cmd echo 输出含 \r，顺带验证双切）。
func echoCmd() *exec.Cmd {
	if runtime.GOOS == "windows" {
		return exec.Command("cmd", "/c", "echo hi")
	}
	return exec.Command("sh", "-c", "echo hi")
}

// sleepCmd 跨平台构造一个长 sleep（用于超时测试）。
func sleepCmd() *exec.Cmd {
	if runtime.GOOS == "windows" {
		return exec.Command("powershell", "-NoProfile", "-Command", "Start-Sleep -Seconds 30")
	}
	return exec.Command("sh", "-c", "sleep 30")
}

func TestRunSuccessEmitsStdoutLine(t *testing.T) {
	var lines []string
	out := Run(context.Background(), ExecRequest{Cmd: echoCmd(), Timeout: 5 * time.Second}, func(stream, line string) {
		if stream == "stdout" {
			lines = append(lines, line)
		}
	})
	if out.Err != nil {
		t.Fatalf("err: %v", out.Err)
	}
	if out.ExitCode != 0 {
		t.Fatalf("exit=%d want 0", out.ExitCode)
	}
	found := false
	for _, l := range lines {
		if strings.TrimSpace(l) == "hi" {
			found = true
		}
	}
	if !found {
		t.Fatalf("未收到 stdout 行 hi，got=%v", lines)
	}
}

func TestRunTimeoutKillsAndReturnsErr(t *testing.T) {
	out := Run(context.Background(), ExecRequest{Cmd: sleepCmd(), Timeout: 100 * time.Millisecond}, func(string, string) {})
	if out.Err == nil {
		t.Fatalf("期望超时错误，got exit=%d", out.ExitCode)
	}
	if out.ExitCode != -1 {
		t.Fatalf("超时期望 exit -1，got %d", out.ExitCode)
	}
}

// 确保用到 io（scanProgressLines 签名），避免未使用导入在部分构建时报错。
var _ = io.EOF
```

- [ ] **Step 2: 运行测试，确认失败（函数未定义）**

Run: `cd c:/Users/ASUS/Documents/workflow-tool && go test ./internal/runner -run TestScanProgressLines -v`
Expected: FAIL — `undefined: scanProgressLines` / `undefined: Run` / `undefined: ExecRequest`。

- [ ] **Step 3: 实现 `exec.go`**

```go
// internal/runner/exec.go
package runner

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os/exec"
	"time"
)

// ExecRequest 进程执行入参。
type ExecRequest struct {
	Cmd     *exec.Cmd
	Timeout time.Duration
}

// ExecOutcome 进程执行产物（不含 stdout——由调用方在 onLine 里累积，
// 因为 Shell 与 LLM 对"什么是有用输出"定义不同）。
type ExecOutcome struct {
	ExitCode int
	Err      error
	Duration time.Duration
}

// Run 起进程，stdout/stderr 按 \n/\r 双切逐行回调 onLine；超时杀进程组。
// cmd.Dir / cmd.Env 由调用方在传入前设置；hideWindow/setPgid 在此设置。
func Run(ctx context.Context, req ExecRequest, onLine func(stream, line string)) ExecOutcome {
	start := time.Now()
	timeoutCtx, cancel := context.WithTimeout(ctx, req.Timeout)
	defer cancel()

	cmd := req.Cmd
	hideWindow(cmd) // Windows 隐藏子进程控制台；非 Windows 空操作
	setPgid(cmd)    // Unix 新进程组，cancel 杀整组；Windows 空操作

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return ExecOutcome{Err: fmt.Errorf("stdout pipe: %w", err), Duration: time.Since(start)}
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return ExecOutcome{Err: fmt.Errorf("stderr pipe: %w", err), Duration: time.Since(start)}
	}

	if err := cmd.Start(); err != nil {
		return ExecOutcome{Err: fmt.Errorf("start: %w", err), Duration: time.Since(start)}
	}

	doneOut := make(chan struct{})
	doneErr := make(chan struct{})
	go func() {
		scanProgressLines(stdoutPipe, func(line string) { onLine("stdout", line) })
		close(doneOut)
	}()
	go func() {
		scanProgressLines(stderrPipe, func(line string) { onLine("stderr", line) })
		close(doneErr)
	}()

	waitCh := make(chan error, 1)
	go func() {
		<-doneOut
		<-doneErr
		waitCh <- cmd.Wait()
	}()

	select {
	case <-timeoutCtx.Done():
		killGroup(cmd) // 杀进程组而非单进程，否则 sh -c 的子进程（如 adb logcat）残留
		<-waitCh
		return ExecOutcome{ExitCode: -1, Err: timeoutCtx.Err(), Duration: time.Since(start)}
	case werr := <-waitCh:
		exitCode := 0
		if werr != nil {
			if ee, ok := werr.(*exec.ExitError); ok {
				exitCode = ee.ExitCode()
			} else {
				return ExecOutcome{Err: fmt.Errorf("wait: %w", werr), Duration: time.Since(start)}
			}
		}
		return ExecOutcome{ExitCode: exitCode, Duration: time.Since(start)}
	}
}

// scanProgressLines 把带 \r 与 \n 的流切成逐行 token，\r 与 \n 都作为分隔符
// （adb push/install 进度用 \r 刷新，单按 \n 切会丢进度）。连续分隔符不产生空 token。
func scanProgressLines(r io.Reader, onLine func(string)) {
	br := bufio.NewReader(r)
	var line []byte
	flush := func() {
		if len(line) > 0 {
			onLine(string(line))
			line = line[:0]
		}
	}
	for {
		b, err := br.ReadByte()
		if err != nil {
			flush()
			return
		}
		if b == '\n' || b == '\r' {
			flush()
		} else {
			line = append(line, b)
		}
	}
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd c:/Users/ASUS/Documents/workflow-tool && go test ./internal/runner -run "TestScanProgressLines|TestRun" -v`
Expected: PASS（全部 5 个测试）。

- [ ] **Step 5: 提交**

```bash
cd c:/Users/ASUS/Documents/workflow-tool
git add internal/runner/exec.go internal/runner/exec_test.go
git commit -m "refactor(runner): 抽通用进程编排 exec.Run + scanProgressLines 双切

- 从 ShellRunner 抽出 pipe/start/wait/timeout/kill 进程组为 exec.Run
- scanProgressLines 按 \\r/\\n 双切，修复 adb push/install 进度丢失
- ExecOutcome 不含 stdout，由调用方在 onLine 累积（Shell/LLM 语义不同）
- 暂未被引用，独立可测；Task 2 起 ShellRunner 改用它"
```

---

### Task 2: `Result` 扩字段 + `ShellRunner` 改用 `exec.Run`（保留 stream 分支，零行为变化）

**Files:**
- Modify: `internal/runner/runner.go`（`Result` 加字段）
- Modify: `internal/runner/util.go`（加 `capBuffer`）
- Modify: `internal/runner/shell_runner.go`（改用 `Run`，`onLine` 累积 + emit，保留 stream 分支）
- Modify: `internal/runner/shell_runner_test.go`（加 `Stdout` 累积断言）

**Interfaces:**
- Consumes: Task 1 的 `Run`/`ExecRequest`/`ExecOutcome`
- Produces:
  - `type Result struct { ExitCode int; Stdout string; Stderr string; Err error; Duration time.Duration }`
  - `func capBuffer(buf *string, s string, max int)`
  - `const maxBufferBytes = 256 * 1024`
  - `ShellRunner.Run` 行为：stdout/stderr 经 `stripANSI` emit 且累积进 `Result.Stdout`/`Stderr`（带 256KB 尾部截断）；`cfg.Stream=="llm"` 分支**临时保留**（仍走 `parseLLMLine`，不累积），Task 3 删除。

- [ ] **Step 1: 写失败测试（Result.Stdout 累积 + capBuffer）**

在 `internal/runner/shell_runner_test.go` 末尾追加：

```go
// TestShellRunnerCapturesStdout 验证 stdout 行累积进 Result.Stdout（跨平台 echo）。
func TestShellRunnerCapturesStdout(t *testing.T) {
	r := &ShellRunner{Cfg: ShellConfig{Shell: "echo hello-world", Timeout: 5 * time.Second}}
	res := r.Run(context.Background(), nil, func(string, string) {})
	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if !strings.Contains(res.Stdout, "hello-world") {
		t.Fatalf("Result.Stdout 应累积 hello-world，got %q", res.Stdout)
	}
}

// TestShellRunnerCapturesStderr 验证 stderr 累积进 Result.Stderr。
func TestShellRunnerCapturesStderr(t *testing.T) {
	r := &ShellRunner{Cfg: ShellConfig{Shell: "sh -c 'echo boom >&2'", Timeout: 5 * time.Second}}
	if runtime.GOOS == "windows" {
		r.Cfg.Shell = `powershell -NoProfile -Command "Write-Error boom"`
	}
	res := r.Run(context.Background(), nil, func(string, string) {})
	if !strings.Contains(res.Stderr, "boom") {
		t.Fatalf("Result.Stderr 应累积 boom，got %q", res.Stderr)
	}
}
```

在 `internal/runner/util.go` 测试（新建 `internal/runner/util_test.go`）：

```go
// internal/runner/util_test.go
package runner

import (
	"strings"
	"testing"
)

func TestCapBufferUnderLimit(t *testing.T) {
	var buf string
	capBuffer(&buf, "abc", 100)
	capBuffer(&buf, "def", 100)
	if buf != "abcdef" {
		t.Fatalf("got %q want abcdef", buf)
	}
}

func TestCapBufferTruncatesToTail(t *testing.T) {
	var buf string
	capBuffer(&buf, strings.Repeat("x", 300), 100)         // 超 256KB 的微缩版
	if len(buf) != 100 {
		t.Fatalf("应截到 max，got len=%d", len(buf))
	}
	if buf != strings.Repeat("x", 100) {
		t.Fatalf("应保留尾部 100 个 x")
	}
	// 追加后仍不超过 max
	capBuffer(&buf, "yy", 100)
	if len(buf) != 100 || !strings.HasSuffix(buf, "yy") {
		t.Fatalf("追加后应仍截到 max 且含尾部 yy，got len=%d", len(buf))
	}
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd c:/Users/ASUS/Documents/workflow-tool && go test ./internal/runner -run "TestShellRunnerCaptures|TestCapBuffer" -v`
Expected: FAIL — `res.Stdout undefined`（字段未加）/ `undefined: capBuffer`。

- [ ] **Step 3: 改 `runner.go` 加 `Result` 字段**

把 [internal/runner/runner.go:12-16](internal/runner/runner.go#L12) 的 `Result` 替换为：

```go
// Result 是一次执行的产物。
type Result struct {
	ExitCode int
	Stdout   string // 新增：累积的 stdout（LLMRunner 为 assistant text）
	Stderr   string // 新增：累积的 stderr
	Err      error
	Duration time.Duration
}
```

- [ ] **Step 4: 改 `util.go` 加 `capBuffer` 与上限常量**

在 `internal/runner/util.go` 末尾追加：

```go
// maxBufferBytes 是 Result.Stdout/Stderr 累积的软上限（保留尾部），防 adb logcat 这类无限流撑爆内存。
const maxBufferBytes = 256 * 1024

// capBuffer 把 s 追加到 *buf，超过 max 则只保留尾部 max 字节。
func capBuffer(buf *string, s string, max int) {
	*buf += s
	if len(*buf) > max {
		*buf = (*buf)[len(*buf)-max:]
	}
}
```

- [ ] **Step 5: 改 `shell_runner.go` 的 `Run`，改用 `exec.Run` + onLine 累积（保留 stream 分支）**

把 [internal/runner/shell_runner.go:31-100](internal/runner/shell_runner.go#L31) 整个 `Run` 方法替换为：

```go
// Run 执行配置的命令，通过 emit 流式推送输出，并累积 stdout/stderr 进 Result。
func (r *ShellRunner) Run(ctx context.Context, params map[string]any, emit EmitFunc) Result {
	cfg := r.Cfg
	cfg.Shell = Expand(cfg.Shell, params)
	cfg.Script = Expand(cfg.Script, params)
	cfg.Cwd = Expand(cfg.Cwd, params)
	cfg.Env = ExpandMap(cfg.Env, params)

	cmd, err := buildCommandFromCfg(cfg)
	if err != nil {
		return Result{Err: err}
	}
	if cfg.Cwd != "" {
		cmd.Dir = cfg.Cwd
	}
	cmd.Env = buildEnv(params, cfg.Env)

	var stdoutBuf, stderrBuf string
	onLine := func(stream, line string) {
		// LLM 分支（Task 3 将移除）：stream-json 行解析为 llm/llm-thinking，不累积 Result
		if cfg.Stream == "llm" && stream == "stdout" {
			kind, delta, ok := parseLLMLine(line)
			if !ok {
				return
			}
			if kind == "thinking" {
				emit("llm-thinking", delta)
			} else {
				emit("llm", delta)
			}
			return
		}
		stripped := stripANSI(line)
		emit(stream, stripped)
		if stream == "stdout" {
			capBuffer(&stdoutBuf, stripped, maxBufferBytes)
		} else {
			capBuffer(&stderrBuf, stripped, maxBufferBytes)
		}
	}

	out := Run(ctx, ExecRequest{Cmd: cmd, Timeout: cfg.Timeout}, onLine)
	return Result{
		ExitCode: out.ExitCode,
		Stdout:   stdoutBuf,
		Stderr:   stderrBuf,
		Err:      out.Err,
		Duration: out.Duration,
	}
}
```

> 超时与计时由 `exec.Run` 内部用 `ExecRequest.Timeout`（= `cfg.Timeout`）处理，并监听外部 `ctx` 的取消（`CancelAction` 会传播到 `exec.Run` 内部的 `WithTimeout(ctx, ...)` 触发 kill 进程组）。故 `ShellRunner.Run` 不再自建 `timeoutCtx`/`start`，避免重复；`Duration` 直接取 `ExecOutcome.Duration`。

- [ ] **Step 6: 删除 `shell_runner.go` 中不再使用的 `pump` 函数**

`pump`（原 150-158 行）已无调用方（被 `scanProgressLines` 取代）。删除整个 `pump` 函数。删除后 import 清理：`bufio`/`io` 因 `pump` 被删而不再使用；又因 `Run` 不再调用 `time.Now()`/`context.WithTimeout`（超时与计时移入 `exec.Run`），`time` 也变为未使用。移除 shell_runner.go 顶部 `"bufio"`、`"io"`、`"time"` 三个 import（保留 `context`/`fmt`/`os`/`os/exec`/`runtime`）。

```go
// 删除整段（原 internal/runner/shell_runner.go:150-158）：
// func pump(r io.Reader, stream string, emit EmitFunc, done chan<- struct{}) { ... }
```

检查 import：删除 `pump` 后 `bufio` 不再被 shell_runner.go 使用（`scanProgressLines` 在 exec.go 用 bufio）。`io` 同理。移除 shell_runner.go 顶部 `"bufio"` 和 `"io"` import（保留 `os/exec` 等）。

- [ ] **Step 7: 运行全部 runner 测试，确认通过（含回归）**

Run: `cd c:/Users/ASUS/Documents/workflow-tool && go test ./internal/runner -v`
Expected: PASS——包括原有 `TestShellRunner_*`（行为不变）+ 新增 `TestShellRunnerCaptures*` + `TestCapBuffer*` + Task 1 的 exec 测试。

> 原有 `TestShellRunner_Timeout`/`TestShellRunner_Cancel`（skipWindows）应仍绿：超时现在由 `exec.Run` 内部 kill 进程组返回 `Err`。若某个原测试因超时路径变化失败，检查 `res.Err` 是否仍非 nil（测试只断言 `res.Err == nil` 为失败）。

- [ ] **Step 8: 运行全后端回归**

Run: `cd c:/Users/ASUS/Documents/workflow-tool && go test ./internal/...`
Expected: PASS（registry/workflow/api 未受影响——它们只读 `Result.ExitCode`）。

- [ ] **Step 9: 提交**

```bash
cd c:/Users/ASUS/Documents/workflow-tool
git add internal/runner/runner.go internal/runner/util.go internal/runner/util_test.go internal/runner/shell_runner.go internal/runner/shell_runner_test.go
git commit -m "refactor(runner): ShellRunner 改用 exec.Run + Result 带 Stdout/Stderr

- Result 加 Stdout/Stderr 字段（接口签名不动）
- ShellRunner.Run 改用 exec.Run，onLine 经 stripANSI emit 且累积进 Result
- capBuffer 256KB 尾部截断防爆（util.go）
- 删除被 scanProgressLines 取代的 pump
- stream==llm 分支临时保留（Task 3 移除），行为零变化"
```

---

### Task 3: `LLMRunner` + 删 stream 分支 + `ShellConfig` 删 Stream + api 分发

**Files:**
- Create: `internal/runner/llm_runner.go`
- Create: `internal/runner/llm_runner_test.go`
- Modify: `internal/runner/shell_runner.go`（删 stream 分支 + `ShellConfig` 删 `Stream` 字段）
- Modify: `internal/api/api.go`（`execute` + `makeActionRun` 按 `Command.Stream` 分发）

**Interfaces:**
- Consumes: Task 1 `Run`/`ExecRequest`；Task 2 `Result.Stdout`/`capBuffer`；`parseLLMLine`（llm.go 不动）；`buildCommandFromCfg`/`buildEnv`/`Expand`（shell_runner.go 不动）
- Produces:
  - `type LLMRunner struct { Cfg ShellConfig }` + `func (r *LLMRunner) Run(ctx, params, emit) Result`（实现 `Runner`）
  - `ShellConfig` 不再含 `Stream` 字段
  - api 层 runner 分发约定：`Command.Stream == "llm"` → `LLMRunner`，否则 `ShellRunner`

- [ ] **Step 1: 写失败测试（LLMRunner）**

```go
// internal/runner/llm_runner_test.go
package runner

import (
	"context"
	"runtime"
	"strings"
	"testing"
	"time"
)

// streamJSONCmd 跨平台构造一个输出固定 claude stream-json 行的命令。
func streamJSONCmd() (shellCfg string) {
	textEvent := `{"type":"assistant","message":{"content":[{"type":"text","text":"是的"}]}}`
	thinkEvent := `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"想想"}]}}`
	garbage := `not-json`
	if runtime.GOOS == "windows" {
		// PowerShell：逐行 Write-Output（单引号包裹 JSON，内部双引号原样）
		return "Write-Output '" + textEvent + "'; Write-Output '" + thinkEvent + "'; Write-Output '" + garbage + "'"
	}
	return "printf '%s\\n' '" + textEvent + "' '" + thinkEvent + "' '" + garbage + "'"
}

// TestLLMRunnerEmitsTextAndThinking 验证 stdout 的 stream-json 解析为 llm/llm-thinking emit。
func TestLLMRunnerEmitsTextAndThinking(t *testing.T) {
	var emits []string
	r := &LLMRunner{Cfg: ShellConfig{Shell: streamJSONCmd(), Timeout: 10 * time.Second}}
	r.Run(context.Background(), nil, func(stream, line string) {
		emits = append(emits, stream+":"+line)
	})
	joined := strings.Join(emits, "|")
	if !strings.Contains(joined, "llm:是的") {
		t.Fatalf("应 emit llm:是的，got %v", emits)
	}
	if !strings.Contains(joined, "llm-thinking:想想") {
		t.Fatalf("应 emit llm-thinking:想想，got %v", emits)
	}
}

// TestLLMRunnerStdoutAccumulatesAssistantText 验证 Result.Stdout 累积 assistant text（不含 thinking/垃圾）。
func TestLLMRunnerStdoutAccumulatesAssistantText(t *testing.T) {
	r := &LLMRunner{Cfg: ShellConfig{Shell: streamJSONCmd(), Timeout: 10 * time.Second}}
	res := r.Run(context.Background(), nil, func(string, string) {})
	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if !strings.Contains(res.Stdout, "是的") {
		t.Fatalf("Result.Stdout 应累积 assistant text '是的'，got %q", res.Stdout)
	}
	if strings.Contains(res.Stdout, "想想") {
		t.Fatalf("Result.Stdout 不应含 thinking，got %q", res.Stdout)
	}
	if strings.Contains(res.Stdout, "not-json") {
		t.Fatalf("Result.Stdout 不应含无法解析的行，got %q", res.Stdout)
	}
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd c:/Users/ASUS/Documents/workflow-tool && go test ./internal/runner -run TestLLMRunner -v`
Expected: FAIL — `undefined: LLMRunner`。

- [ ] **Step 3: 实现 `llm_runner.go`**

```go
// internal/runner/llm_runner.go
package runner

import "context"

// LLMRunner 执行 claude 等 LLM CLI，解析 stream-json：assistant text 增量 emit 为 "llm"
// 且累积进 Result.Stdout；thinking emit 为 "llm-thinking"（不进 Result）；stderr 原样 emit。
// 复用 ShellConfig（命令构造与 ShellRunner 一致，claude CLI 也是 shell 命令）。
type LLMRunner struct {
	Cfg ShellConfig
}

// Run 执行配置的 LLM 命令。超时与计时由 exec.Run 处理。
func (r *LLMRunner) Run(ctx context.Context, params map[string]any, emit EmitFunc) Result {
	cfg := r.Cfg
	cfg.Shell = Expand(cfg.Shell, params)
	cfg.Script = Expand(cfg.Script, params)
	cfg.Cwd = Expand(cfg.Cwd, params)
	cfg.Env = ExpandMap(cfg.Env, params)

	cmd, err := buildCommandFromCfg(cfg)
	if err != nil {
		return Result{Err: err}
	}
	if cfg.Cwd != "" {
		cmd.Dir = cfg.Cwd
	}
	cmd.Env = buildEnv(params, cfg.Env)

	var stdoutBuf string
	onLine := func(stream, line string) {
		if stream == "stdout" {
			kind, delta, ok := parseLLMLine(line)
			if !ok {
				return // system/result/无法解析/tool_use：丢弃
			}
			if kind == "thinking" {
				emit("llm-thinking", delta) // 思考只展示，不进 Result
				return
			}
			emit("llm", delta)
			capBuffer(&stdoutBuf, delta, maxBufferBytes) // assistant text 累积，供 if 引用
			return
		}
		// stderr：claude 诊断原样推前端，不进 Result
		emit("stderr", stripANSI(line))
	}

	out := Run(ctx, ExecRequest{Cmd: cmd, Timeout: cfg.Timeout}, onLine)
	return Result{
		ExitCode: out.ExitCode,
		Stdout:   stdoutBuf,
		Err:      out.Err,
		Duration: out.Duration,
	}
}
```

- [ ] **Step 4: 运行 LLMRunner 测试，确认通过**

Run: `cd c:/Users/ASUS/Documents/workflow-tool && go test ./internal/runner -run TestLLMRunner -v`
Expected: PASS。

- [ ] **Step 5: 删除 `ShellRunner` 的 stream 分支 + `ShellConfig.Stream` 字段**

[internal/runner/shell_runner.go:14-23](internal/runner/shell_runner.go#L14) 的 `ShellConfig` 删除 `Stream` 字段：

```go
// ShellConfig 是已解析、待执行的命令配置。
type ShellConfig struct {
	Shell   string            // 内联命令（与 Script 二选一）
	Script  string            // 脚本路径不含扩展名（与 Shell 二选一）
	Cwd     string            // 工作目录（必须存在）
	Timeout time.Duration     // 超时
	Env     map[string]string // 额外环境变量
	BaseDir string            // exe 目录，用于解析相对 script 路径
}
```

`Run` 的 `onLine` 删除 stream 分支（Task 2 Step 5 的 `if cfg.Stream == "llm" && stream == "stdout" { ... }` 整块），变为：

```go
	onLine := func(stream, line string) {
		stripped := stripANSI(line)
		emit(stream, stripped)
		if stream == "stdout" {
			capBuffer(&stdoutBuf, stripped, maxBufferBytes)
		} else {
			capBuffer(&stderrBuf, stripped, maxBufferBytes)
		}
	}
```

- [ ] **Step 6: 改 `api.go` 两处分发**

[internal/api/api.go:371-381](internal/api/api.go#L371) 的 `execute` 构造点替换为：

```go
	shellCfg := runner.ShellConfig{
		Shell:   la.Def.Command.Shell,
		Script:  la.Def.Command.Script,
		Cwd:     la.Cwd, // raw，由 runner 用 params 替换
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
	s.emitDone(id, res.ExitCode, errStr(res.Err), res.Duration)
```

[internal/api/api.go:585-594](internal/api/api.go#L585) 的 `makeActionRun` 构造点替换为：

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
		return r.Run(ctx, runParams, stepEmit)
```

> `makeShellRun`（inline shell step）保持 `ShellRunner` 不变——inline shell 不支持 `stream: llm`（YAGNI）。

- [ ] **Step 7: 运行后端全量回归**

Run: `cd c:/Users/ASUS/Documents/workflow-tool && go test ./internal/...`
Expected: PASS。确认 `TestListActionsIncludesStream`（api_test.go）仍绿——它读 `ActionItem.Stream`（来自 `la.Def.Command.Stream`，registry 层 `CommandDef.Stream` 保留），与 `ShellConfig` 删字段无关。

- [ ] **Step 8: 提交**

```bash
cd c:/Users/ASUS/Documents/workflow-tool
git add internal/runner/llm_runner.go internal/runner/llm_runner_test.go internal/runner/shell_runner.go internal/api/api.go
git commit -m "refactor(runner): LLM 独立为 LLMRunner + api 按 stream 分发

- 新增 LLMRunner：onLine 调 parseLLMLine，assistant text emit('llm') 且累积进 Result.Stdout
- thinking/stderr 只 emit 不进 Result
- ShellRunner 删除 stream==llm 分支，不再感知 LLM
- ShellConfig 删除 Stream 字段（stream 升级为 api 层 runner 选择依据）
- execute/makeActionRun 按 Command.Stream 分发 Shell/LLMRunner
- 现有 stream:llm action 行为不变（emit 不变），新增 Result.Stdout 能力"
```

---

## Phase 2：Workflow `if` 条件

### Task 4: 表达式引擎 `expr.go`（`stepOutcome` + `EvalExpr`）

**Files:**
- Create: `internal/workflow/expr.go`
- Create: `internal/workflow/expr_test.go`

**Interfaces:**
- Consumes: 标准库 `strings`/`strconv`/`regexp`/`fmt`
- Produces:
  - `type stepOutcome struct { ExitCode int; Stdout string; Stderr string }`（执行期单步产物；executor 与 expr 共享）
  - `func EvalExpr(expr string, outcomes map[string]stepOutcome, lastSuccess bool) (bool, error)`——语法错返回 error；运行时缺失引用按 false 求值（不报错）

> **类型定义归属**：`stepOutcome` 定义在本文件顶部，因为 expr 是最早使用它的 task；Task 6 的 executor 直接引用此类型（同包）。

- [ ] **Step 1: 写失败测试（各操作符 + 缺失引用 + 语法错）**

```go
// internal/workflow/expr_test.go
package workflow

import "testing"

func TestEvalExprSuccessLast(t *testing.T) {
	ok, err := EvalExpr("success()", nil, true)
	if err != nil || !ok {
		t.Fatalf("success() with lastSuccess=true want true，got (%v,%v)", ok, err)
	}
}

func TestEvalExprFailureLast(t *testing.T) {
	ok, _ := EvalExpr("failure()", nil, false)
	if !ok {
		t.Fatal("failure() with lastSuccess=false want true")
	}
}

func TestEvalExprSuccessById(t *testing.T) {
	outcomes := map[string]stepOutcome{"a": {ExitCode: 0}}
	ok, _ := EvalExpr(`success("a")`, outcomes, false)
	if !ok {
		t.Fatal(`success("a") exit0 want true`)
	}
}

func TestEvalExprFailureById(t *testing.T) {
	outcomes := map[string]stepOutcome{"a": {ExitCode: 2}}
	ok, _ := EvalExpr(`failure("a")`, outcomes, true)
	if !ok {
		t.Fatal(`failure("a") exit2 want true`)
	}
}

func TestEvalExprStdoutContains(t *testing.T) {
	outcomes := map[string]stepOutcome{"mode": {Stdout: "device is fastboot"}}
	ok, _ := EvalExpr(`outputs.mode.stdout contains "fastboot"`, outcomes, true)
	if !ok {
		t.Fatal(`contains "fastboot" want true`)
	}
}

func TestEvalExprStdoutMatches(t *testing.T) {
	outcomes := map[string]stepOutcome{"ver": {Stdout: "version 1.23 done"}}
	ok, _ := EvalExpr(`outputs.ver.stdout matches /\d+\.\d+/`, outcomes, true)
	if !ok {
		t.Fatal(`matches /\d+\.\d+/ want true`)
	}
}

func TestEvalExprExitCodeEq(t *testing.T) {
	outcomes := map[string]stepOutcome{"chk": {ExitCode: 0}}
	ok, _ := EvalExpr(`outputs.chk.exit_code == 0`, outcomes, true)
	if !ok {
		t.Fatal(`exit_code == 0 want true`)
	}
}

func TestEvalExprExitCodeNe(t *testing.T) {
	outcomes := map[string]stepOutcome{"chk": {ExitCode: 1}}
	ok, _ := EvalExpr(`outputs.chk.exit_code != 0`, outcomes, true)
	if !ok {
		t.Fatal(`exit_code != 0 want true`)
	}
}

func TestEvalExprAndOrNot(t *testing.T) {
	outcomes := map[string]stepOutcome{"a": {ExitCode: 0}, "b": {ExitCode: 1}}
	cases := []struct {
		expr string
		want bool
	}{
		{`success("a") and failure("b")`, true},
		{`success("a") and success("b")`, false},
		{`success("a") or success("b")`, true},
		{`not success("b")`, true},
		{`(success("a") or success("b")) and not failure("a")`, true},
	}
	for _, c := range cases {
		got, err := EvalExpr(c.expr, outcomes, true)
		if err != nil {
			t.Fatalf("%q 报错: %v", c.expr, err)
		}
		if got != c.want {
			t.Errorf("%q want %v got %v", c.expr, c.want, got)
		}
	}
}

// TestEvalExprMissingRefDefaultsFalse 缺失引用安全默认 false（组合偏向"不执行"）。
func TestEvalExprMissingRefDefaultsFalse(t *testing.T) {
	cases := []string{
		`success("nope")`,
		`outputs.nope.stdout contains "x"`,
		`outputs.nope.exit_code == 0`,
	}
	for _, expr := range cases {
		ok, err := EvalExpr(expr, map[string]stepOutcome{}, true)
		if err != nil {
			t.Fatalf("%q 不应报错: %v", expr, err)
		}
		if ok {
			t.Errorf("%q 缺失引用应 false", expr)
		}
	}
}

// TestEvalExprSyntaxErrors 语法错返回 error。
func TestEvalExprSyntaxErrors(t *testing.T) {
	bad := []string{
		``,                       // 空
		`success(`,               // 未闭合括号
		`outputs.mode.stdout`,    // 缺操作符
		`outputs.mode contains`,  // 缺右操作数
		`a and`,                  // 缺右表达式
		`outputs.mode.stdout contains "x`, // 未闭合字符串
		`foo()`,                  // 非法函数
	}
	for _, expr := range bad {
		if _, err := EvalExpr(expr, map[string]stepOutcome{}, true); err == nil {
			t.Errorf("%q 应报语法错", expr)
		}
	}
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd c:/Users/ASUS/Documents/workflow-tool && go test ./internal/workflow -run TestEvalExpr -v`
Expected: FAIL — `undefined: EvalExpr` / `undefined: stepOutcome`。

- [ ] **Step 3: 实现 `expr.go`**

```go
// internal/workflow/expr.go
package workflow

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// stepOutcome 是单个已执行 step 的产物，供后续 step 的 if 表达式引用。
type stepOutcome struct {
	ExitCode int
	Stdout   string
	Stderr   string
}

// EvalExpr 在给定 outcomes 与 lastSuccess 下求值 workflow if 表达式。
//   - outcomes：已执行 step 的产物（key = step.ID）
//   - lastSuccess：紧邻上一个"已执行"step 是否成功（success()/failure() 无参时引用它）
// 语法错返回 error；运行时缺失引用按 false 求值（不报错），使组合默认偏向"不执行"。
func EvalExpr(expr string, outcomes map[string]stepOutcome, lastSuccess bool) (bool, error) {
	toks, err := tokenize(expr)
	if err != nil {
		return false, err
	}
	p := &parser{toks: toks, outcomes: outcomes, lastSuccess: lastSuccess}
	v, err := p.parseOr()
	if err != nil {
		return false, err
	}
	if p.peek().kind != tEOF {
		return false, fmt.Errorf("多余 token: %q", p.peek().val)
	}
	return v, nil
}

// --- tokenizer ---

type tokenKind int

const (
	tEOF tokenKind = iota
	tIdent  // success/failure/outputs/and/or/not/contains/matches 或 step id
	tString // "..."
	tRegex  // /.../
	tNumber // -?\d+
	tLParen // (
	tRParen // )
	tDot    // .
	tEq     // ==
	tNe     // !=
)

type token struct {
	kind tokenKind
	val  string
}

func isIdentStart(c byte) bool { return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }
func isIdentChar(c byte) bool {
	return isIdentStart(c) || (c >= '0' && c <= '9') || c == '-'
}

func tokenize(s string) ([]token, error) {
	var toks []token
	i := 0
	for i < len(s) {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '(':
			toks = append(toks, token{tLParen, "("})
			i++
		case c == ')':
			toks = append(toks, token{tRParen, ")"})
			i++
		case c == '.':
			toks = append(toks, token{tDot, "."})
			i++
		case c == '"':
			j := i + 1
			for j < len(s) && s[j] != '"' {
				j++
			}
			if j >= len(s) {
				return nil, fmt.Errorf("未闭合的字符串")
			}
			toks = append(toks, token{tString, s[i+1 : j]})
			i = j + 1
		case c == '/':
			j := i + 1
			for j < len(s) && s[j] != '/' {
				j++
			}
			if j >= len(s) {
				return nil, fmt.Errorf("未闭合的正则")
			}
			toks = append(toks, token{tRegex, s[i+1 : j]})
			i = j + 1
		case c == '=' && i+1 < len(s) && s[i+1] == '=':
			toks = append(toks, token{tEq, "=="})
			i += 2
		case c == '!' && i+1 < len(s) && s[i+1] == '=':
			toks = append(toks, token{tNe, "!="})
			i += 2
		case c == '-' || (c >= '0' && c <= '9'):
			j := i
			if c == '-' {
				j++
			}
			for j < len(s) && s[j] >= '0' && s[j] <= '9' {
				j++
			}
			toks = append(toks, token{tNumber, s[i:j]})
			i = j
		case isIdentStart(c):
			j := i
			for j < len(s) && isIdentChar(s[j]) {
				j++
			}
			toks = append(toks, token{tIdent, s[i:j]})
			i = j
		default:
			return nil, fmt.Errorf("非法字符 %q", c)
		}
	}
	return toks, nil
}

// --- parser（递归下降） ---

type parser struct {
	toks        []token
	pos         int
	outcomes    map[string]stepOutcome
	lastSuccess bool
}

func (p *parser) peek() token {
	if p.pos < len(p.toks) {
		return p.toks[p.pos]
	}
	return token{kind: tEOF}
}
func (p *parser) next() token { t := p.peek(); p.pos++; return t }
func (p *parser) isKeyword(v string) bool {
	t := p.peek()
	return t.kind == tIdent && t.val == v
}

// parseOr := parseAnd ("or" parseAnd)*
func (p *parser) parseOr() (bool, error) {
	v, err := p.parseAnd()
	if err != nil {
		return false, err
	}
	for p.isKeyword("or") {
		p.next()
		r, err := p.parseAnd()
		if err != nil {
			return false, err
		}
		v = v || r
	}
	return v, nil
}

// parseAnd := parseNot ("and" parseNot)*
func (p *parser) parseAnd() (bool, error) {
	v, err := p.parseNot()
	if err != nil {
		return false, err
	}
	for p.isKeyword("and") {
		p.next()
		r, err := p.parseNot()
		if err != nil {
			return false, err
		}
		v = v && r
	}
	return v, nil
}

// parseNot := "not" parseNot | parsePrimary
func (p *parser) parseNot() (bool, error) {
	if p.isKeyword("not") {
		p.next()
		v, err := p.parseNot()
		if err != nil {
			return false, err
		}
		return !v, nil
	}
	return p.parsePrimary()
}

// parsePrimary := "(" parseOr ")" | success/failure(...) | comparison
func (p *parser) parsePrimary() (bool, error) {
	t := p.peek()
	if t.kind == tLParen {
		p.next()
		v, err := p.parseOr()
		if err != nil {
			return false, err
		}
		if p.peek().kind != tRParen {
			return false, fmt.Errorf("缺少 )")
		}
		p.next()
		return v, nil
	}
	if t.kind == tIdent && (t.val == "success" || t.val == "failure") {
		return p.parseStatusFunc()
	}
	return p.parseComparison()
}

// parseStatusFunc := ("success"|"failure") [ "(" STRING? ")" ]
func (p *parser) parseStatusFunc() (bool, error) {
	name := p.next().val
	wantSuccess := name == "success"
	id := ""
	if p.peek().kind == tLParen {
		p.next()
		if p.peek().kind == tString {
			id = p.next().val
		}
		if p.peek().kind != tRParen {
			return false, fmt.Errorf("缺少 )")
		}
		p.next()
	}
	if id == "" {
		if wantSuccess {
			return p.lastSuccess, nil
		}
		return !p.lastSuccess, nil
	}
	oc, ok := p.outcomes[id]
	if !ok {
		return false, nil // 缺失 → false
	}
	succeeded := oc.ExitCode == 0
	if wantSuccess {
		return succeeded, nil
	}
	return !succeeded, nil
}

// parseComparison := ref op operand
func (p *parser) parseComparison() (bool, error) {
	r, err := p.parseRef()
	if err != nil {
		return false, err
	}
	op := p.peek()
	if !(op.kind == tIdent && (op.val == "contains" || op.val == "matches")) && op.kind != tEq && op.kind != tNe {
		return false, fmt.Errorf("期望操作符（contains/matches/==/!=），got %q", op.val)
	}
	p.next()
	right := p.peek()
	p.next()

	oc, ok := p.outcomes[r.id]
	switch r.field {
	case "exit_code":
		code := -1
		if ok {
			code = oc.ExitCode
		}
		if right.kind != tNumber {
			return false, fmt.Errorf("exit_code 比较右操作数须为数字")
		}
		n, err := strconv.Atoi(right.val)
		if err != nil {
			return false, fmt.Errorf("非法数字 %q", right.val)
		}
		if op.kind == tEq {
			return code == n, nil
		}
		return code != n, nil
	case "stdout", "stderr":
		s := ""
		if ok {
			if r.field == "stdout" {
				s = oc.Stdout
			} else {
				s = oc.Stderr
			}
		}
		switch {
		case op.kind == tIdent && op.val == "contains":
			if right.kind != tString {
				return false, fmt.Errorf("contains 右操作数须为 \"...\"")
			}
			return strings.Contains(s, right.val), nil
		case op.kind == tIdent && op.val == "matches":
			if right.kind != tRegex {
				return false, fmt.Errorf("matches 右操作数须为 /.../")
			}
			re, err := regexp.Compile(right.val)
			if err != nil {
				return false, fmt.Errorf("正则非法: %w", err)
			}
			return re.MatchString(s), nil
		case op.kind == tEq:
			if right.kind != tString {
				return false, fmt.Errorf("== 字符串比较右操作数须为 \"...\"")
			}
			return s == right.val, nil
		case op.kind == tNe:
			if right.kind != tString {
				return false, fmt.Errorf("!= 字符串比较右操作数须为 \"...\"")
			}
			return s != right.val, nil
		}
	}
	return false, fmt.Errorf("未知字段 %q", r.field)
}

// parseRef := "outputs" "." id "." ("stdout"|"stderr"|"exit_code")
type ref struct{ id, field string }

func (p *parser) parseRef() (ref, error) {
	if !p.isKeyword("outputs") {
		return ref{}, fmt.Errorf("左操作数须以 outputs. 开头")
	}
	p.next()
	if p.peek().kind != tDot {
		return ref{}, fmt.Errorf("outputs 后须有 .")
	}
	p.next()
	if p.peek().kind != tIdent {
		return ref{}, fmt.Errorf("缺少 step id")
	}
	id := p.next().val
	if p.peek().kind != tDot {
		return ref{}, fmt.Errorf("缺少字段（.stdout/.stderr/.exit_code）")
	}
	p.next()
	if p.peek().kind != tIdent {
		return ref{}, fmt.Errorf("缺少字段名")
	}
	field := p.next().val
	switch field {
	case "stdout", "stderr", "exit_code":
	default:
		return ref{}, fmt.Errorf("未知字段 %q（stdout/stderr/exit_code）", field)
	}
	return ref{id: id, field: field}, nil
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd c:/Users/ASUS/Documents/workflow-tool && go test ./internal/workflow -run TestEvalExpr -v`
Expected: PASS（全部测试）。

- [ ] **Step 5: 提交**

```bash
cd c:/Users/ASUS/Documents/workflow-tool
git add internal/workflow/expr.go internal/workflow/expr_test.go
git commit -m "feat(workflow): if 表达式引擎 expr.go（手写零依赖）

- stepOutcome struct + EvalExpr(expr, outcomes, lastSuccess)
- 文法：success()/success('id')/failure() | outputs.<id>.stdout contains|matches|==|!= | and/or/not/( )
- 操作数约束：左 outputs 引用，右字面量（字符串/正则/数字）
- 缺失引用按 false 求值（组合默认偏向不执行），语法错返回 error
- 零新依赖（仅 strings/strconv/regexp）"
```

---

### Task 5: `Step` 加 `ID`/`If` + `Validate`（id 校验 + if dry-run）

**Files:**
- Modify: `internal/workflow/schema.go`
- Modify: `internal/workflow/loader_test.go`（若涉及）或新建校验测试于 schema 侧——本 task 在 `executor_test.go` 之外，新增 `schema_test.go`

**Interfaces:**
- Consumes: Task 4 的 `EvalExpr`/`stepOutcome`
- Produces:
  - `Step` 新增字段 `ID string \`yaml:"id"\`` 与 `If string \`yaml:"if"\``
  - `Validate` 新增：`step.id` 非空时匹配 `^[a-z][a-z0-9_-]*$` 且 workflow 内唯一；`step.if` 非空时 dry-run 解析（语法错则报错）

- [ ] **Step 1: 写失败测试（校验规则）**

```go
// internal/workflow/schema_test.go
package workflow

import "testing"

func validDef(steps ...Step) *WorkflowDef {
	return &WorkflowDef{ID: "w", Title: "W", Steps: steps}
}

func TestValidateStepIdPattern(t *testing.T) {
	cases := map[string]bool{
		"mode":   true,
		"ask-1":  true,
		"my_id":  true,
		"Mode":   false, // 大写
		"1mode":  false, // 数字开头
		"":       true,  // 空 id 不校验（可选字段）
	}
	for id, wantOK := range cases {
		def := validDef(Step{Shell: "x", ID: id})
		err := Validate(def)
		if wantOK && err != nil {
			t.Errorf("id=%q 应通过，got err: %v", id, err)
		}
		if !wantOK && err == nil {
			t.Errorf("id=%q 应报错", id)
		}
	}
}

func TestValidateStepIdUnique(t *testing.T) {
	def := validDef(
		Step{Shell: "x", ID: "dup"},
		Step{Shell: "y", ID: "dup"},
	)
	if err := Validate(def); err == nil {
		t.Fatal("重复 step id 应报错")
	}
}

func TestValidateStepIfSyntax(t *testing.T) {
	// 合法 if
	if err := Validate(validDef(Step{Shell: "x", If: `outputs.m.stdout contains "y"`})); err != nil {
		t.Fatalf("合法 if 应通过: %v", err)
	}
	// 非法 if 语法 → 加载报错
	if err := Validate(validDef(Step{Shell: "x", If: `outputs.m contains`})); err == nil {
		t.Fatal("非法 if 语法应报错")
	}
}

func TestValidateStepIfAndIdCombo(t *testing.T) {
	// id + if 组合合法
	if err := Validate(validDef(
		Step{Shell: "echo a", ID: "m"},
		Step{Shell: "echo b", If: `success("m")`},
	)); err != nil {
		t.Fatalf("id+if 组合应通过: %v", err)
	}
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd c:/Users/ASUS/Documents/workflow-tool && go test ./internal/workflow -run TestValidate -v`
Expected: FAIL — `Step` 无 `ID`/`If` 字段（编译错 `unknown field ID`）。

- [ ] **Step 3: 改 `schema.go`——`Step` 加字段**

[internal/workflow/schema.go:30-38](internal/workflow/schema.go#L30) 的 `Step` 替换为：

```go
// Step 是 workflow 中的一步。action / sleep / shell 三者互斥。
type Step struct {
	ID              string            `yaml:"id"`            // 可选，供后续 step 的 if 引用其输出
	Action          string            `yaml:"action"`        // 引用已有 action id
	Params          map[string]string `yaml:"params"`        // 覆盖 action 的参数
	Sleep           int               `yaml:"sleep"`         // sleep N 秒
	Shell           string            `yaml:"shell"`         // 直接执行 shell 命令
	Timeout         string            `yaml:"timeout"`       // 仅 shell step 有效
	Retry           int               `yaml:"retry"`         // 可选重试次数
	ContinueOnError bool              `yaml:"continue_on_error"` // 失败时继续
	If              string            `yaml:"if"`            // 可选条件表达式，假则跳过
}
```

在 [internal/workflow/schema.go:11](internal/workflow/schema.go#L11) `idPattern` 旁加 step id pattern：

```go
var idPattern = regexp.MustCompile(`^[a-z0-9-]+$`)

// stepIDPattern：step 的 id（供 if 引用），允许下划线，首字母须小写字母。
var stepIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)
```

- [ ] **Step 4: 改 `schema.go`——`Validate` 加校验**

把 [internal/workflow/schema.go:68-85](internal/workflow/schema.go#L68) 的 steps 校验循环替换为：

```go
	seenIDs := map[string]bool{}
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
			if !stepIDPattern.MatchString(s.ID) {
				return fmt.Errorf("steps[%d]: id 须匹配 ^[a-z][a-z0-9_-]*$，got %q", i, s.ID)
			}
			if seenIDs[s.ID] {
				return fmt.Errorf("steps[%d]: 重复 step id %q", i, s.ID)
			}
			seenIDs[s.ID] = true
		}
		if s.If != "" {
			// dry-run 解析：空 outcomes + lastSuccess=true，仅验证语法（缺失引用不报错）
			if _, err := EvalExpr(s.If, map[string]stepOutcome{}, true); err != nil {
				return fmt.Errorf("steps[%d]: if 表达式非法: %w", i, err)
			}
		}
	}
	return nil
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd c:/Users/ASUS/Documents/workflow-tool && go test ./internal/workflow -v`
Expected: PASS——新 schema 测试 + 原有 executor/loader 测试（原测试不使用 ID/If，向后兼容）。

- [ ] **Step 6: 运行后端全量回归**

Run: `cd c:/Users/ASUS/Documents/workflow-tool && go test ./internal/...`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
cd c:/Users/ASUS/Documents/workflow-tool
git add internal/workflow/schema.go internal/workflow/schema_test.go
git commit -m "feat(workflow): Step 加 ID/If + Validate 校验

- Step 新增 id（供 if 引用输出）与 if（条件守卫）
- Validate：step.id 匹配 ^[a-z][a-z0-9_-]*\$ 且唯一；step.if dry-run 解析拦语法错
- 守卫模型：if 真→执行，假→跳过（Task 6 实现）"
```

---

### Task 6: executor 维护 outcomes + `if` 求值跳过 + `step-skip` 事件

**Files:**
- Modify: `internal/workflow/executor.go`
- Modify: `internal/workflow/executor_test.go`

**Interfaces:**
- Consumes: Task 4 `EvalExpr`/`stepOutcome`；Task 5 `Step.ID`/`Step.If`；Task 2/3 `runner.Result.Stdout`/`Stderr`（经 `actionRun`/`shellRun` 回调返回）
- Produces:
  - executor 执行期维护 `outcomes map[string]stepOutcome`（key=已执行 step 的 ID）与 `lastSuccess bool`（初值 true）
  - 每 step：`If` 非空时 `EvalExpr` 求值，假则 `emit("step-skip", "<i>")` + `continue`（不进 outcomes、不改 lastSuccess）
  - 已执行 step 若有 ID 则记入 outcomes；`lastSuccess = (ExitCode==0)`
  - 新增协议帧 `step-skip`（stream 值）

- [ ] **Step 1: 写失败测试（if 分支 + step-skip + outcomes 引用 + 缺失安全跳过）**

在 `internal/workflow/executor_test.go` 末尾追加：

```go
func TestExecutor_IfTrueRuns(t *testing.T) {
	var ran []string
	actionRun := func(id string, _ map[string]any, _ runner.EmitFunc) runner.Result {
		ran = append(ran, id)
		return runner.Result{ExitCode: 0}
	}
	shellRun := func(shell, timeout string, e runner.EmitFunc) runner.Result {
		ran = append(ran, "shell:"+shell)
		return runner.Result{ExitCode: 0}
	}
	wf := LoadedWorkflow{Def: WorkflowDef{ID: "w", Title: "W", Steps: []Step{
		{Shell: "probe", ID: "mode"},
		{Shell: "reboot", If: `outputs.mode.stdout contains "fastboot"`},
	}}}
	(&Executor{}).Execute(context.Background(), wf, actionRun, shellRun, func(_, _) {})
	// outcomes.mode.stdout 为空（mock 不填），contains 为假 → 第二步应被跳过
	if len(ran) != 1 {
		t.Fatalf("if 假时应跳过第二步，ran=%v", ran)
	}
}

func TestExecutor_IfSkipEmitsStepSkip(t *testing.T) {
	var skipped []string
	emit := func(stream, line string) {
		if stream == "step-skip" {
			skipped = append(skipped, line)
		}
	}
	// 第一步失败（记 outcomes），第二步 if success("s") → 因失败为假 → 跳过并 emit step-skip:1
	actionRun := func(id string, _ map[string]any, _ runner.EmitFunc) runner.Result {
		return runner.Result{ExitCode: 1}
	}
	shellRun := func(string, string, runner.EmitFunc) runner.Result { return runner.Result{ExitCode: 0} }
	wf := LoadedWorkflow{Def: WorkflowDef{ID: "w", Title: "W", Steps: []Step{
		{Shell: "x", ID: "s", ContinueOnError: true},
		{Shell: "y", If: `success("s")`},
	}}}
	(&Executor{}).Execute(context.Background(), wf, actionRun, shellRun, emit)
	if len(skipped) != 1 || skipped[0] != "1" {
		t.Fatalf("应 emit step-skip:1，got %v", skipped)
	}
}

func TestExecutor_OutcomesCarryStdoutForIf(t *testing.T) {
	var ran []string
	// 第一步把 stdout 填进 Result（模拟真实 shell 输出），第二步 if 引用之
	shellRun := func(shell, timeout string, e runner.EmitFunc) runner.Result {
		if strings.HasPrefix(shell, "probe") {
			return runner.Result{ExitCode: 0, Stdout: "device is fastboot mode"}
		}
		ran = append(ran, shell)
		return runner.Result{ExitCode: 0}
	}
	actionRun := func(string, map[string]any, runner.EmitFunc) runner.Result {
		return runner.Result{ExitCode: 0}
	}
	wf := LoadedWorkflow{Def: WorkflowDef{ID: "w", Title: "W", Steps: []Step{
		{Shell: "probe", ID: "mode"},
		{Shell: "fastboot-reboot", If: `outputs.mode.stdout contains "fastboot"`},
	}}}
	(&Executor{}).Execute(context.Background(), wf, actionRun, shellRun, func(_, _) {})
	if len(ran) != 1 || ran[0] != "fastboot-reboot" {
		t.Fatalf("if 引用上一步 stdout 为真时应执行第二步，ran=%v", ran)
	}
}

func TestExecutor_MissingRefSafeSkip(t *testing.T) {
	var ran []string
	shellRun := func(shell, timeout string, e runner.EmitFunc) runner.Result {
		ran = append(ran, shell)
		return runner.Result{ExitCode: 0}
	}
	actionRun := func(string, map[string]any, runner.EmitFunc) runner.Result { return runner.Result{ExitCode: 0} }
	// 引用不存在的 id → 缺失默认 false → 跳过，不崩
	wf := LoadedWorkflow{Def: WorkflowDef{ID: "w", Title: "W", Steps: []Step{
		{Shell: "x"},
		{Shell: "y", If: `success("ghost")`},
	}}}
	res := (&Executor{}).Execute(context.Background(), wf, actionRun, shellRun, func(_, _) {})
	if res.ExitCode != 0 {
		t.Fatalf("缺失引用应安全跳过不崩，exit=%d", res.ExitCode)
	}
	if len(ran) != 1 {
		t.Fatalf("第二步应被跳过，ran=%v", ran)
	}
}
```

> 顶部 import 需补 `"strings"`（`TestExecutor_OutcomesCarryStdoutForIf` 用 `strings.HasPrefix`）。

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd c:/Users/ASUS/Documents/workflow-tool && go test ./internal/workflow -run "TestExecutor_If|TestExecutor_Outcomes|TestExecutor_Missing" -v`
Expected: FAIL——`If` 字段已被 Step 支持（Task 5），但 executor 未读 `step.If`，故 if 假时第二步仍执行（`ran` 多于预期）/ 无 step-skip emit。

- [ ] **Step 3: 改 `executor.go` 的 `Execute`，加 outcomes + if 求值 + step-skip**

[internal/workflow/executor.go:29-47](internal/workflow/executor.go#L29) 的 `Execute` 方法替换为：

```go
// Execute 串行执行 wf 的每个 step，支持 retry、continue_on_error 与 if 条件守卫。
func (e *Executor) Execute(
	ctx context.Context,
	wf LoadedWorkflow,
	actionRun ActionRunFunc,
	shellRun ShellRunFunc,
	emit runner.EmitFunc,
) runner.Result {
	start := time.Now()
	outcomes := map[string]stepOutcome{} // key = step.ID（仅已执行的 step）
	lastSuccess := true                  // 紧邻上一个已执行 step 是否成功；初值 true
	for i, step := range wf.Def.Steps {
		// if 守卫：求值假则跳过（不进 outcomes、不改 lastSuccess）
		if step.If != "" {
			ok, err := EvalExpr(step.If, outcomes, lastSuccess)
			if err != nil {
				// 语法错已在 Validate 拦截；运行时到这属内部错误，保守终止
				emit("stderr", fmt.Sprintf("step %d if 求值失败: %v", i, err))
				return runner.Result{ExitCode: -1, Err: fmt.Errorf("step %d if 求值失败: %w", i, err), Duration: time.Since(start)}
			}
			if !ok {
				emit("step-skip", fmt.Sprintf("%d", i))
				continue
			}
		}

		emit("step-start", fmt.Sprintf("%d", i))
		res := e.runStep(ctx, step, actionRun, shellRun, emit)
		emit("step-done", fmt.Sprintf("%d:%d", i, res.ExitCode))

		if step.ID != "" {
			outcomes[step.ID] = stepOutcome{ExitCode: res.ExitCode, Stdout: res.Stdout, Stderr: res.Stderr}
		}
		lastSuccess = (res.ExitCode == 0)

		if res.ExitCode != 0 {
			if step.ContinueOnError {
				emit("stderr", "continue_on_error: 跳过失败继续")
				continue
			}
			res.Duration = time.Since(start)
			return res
		}
	}
	return runner.Result{ExitCode: 0, Duration: time.Since(start)}
}
```

- [ ] **Step 4: 运行 executor 全部测试，确认通过**

Run: `cd c:/Users/ASUS/Documents/workflow-tool && go test ./internal/workflow -v`
Expected: PASS——原有 5 个 + 新增 4 个 if/outcomes 测试。

- [ ] **Step 5: 运行后端全量回归**

Run: `cd c:/Users/ASUS/Documents/workflow-tool && go test ./internal/...`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
cd c:/Users/ASUS/Documents/workflow-tool
git add internal/workflow/executor.go internal/workflow/executor_test.go
git commit -m "feat(workflow): executor 支持 if 条件守卫 + step-skip 事件

- 执行期维护 outcomes(map[id]stepOutcome) 与 lastSuccess
- step.If 求值假→emit step-skip 并跳过（不进 outcomes、不改 lastSuccess）
- 已执行 step 的 Result.Stdout/Stderr 记入 outcomes 供后续 if 引用
- 缺失引用经 EvalExpr 安全返回 false（不崩）"
```

---

## Phase 3：前端 + 文档

### Task 7: 前端 step-skip 展示 + `WorkflowStepInfo` 加 ID/If + bindings 重生成

**Files:**
- Modify: `internal/api/api.go`（`WorkflowStepInfo` 加字段 + `buildStepInfos` 填充）
- Modify: `frontend/src/types/events.ts`
- Modify: `frontend/src/context/ActionRunnerProvider.tsx`
- Modify: `frontend/src/components/WorkflowView.tsx`
- Modify: `frontend/src/context/ActionRunnerProvider.test.tsx`
- Modify: `frontend/src/i18n/locales/zh.json`、`frontend/src/i18n/locales/en.json`
- Regenerate: `frontend/bindings/workflow-tool/internal/api/models.js`

**Interfaces:**
- Consumes: Task 6 的 `step-skip` 协议帧；Task 5 的 `Step.ID`/`Step.If`
- Produces: 后端 `WorkflowStepInfo{Kind, Label, ID, If}`；前端 `WorkflowStepState.status` 含 `"skipped"`；运行态 Pipeline Spine 渲染跳过态

> **bindings 红线**：改 `WorkflowStepInfo`（api.go 导出类型）后必须 `wails3 generate bindings` 重生成，前端 TS 类型才更新，否则编译错。

- [ ] **Step 1: 改后端 `WorkflowStepInfo` + `buildStepInfos`**

[internal/api/api.go:407-410](internal/api/api.go#L407) 的 `WorkflowStepInfo` 加字段：

```go
// WorkflowStepInfo 是前端侧边栏/概览可见的步骤摘要。
type WorkflowStepInfo struct {
	Kind  string `json:"kind"`  // "action" | "sleep" | "shell"
	Label string `json:"label"` // 显示文案，如 action id / "5s" / 截断 shell
	ID    string `json:"id"`    // step id（若有，供 UI 标注可被 if 引用）
	If    string `json:"if"`    // 条件表达式（若有，UI 可只读展示）
}
```

[internal/api/api.go:452-469](internal/api/api.go#L452) 的 `buildStepInfos` 把 `s.ID`/`s.If` 填入（在 switch 各分支的 `WorkflowStepInfo{...}` 字面量里加 `ID: s.ID, If: s.If`）：

```go
func buildStepInfos(steps []workflow.Step) []WorkflowStepInfo {
	infos := make([]WorkflowStepInfo, len(steps))
	for i, s := range steps {
		switch {
		case s.Action != "":
			infos[i] = WorkflowStepInfo{Kind: "action", Label: s.Action, ID: s.ID, If: s.If}
		case s.Sleep > 0:
			infos[i] = WorkflowStepInfo{Kind: "sleep", Label: fmt.Sprintf("%ds", s.Sleep), ID: s.ID, If: s.If}
		case s.Shell != "":
			label := s.Shell
			if len(label) > 40 {
				label = label[:37] + "..."
			}
			infos[i] = WorkflowStepInfo{Kind: "shell", Label: label, ID: s.ID, If: s.If}
		}
	}
	return infos
}
```

- [ ] **Step 2: 写后端测试（WorkflowStepInfo 新字段）**

在 `internal/api/api_test.go` 的 `TestListWorkflowsIncludesParamsAndSteps` 里更新期望（[api_test.go:52-56](internal/api/api_test.go#L52)）。原 YAML 步骤无 id/if，期望 `ID:""`/`If:""`；并新增一个带 id/if 的用例。在该测试函数末尾追加：

```go
	// 带 id/if 的 step 应回传字段
	svc2, _ := newWorkflowSvc(t, `id: w2
title: W2
steps:
  - id: mode
    shell: probe
    if: 'outputs.mode.stdout contains "fastboot"'
`)
	res2 := svc2.ListWorkflows()
	if len(res2.Workflows) != 1 {
		t.Fatalf("期望 1 个 workflow，errors=%v", res2.Errors)
	}
	st := res2.Workflows[0].Steps[0]
	if st.ID != "mode" || st.If == "" {
		t.Fatalf("WorkflowStepInfo 应回传 ID/If，got %+v", st)
	}
```

- [ ] **Step 3: 重生成 bindings + 构建后端**

Run:
```bash
cd c:/Users/ASUS/Documents/workflow-tool
go test ./internal/api -run TestListWorkflows -v   # 先确认后端测试通过
wails3 generate bindings
```
Expected: `models.js` 中 `WorkflowStepInfo` 新增 `id`/`if` 字段。

- [ ] **Step 4: 改前端 `events.ts`——stream 加 `step-skip`、status 加 `skipped`**

[frontend/src/types/events.ts:3-12](frontend/src/types/events.ts#L3) 的 `OutputEventData.stream` 联合类型加 `"step-skip"`：

```ts
export interface OutputEventData {
  stream:
    | "stdout"
    | "stderr"
    | "llm"
    | "llm-thinking"
    | "step-start"
    | "step-done"
    | "step-skip";
  line: string;
}
```

[frontend/src/types/events.ts:22-27](frontend/src/types/events.ts#L22) 的 `WorkflowStepState.status` 加 `"skipped"`：

```ts
export interface WorkflowStepState {
  index: number;
  status: "pending" | "running" | "done" | "error" | "skipped";
  exitCode?: number;
  lines: string[];
}
```

- [ ] **Step 5: 改 `ActionRunnerProvider.tsx`——`onOutput` 处理 `step-skip`**

在 [ActionRunnerProvider.tsx:222](frontend/src/context/ActionRunnerProvider.tsx#L222) `onOutput` 的 `if (d.stream === "step-start")` 分支**之前**插入 step-skip 分支：

```ts
      if (d.stream === "step-skip") {
        const idx = parseInt(d.line, 10);
        setWorkflowSteps((prev) => {
          const exists = prev.find((s) => s.index === idx);
          if (exists) {
            return prev.map((s) =>
              s.index === idx ? { ...s, status: "skipped" as const } : s,
            );
          }
          return [...prev, { index: idx, status: "skipped" as const, lines: [] }];
        });
        return;
      }
```

- [ ] **Step 6: 改 `WorkflowView.tsx`——4 组 Record + STATUS_I18N 补 `skipped`**

[WorkflowView.tsx:20-26](frontend/src/components/WorkflowView.tsx#L20) 的 `STATUS_I18N` 加：

```ts
const STATUS_I18N: Record<WorkflowStepState["status"], string> = {
  pending: "workflow.stepPending",
  running: "workflow.stepRunning",
  done: "workflow.stepDone",
  error: "workflow.stepError",
  skipped: "workflow.stepSkipped",
};
```

[WorkflowView.tsx:124-142](frontend/src/components/WorkflowView.tsx#L124) 三组 Record 各补 `skipped` 条目（虚线节点 + 灰 badge，与 pending 区分）：

```ts
              const nodeCls = {
                pending: "bg-transparent border-2 border-muted-foreground/40",
                running:
                  "bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_22%,transparent)] live-pulse",
                done: "bg-success",
                error: "bg-destructive",
                skipped: "bg-transparent border-2 border-dashed border-muted-foreground/30",
              }[st];
              const lineCls = {
                pending: "spine-pending",
                running: "spine-running",
                done: "bg-border",
                error: "bg-border",
                skipped: "spine-pending",
              }[st];
              const badgeCls = {
                pending: "text-muted-foreground",
                running: "border-primary/40 text-primary bg-primary/10",
                done: "border-success/40 text-success bg-success/10",
                error: "border-destructive/40 text-destructive bg-destructive/10",
                skipped: "text-muted-foreground/60",
              }[st];
```

[WorkflowView.tsx:156](frontend/src/components/WorkflowView.tsx#L156) 的 `Collapsible defaultOpen` 条件保持 `st === "running" || st === "error"`（skipped 默认折叠，无内容）。无需改。

- [ ] **Step 7: 加 i18n 文案**

`frontend/src/i18n/locales/zh.json` 的 `workflow` 段，在 `stepError` 旁加：

```json
    "stepSkipped": "已跳过",
```

`frontend/src/i18n/locales/en.json` 对应加：

```json
    "stepSkipped": "Skipped",
```

（位置与 `stepError` 同层，逗号按 JSON 规范补齐。）

- [ ] **Step 8: 加前端测试（step-skip 协议帧）**

[ActionRunnerProvider.test.tsx:400](frontend/src/context/ActionRunnerProvider.test.tsx#L400) 的 `it("step-start/stdout/step-done ...")` 之后，新增一个用例。沿用该文件既有模式：`renderHook(() => useActionRunner(), { wrapper })` 渲染 → 先 `runWorkflow("w1")` 建订阅 → 同步 `act(() => …)` 内多次 `_emitForTest` 推帧。

```ts
  it("step-skip 协议帧把 step 标为 skipped", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runWorkflow("w1");
    });
    act(() => {
      _emitForTest("workflow:w1:output", { data: { stream: "step-start", line: "0" } });
      _emitForTest("workflow:w1:output", { data: { stream: "step-skip", line: "1" } });
    });
    expect(result.current.workflowSteps).toEqual([
      { index: 0, status: "running", lines: [] },
      { index: 1, status: "skipped", lines: [] },
    ]);
  });
```

> `mockListActions`/`renderHook`/`act`/`wrapper`/`_emitForTest` 均为该测试文件已有符号（见 [ActionRunnerProvider.test.tsx:1-2,408](frontend/src/context/ActionRunnerProvider.test.tsx#L408)），直接复用，无需新增 helper。`[stderr] ` 前缀是 i18n `output.stderrPrefix` 的渲染，本用例不涉及 stderr。

- [ ] **Step 9: 运行前端测试 + lint + typecheck**

Run:
```bash
cd c:/Users/ASUS/Documents/workflow-tool/frontend
npm test -- --run
npm run lint
npm run typecheck
```
Expected: 全绿（vitest 含新 step-skip 用例；typecheck 确认 bindings/models.js 的 WorkflowStepInfo 新字段被正确消费）。

> 若 typecheck 报 `WorkflowStepInfo` 缺字段——回 Step 3 确认 `wails3 generate bindings` 已跑、`models.js` 含 `id`/`if`。

- [ ] **Step 10: 全量构建验证**

Run:
```bash
cd c:/Users/ASUS/Documents/workflow-tool
bash deploy/build.sh
```
Expected: 成功产出 `workflow-tool.exe`（前端 embed + bindings + go build 全通过）。

- [ ] **Step 11: 提交**

```bash
cd c:/Users/ASUS/Documents/workflow-tool
git add internal/api/api.go internal/api/api_test.go frontend/bindings frontend/src/types/events.ts frontend/src/context/ActionRunnerProvider.tsx frontend/src/context/ActionRunnerProvider.test.tsx frontend/src/components/WorkflowView.tsx frontend/src/i18n/locales/zh.json frontend/src/i18n/locales/en.json
git commit -m "feat(frontend): step-skip 跳过态展示 + WorkflowStepInfo 加 id/if

- events.ts: stream 加 step-skip，status 加 skipped
- ActionRunnerProvider 处理 step-skip 帧置 skipped
- WorkflowView 4 组 Record + STATUS_I18N 补 skipped（虚线节点+灰 badge）
- WorkflowStepInfo 加 ID/If + bindings 重生成
- i18n 加 workflow.stepSkipped（已跳过/Skipped）"
```

---

### Task 8: 文档同步（`docs/workflow.md` + `docs/action.md`）

**Files:**
- Modify: `docs/workflow.md`
- Modify: `docs/action.md`

**Interfaces:** 无代码接口；纯文档，CLAUDE.md 强制（schema 改动必须同步文档）。

- [ ] **Step 1: 改 `docs/workflow.md`——加 id/if 字段、表达式表、守卫模型、adb 示例**

在「三种 Step 形态」之后、「错误处理」之前，新增一节「条件步骤（if）」。在 [docs/workflow.md:21-33](docs/workflow.md#L21) 的完整字段参考 YAML 里给 step 补 `id`/`if` 示例行；并在合适位置插入新章节。具体改动：

(a) 完整字段参考的 `steps` 块补两个字段：

```yaml
steps:                         # 必填，至少一步
  - id: mode                   # 可选，step 标识，供后续 step 的 if 引用其输出（^[a-z][a-z0-9_-]*$，唯一）
    shell: probe-device         # 形态 C：内联 shell 命令
    timeout: 30s               # 仅 shell step 有效
    if: 'outputs.mode.stdout contains "fastboot"'  # 可选，条件为假则跳过本步
```

(b) 在「### shell：内联命令」之后新增整节：

````markdown
## 条件步骤（if）

任一 step 可加 `if` 条件表达式。求值为真则执行本步；为假则跳过（emit `step-skip`，前端标记「已跳过」）。配合 `id` 可引用前序步骤的**成败状态**与 **stdout 内容**，实现"按设备状态/前一步结果走不同分支"。

**守卫模型**（不做 if/then/else 嵌套块）：表达"二选一"= 两个互补 `if` 的 step。

### 表达式语法

| 表达式 | 含义 |
|--------|------|
| `success()` / `failure()` | 紧邻上一个**已执行** step 的成败（首个 step 视为成功） |
| `success("id")` / `failure("id")` | 指定 step 的成败 |
| `outputs.<id>.stdout contains "x"` | 该 step 的 stdout 含子串 `x` |
| `outputs.<id>.stdout matches /\d+\.\d+/` | stdout 匹配正则 |
| `outputs.<id>.stderr contains "x"` | stderr 含子串 |
| `outputs.<id>.exit_code == 0` | exit code 数字比较（`==` / `!=`） |
| `A and B` / `A or B` / `not A` | 布尔组合 |
| `( A )` | 分组 |

**操作数约束**：`contains`/`matches`/`==`/`!=` 左操作数为 `outputs.<id>.*` 引用，右操作数为字面字符串（`"..."`）、字面正则（`/.../`）或字面数字；不支持两个 outputs 引用互比。

**缺失引用安全默认**：引用不存在的 step id 时，`success("ghost")` 为假、`outputs.ghost.*` 比较为假——组合结果默认偏向「不执行」，不会报错或中断工作流。

### adb 场景示例

```yaml
id: reboot-by-mode
title: 按设备模式重启
steps:
  - id: mode
    shell: 'fastboot devices 2>/dev/null | grep -q . && echo fastboot || echo adb'
  - shell: 'fastboot reboot'
    if: 'outputs.mode.stdout contains "fastboot"'
  - shell: 'adb reboot bootloader'
    if: 'outputs.mode.stdout contains "adb"'
  - id: installed
    shell: 'adb shell pm path com.x.y 2>/dev/null | grep -q package'
  - shell: 'adb uninstall com.x.y'
    if: 'success("installed")'
```

### 用 LLM 作判断器

`stream: llm` 的 step 把 assistant 回答累积进其 `Result.Stdout`，`if` 可引用——把 LLM 当分类器：

```yaml
steps:
  - id: ask
    shell: 'claude -p "该报错该重试还是放弃？只答重试或放弃"'
    stream: llm
  - shell: './retry.sh'
    if: 'outputs.ask.stdout contains "重试"'
```
````

(c) 「校验规则」列表（[docs/workflow.md:184-193](docs/workflow.md#L184)）补两条：

```markdown
- `step.id`（若提供）须匹配 `^[a-z][a-z0-9_-]*$`，且 workflow 内唯一
- `step.if`（若提供）须是合法表达式（加载时 dry-run 解析，语法错则该文件被跳过）
```

(d) 「与 Action 的关系」表里 "LLM 流式" 行的 Workflow 列，由「不支持」改为「**间接支持**（workflow step 引用 `stream: llm` 的 action，LLM 回答进 step 的 stdout，可供 `if` 引用）」。

- [ ] **Step 2: 改 `docs/action.md`——`stream` 语义 + LLM Stdout 说明**

(a) [docs/action.md:54](docs/action.md#L54) command 字段表的 `stream` 行说明更新：

```markdown
| `stream` | 空 = 普通逐行输出（ShellRunner）；`"llm"` = 用 LLMRunner 解析 stream-json，assistant 回答累积进 `Result.Stdout`（见下） |
```

(b) 「## LLM 流式模式（stream: llm）」节（[docs/action.md:94-118](docs/action.md#L94)）末尾补一段「Stdout 语义」：

```markdown
### Result.Stdout 语义

`stream: llm` 的动作执行后，`Result.Stdout` 累积的是 **assistant 的 text 回复**（不含 thinking、stderr、无法解析的行）。当该动作被 workflow 的 step 引用并带 `id` 时，后续 step 的 `if` 可用 `outputs.<id>.stdout contains "..."` 引用 LLM 的回答，把 LLM 当作工作流里的判断器/分类器。详见 [Workflow 指南 · 条件步骤](workflow.md#条件步骤if)。
```

- [ ] **Step 3: 提交**

```bash
cd c:/Users/ASUS/Documents/workflow-tool
git add docs/workflow.md docs/action.md
git commit -m "docs: workflow if 条件步骤 + action stream 语义同步

- workflow.md: step id/if 字段、表达式语法表、守卫模型、adb/LLM 示例、校验规则
- action.md: stream 语义更新（选 runner 类型）+ LLM Result.Stdout=assistant text"
```

---

## 端到端验证（全部 task 完成后）

| 项 | 命令 / 方式 | 期望 |
|----|-------------|------|
| 后端单测全绿 | `go test ./internal/runner ./internal/workflow ./internal/registry ./internal/api` | PASS |
| 竞态 | `go test -race ./internal/...` | PASS |
| 前端 | `cd frontend && npm test && npm run lint && npm run typecheck` | 全绿 |
| 全量构建 | `bash deploy/build.sh` | 产出 exe |
| exec 编排 | Task 1 测试覆盖：超时 kill 进程组、`\r` 进度行独立成 token | PASS |
| ShellRunner | Task 2 测试：stdout/stderr 累积进 Result、256KB 截尾 | PASS |
| LLMRunner | Task 3 测试：stream-json → emit llm、Stdout=assistant text、非 JSON 不崩 | PASS |
| 表达式 | Task 4 测试：各操作符 + 缺失默认 false + 语法错 | PASS |
| executor | Task 6 测试：if 真假分支、step-skip、outcomes 跨步引用、缺失安全跳过 | PASS |
| 回归 | 现有 `stream: llm` action 行为不变；现有无 if workflow 行为不变 | 手测 exe |
| 端到端 | 写 `mode` 检测分支 workflow（见 docs 示例），运行确认按 stdout 走对分支 | 手测 exe |

---

## 备注

- **平台文件不动**：`hide_windows.go`/`hide_other.go`/`pgid_unix.go`/`pgid_windows.go` 在 Task 1 被 `exec.Run` 复用，零改动。
- **`llm.go` 不动**：`parseLLMLine`/`pumpLLM` 保留。`LLMRunner` 只复用 `parseLLMLine`（`pumpLLM` 不再用，可保留为死代码或后续清理——本计划不删，避免触及无关文件）。
- **`sleep_runner.go` 不动**：SleepRunner 不产 stdout，不参与 if 引用（被引用时缺失默认 false）。
- **inline shell step 不支持 `stream: llm`**：`makeShellRun` 固定 ShellRunner（YAGNI；workflow 内联命令若需 LLM 解析，做成 action 引用）。
