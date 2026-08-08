# workflow if 功能缺口审计 + Runner 拆分 — 设计文档

日期: 2026-08-08
状态: 待实施

## 1. 背景

`docs/superpowers/specs/2026-08-08-workflow-conditional-steps-design.md`（存档）是基于旧代码（workflow 纯线性、`Result` 无 stdout）写的手写表达式引擎方案。main 分支实际已用 **expr-lang/expr**（第三方库）+ `capture_output` / `##[output k=v]` 协议 + Step `id`/`if`/`env` 字段完整实现了条件步骤，方案与存档不同（第三方引擎 vs 手写解析器）。

本次任务：**审计 main 现有 `if` 实现是否有缺口**，而非重新设计整个功能。审计方式为通读 `internal/workflow/{schema,expr,context,executor}.go` 与 `internal/runner/{runner,shell_runner,llm}.go`，逐条核对存档设计中提出的约束是否已满足。

## 2. 审计发现（3 个缺口）

### 缺口 1：if 引用不存在的 step id 时中断整条 workflow

`internal/workflow/context.go` 的 `StepContext.Flatten()` 只把**已执行过**的 step 塞进 `steps` map。若 `if` 表达式写 `steps.notexist.outputs.success == 'true'`，expr 求值时对 `steps.notexist` 取到 nil，报错 `cannot fetch outputs from <nil>`（已用探测测试验证），`executor.go:55-59` 把这个 err 当致命错误，直接终止整条 workflow。

存档设计的既定共识是"缺失引用安全默认为假/空"，现状不满足——用户写 if 条件时手误拼错一个 step id，不是"该条件判 false 跳过"，而是"整条 workflow 崩溃"。

**根因**：`if` 表达式的 step id 有效性应该在**加载期**（`workflow.Validate`）检查一次，而不是留给运行期第一次求值时才发现。加载期发现问题、清晰报错，比运行期扔一个 expr 内部错误字符串更符合"快速失败 + 清晰错误消息"的原则。

### 缺口 2：Stdout/Stderr 累积无总量上限，长跑输出有 OOM 风险

`shell_runner.go` 的 `pump()` 把每行 append 进 `*strings.Builder`（`stdoutBuf`/`stderrBuf`），`bufio.Scanner` 只限制**单行** 1MB，不限制累积总量。若某 action 长跑输出巨量且 `capture_output` 未关闭（当前 `adb-logcat.yaml` 已手动设 `capture_output: false` 规避，但这是"作者记得关"，不是系统性保护），内存会无限增长直至 OOM。

**根因**：`capture_output` 是"要不要捕获"的开关，不是"捕获多少"的上限。两者是不同维度的控制，现状缺后一个。

### 缺口 3：LLM 解析逻辑寄生在 ShellRunner 内部分支，`\r` 单独进度行会丢失

`shell_runner.go:80` 的 `if cfg.Stream == "llm"` 分支耦合了两种完全不同的输出语义（普通 shell 逐行 vs claude stream-json 解析），且 `pump()` 用 `bufio.Scanner`（默认按 `\n` 切分），adb push/install 等命令用 `\r` 刷新同一行显示进度，当前会被当成一行的一部分，进度条不可见。

这条不是"用户报告的 bug"，而是审计中发现的**结构性问题**：ShellRunner 不应该知道 LLM 存在。经确认后决定：抽出通用进程编排层，顺带修 `\r` 切行。

## 3. 设计

### 3.1 `internal/runner/exec.go`（新）— 通用进程编排

从 `ShellRunner.Run` 抽出"起进程 + 双切行读取 + 超时 + 杀进程组"的通用逻辑，纯 Go、不依赖 Wails、不含 Shell/LLM 特定语义：

```go
package runner

import (
	"bufio"
	"context"
	"io"
	"os/exec"
	"time"
)

// ExecRequest 是一次进程执行的入参。
type ExecRequest struct {
	Cmd     *exec.Cmd
	Timeout time.Duration
}

// OnLine 是逐行回调；stream 为 "stdout" 或 "stderr"。
// 调用方（ShellRunner/LLMRunner）在回调里做自己的 buffer 累积和 emit。
type OnLine func(stream, line string)

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
		return ExecOutcome{Err: err, Duration: time.Since(start)}
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return ExecOutcome{Err: err, Duration: time.Since(start)}
	}
	if err := cmd.Start(); err != nil {
		return ExecOutcome{Err: err, Duration: time.Since(start)}
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
				return ExecOutcome{Err: werr, Duration: time.Since(start)}
			}
		}
		return ExecOutcome{ExitCode: exitCode, Duration: time.Since(start)}
	}
}

// scanLines 用 bufio.Scanner 配 splitLines（\n 与 \r 都切行）逐行回调。
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
// 等命令用 \r 刷新同一行显示进度，标准 ScanLines 只认 \n 会把整条进度流当一行）。
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

**测试**（`internal/runner/exec_test.go`，新）：
- 正常执行拿到 `ExitCode: 0`，`onLine` 收到预期行
- 超时触发 `killGroup`，`ExecOutcome.Err` 为 `context.DeadlineExceeded`
- `\r` 分隔的多段文本被切成独立行（如 `"a\rb\rc"` → 3 次 `onLine` 回调，各自 `a`/`b`/`c`）
- stderr 单独回调，stream 参数为 `"stderr"`

### 3.2 `ShellRunner` 收瘦 + 256KB 累积上限

`shell_runner.go` 改为调用 `runner.Run`（同包内直接调用 `Run`），`onLine` 回调里做 emit + buffer 累积 + `##[output]` 协议解析：

```go
// ShellConfig 去掉 Stream 字段（LLM 拆到独立 Runner，见 3.3）。
type ShellConfig struct {
	Shell         string
	Script        string
	Cwd           string
	Timeout       time.Duration
	Env           map[string]string
	BaseDir       string
	CaptureOutput *bool
}

func (r *ShellRunner) Run(ctx context.Context, params map[string]any, emit EmitFunc) Result {
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
			if stdoutBuf != nil {
				stdoutBuf.WriteLine(line)
			}
			if key, value, ok := parseOutputLine(line); ok {
				outputs[key] = value
			}
		} else if stderrBuf != nil {
			stderrBuf.WriteLine(line)
		}
	})

	stdout, stderr := stdoutBuf.String(), stderrBuf.String()
	return Result{
		ExitCode: outcome.ExitCode, Err: outcome.Err, Duration: outcome.Duration,
		Stdout: stdout, Stderr: stderr, Outputs: finalizeOutputs(outputs, outcome.ExitCode, stdout, stderr),
	}
}
```

**256KB 上限**（`internal/runner/util.go` 新增 `capBuffer`）：

```go
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

**测试**（`internal/runner/util_test.go`，新增用例）：
- 写入总量 < limit：`String()` 返回全部内容
- 写入总量 > limit：`String()` 只保留尾部 `limit` 字节，且不 panic
- nil `*capBuffer` 调 `WriteLine`/`String()` 安全（对应 `capture_output=false`）

### 3.3 `LLMRunner`（新文件 `internal/runner/llm_runner.go`）

把 `shell_runner.go` 里 `cfg.Stream=="llm"` 分支的职责整个搬到独立 Runner，`ShellConfig` 不再有 `Stream` 字段：

```go
package runner

import (
	"context"
	"time"
)

// LLMConfig 是 LLM action 的执行配置（与 ShellConfig 字段一致，无 Stream）。
type LLMConfig = ShellConfig

// LLMRunner 执行 claude CLI 命令，解析 stream-json，只把 assistant 的
// text/thinking 增量 emit 为 "llm"/"llm-thinking"；Result.Stdout 只放
// assistant text（供 if 表达式判断 LLM 回答内容，如 outputs.ask.stdout contains "重试"）。
type LLMRunner struct {
	Cfg LLMConfig
}

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

`recordStructuredFields`/`parseLLMLine` 是 `llm.go` 里已有的纯函数，原样复用，不改动。`llm.go` 里旧的 `pumpLLM` 函数删除（职责被 `LLMRunner.Run` + `Run` 回调取代）。

### 3.4 api 层按 `Command.Stream` 选择 Runner（两处）

`internal/api/api.go` 的 `execute()`（单动作执行）与 `makeActionRun()`（workflow 内 action step）目前都是无条件构造 `&ShellRunner{...}`；改为按 `la.Def.Command.Stream` 分发：

```go
var r runner.Runner
if la.Def.Command.Stream == "llm" {
	r = &runner.LLMRunner{Cfg: shellCfg}
} else {
	r = &runner.ShellRunner{Cfg: shellCfg}
}
res := r.Run(ctx, runParams, emit)
```

`registry.CommandDef.Stream` 字段保留（YAML 解析层，`stream: "llm"` 向后兼容不变），只是消费方从"ShellRunner 内部读 cfg.Stream"变成"api 层读 Command.Stream 选 Runner"。`ShellConfig`/`LLMConfig` 构造时不再传 `Stream` 值。

### 3.5 `workflow.Validate` 静态校验 if 引用的 step id（缺口 1 修复）

新增 `internal/workflow/expr_refs.go`：

```go
package workflow

import (
	"github.com/expr-lang/expr/ast"
	"github.com/expr-lang/expr/parser"
)

// referencedStepIDs 解析 exprStr 的 AST，提取所有形如
// steps.<id>.outputs.<key> 的成员访问链中的 <id>。
// 解析失败时返回 nil（语法错误由 EvalCondition 在运行时兜底报错，
// 此函数只负责"能解析时提取引用"，不重复做语法校验）。
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

`schema.go` 的 `Validate` 在遍历 `def.Steps` 时，对每个 `s.If != ""` 的 step：

```go
for _, refID := range referencedStepIDs(s.If) {
	if _, ok := seenStepID[refID]; !ok {
		return fmt.Errorf("steps[%d].if 引用了不存在或尚未执行的 step id %q", i, refID)
	}
}
```

`seenStepID` 已在同一循环里累积（`schema.go:82-108` 现有逻辑），复用即可——这天然保证了"只能引用前面的 step"（`seenStepID` 是按遍历顺序累积的，还没轮到的后续 step 不在其中）。

**为什么不改运行时行为**：加载期已经保证"能通过 Validate 的 workflow，if 表达式里的 step id 引用一定合法"，运行时理论上不会再遇到"引用不存在 id"的情况。`EvalCondition` 保留现有报错行为作为兜底（防御性——例如未来有人绕过 `Validate` 直接构造 `WorkflowDef` 跑 `Executor.Execute`），不需要额外做"运行时安全默认为 false"的逃生通道，那样反而会掩盖"加载期校验漏放"的 bug。

**测试**（`internal/workflow/loader_test.go` 或 `schema_test.go` 新增用例）：
- `if: 'steps.notexist.outputs.success == "true"'` → `Validate` 返回错误，提示引用了不存在的 id
- `if: 'steps.build.outputs.exit_code == "0"'`，`build` 是前面已声明的 step id → `Validate` 通过
- `if` 引用**后面**才声明的 step id（前向引用）→ `Validate` 报错（因为 `seenStepID` 还没记录到它）
- 语法错误的 `if`（如 `steps.build.outputs.` 缺右侧）→ `referencedStepIDs` 返回 nil，不在 Validate 阶段报"引用不存在"错，交给 `EvalCondition` 运行时的语法错误兜底（`Validate` 目前本就不做 if 语法预检，本次不新增）
- `if` 用 `env.X`/`params.Y`（非 `steps.*`）不受影响，`referencedStepIDs` 返回空列表

## 4. 改动范围

后端（Go）：
1. `internal/runner/exec.go`（新）+ `exec_test.go`（新）
2. `internal/runner/shell_runner.go`（收瘦，用 `Run`；删 `Stream` 字段；`pump`/`bufString` 删除，改用 `capBuffer`）
3. `internal/runner/llm_runner.go`（新）+ `llm_runner_test.go`（新）；`llm.go` 删 `pumpLLM`，保留 `parseLLMLine`/`recordStructuredFields`
4. `internal/runner/util.go`（新增 `capBuffer`/`maxCaptureBytes`）+ `util_test.go`（新增用例）
5. `internal/api/api.go`（`execute()` + `makeActionRun()` 两处按 `Command.Stream` 选 Runner）
6. `internal/workflow/expr_refs.go`（新）+ 对应测试
7. `internal/workflow/schema.go`（`Validate` 增加 if 引用校验）+ `loader_test.go` 或 `schema_test.go` 新增用例

文档：
- `docs/action.md`：`stream` 字段语义澄清（api 层选 Runner，而非 ShellRunner 内分支）
- `docs/workflow.md`：`if` 字段补充"引用不存在/前向的 step id 会在加载时报错"说明

**不动**：`Runner` 接口签名（`Run(ctx, params, emit) Result`）、`registry`/`expand.go`/`sleep_runner.go`、现有 action/workflow YAML（向后兼容）、`StepContext`/`EvalCondition`/`Substitute` 的表达式语义（`env`/`params`/`config`/`steps.*` 命名空间不变）。

## 5. 不做（YAGNI）

- **stdin 执行模式**——无场景，`ExecRequest` 需要时加 `Stdin` 字段即可
- **PTY**（adb 进度条真实终端渲染）——本次只做 `\r` 切行，不做 PTY
- **if/then/else 嵌套块、switch/case、循环、并行 step**——现有守卫模型够用，不动
- **前端 if 可视化编辑器**——仍是 YAML 手写 + UI 只读展示
- **运行时"缺失引用安全默认"逃生通道**——加载期静态校验已覆盖，运行时不重复兜底（见 3.5 说明）
- **表达式引擎替换**——沿用 main 现有 expr-lang，不改成手写解析器（存档方案已被否决）

## 6. 分阶段实现顺序

1. `internal/runner/exec.go` + `exec_test.go`（进程编排/超时/`\r\n` 双切行/杀进程组，独立可测，不依赖后续任何改动）
2. `internal/runner/util.go` 加 `capBuffer` + `util_test.go`
3. `ShellRunner` 改用 `exec.Run` + `capBuffer`；删 `pump`/`bufString`/`Stream` 字段；回归现有 `shell_runner_test.go`
4. `internal/runner/llm_runner.go` + `llm_runner_test.go`；`llm.go` 删 `pumpLLM`
5. `internal/api/api.go` 两处按 `Command.Stream` 选 Runner；回归现有 llm action 端到端行为
6. `internal/workflow/expr_refs.go` + 单测（各类 AST 形状：命中/未命中/语法错误/非 steps 引用）
7. `internal/workflow/schema.go` `Validate` 接入校验 + 单测（不存在 id / 前向引用 / 正常引用 / 语法错误跳过）
8. `docs/action.md` + `docs/workflow.md` 同步

## 7. 验证

| 项 | 方式 |
|----|------|
| 单测全绿 | `go test ./internal/runner ./internal/workflow ./internal/registry ./internal/api` |
| 竞态检测 | `go test -race ./...` |
| exec 编排 | 超时触发 kill 进程组；`\r` 分隔文本被切成独立行；stdout/stderr 分流回调正确 |
| ShellRunner | 256KB 上限生效（构造超限输出验证只保留尾部）；`capture_output=false` 时 Stdout/Stderr 为空 |
| LLMRunner | stream-json 解析为 `emit("llm")`；`Result.Stdout` = 累积 assistant text；非 JSON 行不崩；stderr 原样 emit 不进 Result |
| api 分发 | `stream: llm` action 走 LLMRunner，其余走 ShellRunner（两处调用点都覆盖） |
| Validate 缺口修复 | 引用不存在 id → 加载报错；引用前向 id → 加载报错；正常引用 → 通过；语法错误 if → 不在此阶段误报 |
| 回归 | 现有 `stream: llm` action（如 claude 相关 actions）行为不变；现有无 `if` workflow 行为不变；`docs/workflow.md` demo-if-outputs 示例仍正确执行 |
