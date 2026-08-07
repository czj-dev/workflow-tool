# Workflow/Action GitHub Actions & Claude Code Headless 借鉴增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 workflow 引入 step id/name/if 条件、outputs 契约、workflow.env 分层，为 LLM step 提供结构化 outputs（含 session_id）以支持多步续对话，action 层最小侵入（仅新增 `capture_output`）。

**Architecture:** workflow 编排层重写 Executor：累积 step outputs 到 context，`if` 用 `expr-lang/expr` 求值（不做文本替换，直接把 context map 作为 env），false → SKIPPED。shell 文本中的 `${{ expr }}` 由 Executor 预处理替换成实际值，剩余 `${VAR}` 仍由 `runner.Expand` 处理（两层各司其职）。ShellRunner 加 `capture_output` 开关，默认 true；`pumpLLM` 顺带填充 text/thinking/session_id/cost 到 outputs。

**Tech Stack:** Go 1.22+、`github.com/expr-lang/expr` 新增依赖、Wails v3-alpha2.119（锁死不升）、React 19 + TS + tailwind4。

## Global Constraints

- Wails 锁定 `v3.0.0-alpha2.119`，不升 alpha.3
- action id/workflow id 模式 `^[a-z0-9-]+$` 不变
- 变量优先级最终为：`params > workflow.env > step.env > config.yaml(全局) > 系统环境变量`
- 保留字（在 workflow.Validate 中禁止作为 `params[].id`）：`steps` / `env` / `params` / `config`
- `capture_output` 默认 `true`；`Command.CaptureOutput` / `Step.CaptureOutput` 用 `*bool` 以区分"未写=默认 true"与"显式 false"
- Result.Stdout/Stderr 不设容量上限（长跑 action 由作者显式 `capture_output: false` 控制）
- Executor 改动**必须保持向后兼容**：现有 workflow（无 id/name/if/env/capture_output/workflow.env）加载后行为与今天一致
- 改 `api.go` 的 Service 方法签名后必须重跑 `wails3 generate bindings` → `npm run build` → `go build`
- schema 改动必须同步更新 `docs/action.md` 与 `docs/workflow.md`

---

## File Structure

**新建：**
- `internal/runner/output.go` — `##[output key=value]` 协议解析器（纯函数）
- `internal/workflow/expr.go` — expr 引擎封装 `EvalCondition` / `Substitute`
- `internal/workflow/context.go` — `StepContext` 结构 + 展平函数

**修改：**
- `internal/runner/runner.go` — `Result` 新增 Stdout/Stderr/Outputs
- `internal/runner/shell_runner.go` — `ShellConfig.CaptureOutput`；`pump` 支持捕获
- `internal/runner/llm.go` — `pumpLLM` 扩展签名，填充结构化 outputs（session_id/cost/tokens/text/thinking）
- `internal/registry/registry.go` — `Command.CaptureOutput *bool`
- `internal/workflow/schema.go` — `Step.ID/Name/If/Env/CaptureOutput`、`WorkflowDef.Env`、校验
- `internal/workflow/executor.go` — 全新签名 + stepContext + if/SKIPPED + `${{ }}` 预处理 + env 分层
- `internal/api/api.go` — `makeActionRun/makeShellRun` 传 captureOutput/env；workflow 事件加 `step-skip`
- `frontend/src/types/events.ts` — 加 `"step-skip"` stream 值与 `"skipped"` 状态
- `frontend/src/context/ActionRunnerProvider.tsx` — 处理 `step-skip` 帧
- `frontend/src/components/WorkflowView.tsx` — SKIPPED 样式与 i18n
- `frontend/src/i18n/locales/{zh,en}.json` — `workflow.stepSkipped` 键
- `docs/action.md` / `docs/workflow.md` — schema 同步

**新增 demo：**
- `workflows/demo-if-outputs.yaml` — 覆盖 if / outputs / SKIPPED 的手动验收样例

**存量 YAML 迁移（Task 11）：**
- `actions/adb-scrcpy.yaml` / `actions/adb-logcat.yaml` — 长跑（`timeout: 24h`）action 显式 `capture_output: false`
- `workflows/demo-install-broadcast.yaml` / `demo-param-echo.yaml` / `xdzs-debug-chain.yaml` — 补 `id` + `name`
- `CLAUDE.md` — 「动作 YAML」/「工作流 YAML」两节的 schema 摘要同步

---
## Task 1: Result 扩展 + capture_output 协议解析器

**Files:**
- Modify: `internal/runner/runner.go`
- Create: `internal/runner/output.go`
- Test: `internal/runner/output_test.go`

**Interfaces:**
- Produces: `Result{ExitCode, Err, Duration, Stdout string, Stderr string, Outputs map[string]string}`；`parseOutputLine(line string) (key, value string, ok bool)`；`ReservedOutputKeys = map[string]bool{"exit_code": true, "stdout": true, "stderr": true, "success": true}`

- [ ] **Step 1: 写失败测试 —— 协议行解析**

创建 `internal/runner/output_test.go`：

```go
package runner

import "testing"

func TestParseOutputLine(t *testing.T) {
	cases := []struct {
		name      string
		line      string
		wantKey   string
		wantValue string
		wantOK    bool
	}{
		{"标准协议行", "##[output foo=bar]", "foo", "bar", true},
		{"值含等号", "##[output url=http://a.com?x=1]", "url", "http://a.com?x=1", true},
		{"值为空", "##[output empty=]", "empty", "", true},
		{"普通行不匹配", "hello world", "", "", false},
		{"缺右括号", "##[output foo=bar", "", "", false},
		{"缺 key", "##[output =bar]", "", "", false},
		{"前后有空格", "  ##[output foo=bar]  ", "foo", "bar", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			key, value, ok := parseOutputLine(c.line)
			if ok != c.wantOK {
				t.Fatalf("ok = %v, want %v", ok, c.wantOK)
			}
			if !ok {
				return
			}
			if key != c.wantKey || value != c.wantValue {
				t.Fatalf("got (%q,%q), want (%q,%q)", key, value, c.wantKey, c.wantValue)
			}
		})
	}
}
```

- [ ] **Step 2: 运行测试验证失败**

Run: `go test ./internal/runner -run TestParseOutputLine -v`
Expected: FAIL（`parseOutputLine` undefined / build failed）

- [ ] **Step 3: 实现 Result 扩展与协议解析器**

在 `internal/runner/runner.go` 里把 `Result` 改为：

```go
package runner

import (
	"context"
	"time"
)

// EmitFunc 把一行输出推到前端。stream 为 "stdout" 或 "stderr"。
type EmitFunc func(stream string, line string)

// Result 是一次执行的产物。
type Result struct {
	ExitCode int
	Err      error
	Duration time.Duration
	Stdout   string            // capture_output=true 时填充：全部 stdout 原文
	Stderr   string            // capture_output=true 时填充：全部 stderr 原文
	Outputs  map[string]string // ##[output key=value] 协议解析结果 + reserved key
}

// Runner 是执行单元接口。Phase 1 唯一实现是 ShellRunner。
// params 为 Phase 3（参数表单）预留，Phase 1 传 nil。
// 接口为 Phase 2/3/4 稳定不变。
type Runner interface {
	Run(ctx context.Context, params map[string]any, emit EmitFunc) Result
}
```

创建 `internal/runner/output.go`：

```go
package runner

import "strings"

// ReservedOutputKeys 是通用 Layer 1 outputs 的保留 key，脚本协议行命中会覆盖并触发 warning。
var ReservedOutputKeys = map[string]bool{
	"exit_code": true,
	"stdout":    true,
	"stderr":    true,
	"success":   true,
}

// parseOutputLine 解析一行是否匹配 ##[output key=value] 协议。
// 匹配成功返回 (key, value, true)；key 为空或格式不符返回 (_, _, false)。
func parseOutputLine(line string) (key, value string, ok bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "##[output ") || !strings.HasSuffix(line, "]") {
		return "", "", false
	}
	body := line[len("##[output ") : len(line)-1]
	idx := strings.Index(body, "=")
	if idx <= 0 {
		return "", "", false
	}
	return body[:idx], body[idx+1:], true
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `go test ./internal/runner -run TestParseOutputLine -v`
Expected: PASS（全部 7 个子测试通过）

- [ ] **Step 5: Commit**

```bash
git add internal/runner/runner.go internal/runner/output.go internal/runner/output_test.go
git commit -m "feat: Result 新增 Stdout/Stderr/Outputs 字段，加 output 协议行解析器"
```

---

## Task 2: ShellRunner capture_output 捕获逻辑

**Files:**
- Modify: `internal/runner/shell_runner.go`
- Test: `internal/runner/shell_runner_test.go`

**Interfaces:**
- Consumes: `Result{Stdout, Stderr, Outputs}`（Task 1）、`parseOutputLine`（Task 1）
- Produces: `ShellConfig.CaptureOutput *bool`（nil 或指向 true = 默认捕获，指向 false = 关闭）；`ShellRunner.Run` 返回值含 `Stdout/Stderr/Outputs`

- [ ] **Step 1: 写失败测试 —— 默认捕获**

在 `internal/runner/shell_runner_test.go` 末尾追加（先读现有文件确认已有的 helper/import 不重复）：

```go
func TestShellRunner_CaptureOutput_DefaultOn(t *testing.T) {
	r := &ShellRunner{Cfg: ShellConfig{
		Shell:   `echo "hello"; echo "err" 1>&2`,
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
	off := false
	r := &ShellRunner{Cfg: ShellConfig{
		Shell:         `echo "hello"`,
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
	r := &ShellRunner{Cfg: ShellConfig{
		Shell:   `echo "normal line"; echo "##[output build_id=42]"`,
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

func TestShellRunner_CaptureOutput_ReservedKeyOverride(t *testing.T) {
	r := &ShellRunner{Cfg: ShellConfig{
		Shell:   `echo "##[output exit_code=999]"`,
		Timeout: 5 * time.Second,
	}}
	res := r.Run(context.Background(), nil, func(string, string) {})
	// 协议值覆盖 reserved key（已在 spec 中确认此优先级）
	if res.Outputs["exit_code"] != "999" {
		t.Fatalf("reserved key 应被协议行覆盖，got %q", res.Outputs["exit_code"])
	}
}
```

在文件顶部 import 块补 `"strings"`（如尚未导入，先读文件确认）。

- [ ] **Step 2: 运行测试验证失败**

Run: `go test ./internal/runner -run TestShellRunner_CaptureOutput -v`
Expected: FAIL（`ShellConfig.CaptureOutput` 字段不存在 / `res.Stdout` 恒为空）

- [ ] **Step 3: 实现捕获逻辑**

修改 `internal/runner/shell_runner.go`：

在 `ShellConfig` 结构体中新增字段（紧跟 `Stream` 之后）：

```go
	Stream        string            // "" 普通逐行；"llm" 走 pumpLLM 解析 stream-json
	CaptureOutput *bool             // nil 或指向 true = 捕获全量 stdout/stderr 供 outputs 使用；指向 false = 关闭（长跑/持续输出 action 用）
```

修改 `pump` 函数签名，让它把每行同时写入一个 `*strings.Builder`（若非 nil）并解析协议行：

```go
// pump 逐行读取 r 并 emit；capture 非 nil 时同时把整行 append 进 buf，
// 且对每行尝试解析 ##[output key=value] 协议写入 outputs（仅 stdout 侧传非 nil outputs）。
func pump(r io.Reader, stream string, emit EmitFunc, done chan<- struct{}, buf *strings.Builder, outputs map[string]string) {
	defer close(done)
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := stripANSI(sc.Text())
		emit(stream, line)
		if buf != nil {
			buf.WriteString(line)
			buf.WriteString("\n")
		}
		if outputs != nil {
			if key, value, ok := parseOutputLine(line); ok {
				outputs[key] = value
			}
		}
	}
}
```

在 `Run` 方法里，`doneOut`/`doneErr` 启动前构造捕获用的 buffer 与 outputs map，并按 `capture_output` 决定是否传 nil：

```go
	captureOn := cfg.CaptureOutput == nil || *cfg.CaptureOutput
	var stdoutBuf, stderrBuf *strings.Builder
	outputs := map[string]string{}
	if captureOn {
		stdoutBuf = &strings.Builder{}
		stderrBuf = &strings.Builder{}
	}

	doneOut := make(chan struct{})
	doneErr := make(chan struct{})
	if cfg.Stream == "llm" {
		go pumpLLM(stdoutPipe, emit, doneOut, outputs)
	} else {
		go pump(stdoutPipe, "stdout", emit, doneOut, stdoutBuf, outputs)
	}
	go pump(stderrPipe, "stderr", emit, doneErr, stderrBuf, nil)
```

（`pumpLLM` 签名在 Task 4 修改；此处先按新签名声明，Task 2 可暂时给 `pumpLLM` 占位改动，或者直接把 Task 2/4 的 pump 调用点一次改完——这里选择：Task 2 先只改 `pump`，`cfg.Stream == "llm"` 分支的 `pumpLLM` 调用暂时保留原签名 `pumpLLM(stdoutPipe, emit, doneOut)`，Task 4 再统一改造。为此本步骤里 llm 分支保持不变：）

```go
	if cfg.Stream == "llm" {
		go pumpLLM(stdoutPipe, emit, doneOut)
	} else {
		go pump(stdoutPipe, "stdout", emit, doneOut, stdoutBuf, outputs)
	}
	go pump(stderrPipe, "stderr", emit, doneErr, stderrBuf, nil)
```

在两个 `return` 分支（timeout 与正常 wait）里补上 `Stdout`/`Stderr`/`Outputs` 并设置 reserved key（放一个 helper 统一算）：

```go
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

然后两个 return 点：

```go
	select {
	case <-timeoutCtx.Done():
		killGroup(cmd)
		<-waitCh
		exitCode := -1
		stdout, stderr := bufString(stdoutBuf), bufString(stderrBuf)
		return Result{
			ExitCode: exitCode, Err: timeoutCtx.Err(), Duration: time.Since(start),
			Stdout: stdout, Stderr: stderr, Outputs: finalizeOutputs(outputs, exitCode, stdout, stderr),
		}
	case werr := <-waitCh:
		exitCode := 0
		if werr != nil {
			if ee, ok := werr.(*exec.ExitError); ok {
				exitCode = ee.ExitCode()
			} else {
				return Result{Err: fmt.Errorf("wait: %w", werr), Duration: time.Since(start)}
			}
		}
		stdout, stderr := bufString(stdoutBuf), bufString(stderrBuf)
		return Result{
			ExitCode: exitCode, Duration: time.Since(start),
			Stdout: stdout, Stderr: stderr, Outputs: finalizeOutputs(outputs, exitCode, stdout, stderr),
		}
	}
```

补一个 nil-safe helper：

```go
// bufString 返回 buf 内容；buf 为 nil（capture_output=false）时返回空字符串。
func bufString(buf *strings.Builder) string {
	if buf == nil {
		return ""
	}
	return buf.String()
}
```

顶部 import 补 `"strings"`。

- [ ] **Step 4: 运行测试验证通过**

Run: `go test ./internal/runner -v`
Expected: PASS（新 4 个测试 + 已有全部测试）

- [ ] **Step 5: Commit**

```bash
git add internal/runner/shell_runner.go internal/runner/shell_runner_test.go
git commit -m "feat: ShellRunner 支持 capture_output 全量捕获与 output 协议解析"
```

---

## Task 3: registry.Command 新增 capture_output 字段

**Files:**
- Modify: `internal/registry/registry.go`
- Test: `internal/registry/registry_test.go`

**Interfaces:**
- Consumes: 无新依赖
- Produces: `Command.CaptureOutput *bool`（YAML key `capture_output`）

- [ ] **Step 1: 写失败测试**

在 `internal/registry/registry_test.go` 追加（先读文件确认现有测试用什么 helper 加载 YAML，沿用同样模式；假设已有 `ParseAction` 可用）：

```go
func TestParseAction_CaptureOutputField(t *testing.T) {
	yamlSrc := []byte(`
id: test-capture
title: 测试
command:
  shell: echo hi
  capture_output: false
`)
	def, err := ParseAction(yamlSrc)
	if err != nil {
		t.Fatalf("ParseAction error: %v", err)
	}
	if def.Command.CaptureOutput == nil || *def.Command.CaptureOutput != false {
		t.Fatalf("CaptureOutput = %v, want pointer to false", def.Command.CaptureOutput)
	}
}

func TestParseAction_CaptureOutputDefaultNil(t *testing.T) {
	yamlSrc := []byte(`
id: test-capture-default
title: 测试
command:
  shell: echo hi
`)
	def, err := ParseAction(yamlSrc)
	if err != nil {
		t.Fatalf("ParseAction error: %v", err)
	}
	if def.Command.CaptureOutput != nil {
		t.Fatalf("CaptureOutput 未写时应为 nil（表示默认 true），got %v", *def.Command.CaptureOutput)
	}
}
```

- [ ] **Step 2: 运行测试验证失败**

Run: `go test ./internal/registry -run TestParseAction_CaptureOutput -v`
Expected: FAIL（`Command.CaptureOutput` 字段不存在，编译错误）

- [ ] **Step 3: 实现字段**

修改 `internal/registry/registry.go` 的 `Command` 结构体：

```go
// Command 是动作的执行块。
type Command struct {
	Shell         string            `yaml:"shell"`
	Script        string            `yaml:"script"`
	Cwd           string            `yaml:"cwd"`
	Timeout       string            `yaml:"timeout"`
	Env           map[string]string `yaml:"env"`
	Stream        string            `yaml:"stream"` // "" 普通逐行；"llm" 按 stream-json 解析
	CaptureOutput *bool             `yaml:"capture_output"` // nil/true=默认捕获；false=关闭（scrcpy/logcat 等长跑用）
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `go test ./internal/registry -v`
Expected: PASS（全部测试，含新 2 个）

- [ ] **Step 5: Commit**

```bash
git add internal/registry/registry.go internal/registry/registry_test.go
git commit -m "feat: action command 新增 capture_output 字段"
```

---

## Task 4: LLM step 结构化 outputs（pumpLLM 扩展）

**Files:**
- Modify: `internal/runner/llm.go`
- Modify: `internal/runner/shell_runner.go` (更新 pumpLLM 调用点)
- Test: `internal/runner/llm_test.go`

**Interfaces:**
- Consumes: 无新依赖（复用 `Result.Outputs` 契约）
- Produces: `pumpLLM(r io.Reader, emit EmitFunc, done chan<- struct{}, outputs map[string]string)`；填充 `outputs["text"]`、`outputs["thinking"]`、`outputs["session_id"]`、`outputs["cost_usd"]`、`outputs["total_tokens"]`

- [ ] **Step 1: 写失败测试 —— 结构化字段提取**

在 `internal/runner/llm_test.go` 追加（先读现有文件确认 `parseLLMLine` 测试写法一致，沿用相同 mock JSON 行结构）：

```go
func TestPumpLLM_StructuredOutputs(t *testing.T) {
	input := strings.Join([]string{
		`{"type":"system","subtype":"init","session_id":"sess-abc-123"}`,
		`{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"思考中"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"，世界"}]}}`,
		`{"type":"result","total_cost_usd":0.0123,"usage":{"input_tokens":100,"output_tokens":50}}`,
	}, "\n")

	outputs := map[string]string{}
	done := make(chan struct{})
	pumpLLM(strings.NewReader(input), func(string, string) {}, done, outputs)
	<-done

	if outputs["session_id"] != "sess-abc-123" {
		t.Fatalf("session_id = %q, want sess-abc-123", outputs["session_id"])
	}
	if outputs["text"] != "你好，世界" {
		t.Fatalf("text = %q, want 你好，世界", outputs["text"])
	}
	if outputs["thinking"] != "思考中" {
		t.Fatalf("thinking = %q, want 思考中", outputs["thinking"])
	}
	if outputs["cost_usd"] != "0.0123" {
		t.Fatalf("cost_usd = %q, want 0.0123", outputs["cost_usd"])
	}
	if outputs["total_tokens"] != "150" {
		t.Fatalf("total_tokens = %q, want 150", outputs["total_tokens"])
	}
}
```

- [ ] **Step 2: 运行测试验证失败**

Run: `go test ./internal/runner -run TestPumpLLM_StructuredOutputs -v`
Expected: FAIL（`pumpLLM` 签名不匹配，编译错误）

- [ ] **Step 3: 实现结构化提取**

修改 `internal/runner/llm.go`：

```go
package runner

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// llmStreamEvent 是 claude stream-json 一行事件的通用结构（只取关心字段）。
type llmStreamEvent struct {
	Type      string `json:"type"`
	SessionID string `json:"session_id"`
	Message   struct {
		Content []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Thinking string `json:"thinking"`
		} `json:"content"`
	} `json:"message"`
	TotalCostUSD float64 `json:"total_cost_usd"`
	Usage        struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
}

// parseLLMLine 解析 claude stream-json 的一行，提取 assistant 的 text 或 thinking 增量。
// 返回 (kind, delta, true)：kind 为 "text"（回复）或 "thinking"（思考过程）；
// 返回 ok=false 表示该行无内容（system/result/无法解析/tool_use），应跳过。
// 同一事件同时含 text 与 thinking 时优先返回 text（claude 通常分行输出，罕见同事件混存）。
func parseLLMLine(line string) (kind string, delta string, ok bool) {
	line = strings.TrimSpace(line)
	if line == "" {
		return "", "", false
	}
	var ev llmStreamEvent
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		return "", "", false
	}
	if ev.Type != "assistant" {
		return "", "", false
	}
	var text, thinking strings.Builder
	for _, c := range ev.Message.Content {
		switch c.Type {
		case "text":
			text.WriteString(c.Text)
		case "thinking":
			thinking.WriteString(c.Thinking)
		}
	}
	if text.Len() > 0 {
		return "text", text.String(), true
	}
	if thinking.Len() > 0 {
		return "thinking", thinking.String(), true
	}
	return "", "", false
}

// pumpLLM 逐行读取 r，按 stream-json 解析，把 assistant text/thinking 增量 emit，
// 并把结构化字段（session_id/text/thinking/cost_usd/total_tokens）累积写入 outputs。
// text → emit("llm", delta)；thinking → emit("llm-thinking", delta)。
func pumpLLM(r io.Reader, emit EmitFunc, done chan<- struct{}, outputs map[string]string) {
	defer close(done)
	var text, thinking strings.Builder
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		raw := sc.Text()
		recordStructuredFields(raw, outputs)
		kind, delta, ok := parseLLMLine(raw)
		if !ok {
			continue
		}
		if kind == "thinking" {
			thinking.WriteString(delta)
			emit("llm-thinking", delta)
		} else {
			text.WriteString(delta)
			emit("llm", delta)
		}
	}
	if outputs != nil {
		if text.Len() > 0 {
			outputs["text"] = text.String()
		}
		if thinking.Len() > 0 {
			outputs["thinking"] = thinking.String()
		}
	}
}

// recordStructuredFields 解析 system/init 的 session_id 与 result 的 cost/tokens，写入 outputs。
// outputs 为 nil 时跳过（capture_output=false 场景）。
func recordStructuredFields(line string, outputs map[string]string) {
	if outputs == nil {
		return
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	var ev llmStreamEvent
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		return
	}
	if ev.SessionID != "" {
		outputs["session_id"] = ev.SessionID
	}
	if ev.Type == "result" {
		outputs["cost_usd"] = fmt.Sprint(ev.TotalCostUSD)
		outputs["total_tokens"] = fmt.Sprint(ev.Usage.InputTokens + ev.Usage.OutputTokens)
	}
}
```

在 `internal/runner/shell_runner.go` 里把 llm 分支调用点改为新签名：

```go
	if cfg.Stream == "llm" {
		go pumpLLM(stdoutPipe, emit, doneOut, outputs)
	} else {
		go pump(stdoutPipe, "stdout", emit, doneOut, stdoutBuf, outputs)
	}
```

（`capture_output=false` 时 `outputs` 仍非 nil——它承载 exit_code/success 等 reserved key，只是 stdout/stderr buffer 为 nil；LLM 的 session_id/text 等结构化字段独立于 capture_output 开关，始终提取，因为这是 `pumpLLM` 解析出来的语义数据而非原始 stdout 转储。这一行为需在 `docs/action.md` 里注明。）

- [ ] **Step 4: 运行测试验证通过**

Run: `go test ./internal/runner -v`
Expected: PASS（全部测试，含新增）

- [ ] **Step 5: Commit**

```bash
git add internal/runner/llm.go internal/runner/shell_runner.go internal/runner/llm_test.go
git commit -m "feat: LLM stream 提取 session_id/cost/tokens/text/thinking 结构化 outputs"
```

---
## Task 5: workflow schema 扩展与保留字校验

**Files:**
- Modify: `internal/workflow/schema.go`
- Test: `internal/workflow/loader_test.go`

**Interfaces:**
- Consumes: 无
- Produces: `Step.ID/Name/If string`、`Step.Env map[string]string`、`Step.CaptureOutput *bool`、`WorkflowDef.Env map[string]string`；`Validate` 新增保留字校验与 id 唯一性校验

- [ ] **Step 1: 写失败测试**

在 `internal/workflow/loader_test.go` 追加（如 loader_test.go 已有 `parseAndValidate` 或直接调 `Validate`，沿用；否则直接 `Validate(&def)`）：

```go
func TestValidate_ReservedParamID(t *testing.T) {
	for _, reserved := range []string{"steps", "env", "params", "config"} {
		def := &WorkflowDef{
			ID:    "wf-1",
			Title: "t",
			Params: []registry.ParamSpec{
				{ID: reserved, Type: "text"},
			},
			Steps: []Step{{Shell: "echo hi"}},
		}
		if err := Validate(def); err == nil {
			t.Errorf("param id %q 应因保留字被拒", reserved)
		}
	}
}

func TestValidate_StepIDUniqueness(t *testing.T) {
	def := &WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{ID: "a", Shell: "echo 1"},
			{ID: "a", Shell: "echo 2"},
		},
	}
	if err := Validate(def); err == nil {
		t.Error("重复 step id 应报错")
	}
}

func TestValidate_StepIDPattern(t *testing.T) {
	def := &WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{{ID: "Bad_ID", Shell: "echo 1"}},
	}
	if err := Validate(def); err == nil {
		t.Error("step id 不合法应报错")
	}
}

func TestValidate_StepIDOptional(t *testing.T) {
	def := &WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{{Shell: "echo 1"}, {Shell: "echo 2"}},
	}
	if err := Validate(def); err != nil {
		t.Errorf("未写 step id 应合法（索引兜底），got %v", err)
	}
}
```

如已有 `registry` import，直接用。否则在 `internal/workflow/loader_test.go` 顶部 import 补 `"workflow-tool/internal/registry"`（读文件确认）。

- [ ] **Step 2: 运行测试验证失败**

Run: `go test ./internal/workflow -run TestValidate_ -v`
Expected: FAIL（新校验未实现，几个测试都会说"应报错但没报"）

- [ ] **Step 3: 实现字段与校验**

修改 `internal/workflow/schema.go`：

```go
package workflow

import (
	"fmt"
	"regexp"

	"workflow-tool/internal/registry"
)

var idPattern = regexp.MustCompile(`^[a-z0-9-]+$`)

var validParamTypes = map[string]bool{
	"text": true, "bool": true, "select": true, "path": true,
}

// reservedParamIDs 是 params[].id 不能占用的保留字（用于 expr 表达式的扁平顶层命名空间）。
var reservedParamIDs = map[string]bool{
	"steps": true, "env": true, "params": true, "config": true,
}

type WorkflowDef struct {
	ID          string               `yaml:"id"`
	Title       string               `yaml:"title"`
	Icon        string               `yaml:"icon"`
	Description string               `yaml:"description"`
	Env         map[string]string    `yaml:"env"` // workflow 级默认环境变量
	Params      []registry.ParamSpec `yaml:"params"`
	Steps       []Step               `yaml:"steps"`
}

type Step struct {
	ID              string            `yaml:"id"`              // 可选；未写用 steps[i] 索引兜底
	Name            string            `yaml:"name"`            // 可选；Pipeline Spine 显示用
	If              string            `yaml:"if"`              // 可选；expr 表达式，false → SKIPPED
	Action          string            `yaml:"action"`
	Params          map[string]string `yaml:"params"`
	Sleep           int               `yaml:"sleep"`
	Shell           string            `yaml:"shell"`
	Timeout         string            `yaml:"timeout"`
	Env             map[string]string `yaml:"env"`             // step 级 env，覆盖 workflow.env 同名 key
	CaptureOutput   *bool             `yaml:"capture_output"`  // nil/true=默认；false=关闭
	Retry           int               `yaml:"retry"`
	ContinueOnError bool              `yaml:"continue_on_error"`
}

type LoadedWorkflow struct {
	Def  WorkflowDef
	File string
}

func Validate(def *WorkflowDef) error {
	if !idPattern.MatchString(def.ID) {
		return fmt.Errorf("id 必须匹配 ^[a-z0-9-]+$，got %q", def.ID)
	}
	if def.Title == "" {
		return fmt.Errorf("title 必填")
	}
	if len(def.Steps) == 0 {
		return fmt.Errorf("steps 不能为空")
	}
	for i, p := range def.Params {
		if p.ID == "" {
			return fmt.Errorf("params[%d]: id 必填", i)
		}
		if reservedParamIDs[p.ID] {
			return fmt.Errorf("params[%d]: id %q 为保留字（steps/env/params/config 不可用作 param id）", i, p.ID)
		}
		if p.Type != "" && !validParamTypes[p.Type] {
			return fmt.Errorf("params[%d]: type 非法 %q（text|bool|select|path）", i, p.Type)
		}
		if p.Type == "select" && len(p.Options) == 0 {
			return fmt.Errorf("params[%d]: select 必须提供 options", i)
		}
	}
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
	}
	return nil
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `go test ./internal/workflow -v`
Expected: PASS（新 4 个 + 全部老测试）

- [ ] **Step 5: Commit**

```bash
git add internal/workflow/schema.go internal/workflow/loader_test.go
git commit -m "feat: workflow schema 新增 step id/name/if/env/capture_output 与 workflow.env"
```

---

## Task 6: 引入 expr 依赖并实现条件求值

**Files:**
- Create: `internal/workflow/expr.go`
- Create: `internal/workflow/context.go`
- Test: `internal/workflow/expr_test.go`
- Modify: `go.mod` / `go.sum`（`go get` 自动更新）

**Interfaces:**
- Consumes: `github.com/expr-lang/expr`
- Produces:
  - `StepContext{Steps map[string]StepOutput, Env map[string]string, Params map[string]any, Config map[string]string}`
  - `StepOutput{Outputs map[string]string}`
  - `(*StepContext) Flatten() map[string]any` — 用于 expr env
  - `EvalCondition(expr string, ctx *StepContext) (bool, error)`
  - `Substitute(text string, ctx *StepContext) (string, error)` — 处理 shell 里的 `${{ expr }}`
- Note: `Substitute` 在 Task 8 由 Executor 调用。

- [ ] **Step 1: 添加依赖**

```bash
cd /Users/v_chenzhaojun/Documents/workflow-tool
go get github.com/expr-lang/expr@latest
```

- [ ] **Step 2: 写失败测试**

创建 `internal/workflow/expr_test.go`：

```go
package workflow

import "testing"

func TestEvalCondition_StepOutput(t *testing.T) {
	ctx := &StepContext{
		Steps: map[string]StepOutput{
			"build": {Outputs: map[string]string{"exit_code": "0", "success": "true"}},
		},
	}
	got, err := EvalCondition(`steps.build.outputs.exit_code == '0'`, ctx)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !got {
		t.Fatal("want true")
	}
}

func TestEvalCondition_BooleanOps(t *testing.T) {
	ctx := &StepContext{
		Steps: map[string]StepOutput{
			"a": {Outputs: map[string]string{"success": "true"}},
			"b": {Outputs: map[string]string{"success": "false"}},
		},
	}
	cases := []struct {
		expr string
		want bool
	}{
		{`steps.a.outputs.success == 'true' && steps.b.outputs.success == 'false'`, true},
		{`steps.a.outputs.success == 'true' || steps.b.outputs.success == 'true'`, true},
		{`!(steps.b.outputs.success == 'true')`, true},
		{`steps.a.outputs.success != steps.b.outputs.success`, true},
	}
	for _, c := range cases {
		got, err := EvalCondition(c.expr, ctx)
		if err != nil {
			t.Fatalf("%q: err %v", c.expr, err)
		}
		if got != c.want {
			t.Fatalf("%q: got %v want %v", c.expr, got, c.want)
		}
	}
}

func TestEvalCondition_EnvAndParams(t *testing.T) {
	ctx := &StepContext{
		Env:    map[string]string{"LOG_LEVEL": "debug"},
		Params: map[string]any{"MODE": "fast"},
	}
	got, err := EvalCondition(`env.LOG_LEVEL == 'debug' && params.MODE == 'fast'`, ctx)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !got {
		t.Fatal("want true")
	}
}

func TestSubstitute_ExpressionInShell(t *testing.T) {
	ctx := &StepContext{
		Steps: map[string]StepOutput{
			"a": {Outputs: map[string]string{"session_id": "sess-xyz"}},
		},
	}
	out, err := Substitute(`claude --resume ${{ steps.a.outputs.session_id }} "hi"`, ctx)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := `claude --resume sess-xyz "hi"`
	if out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
}

func TestSubstitute_NoExpression(t *testing.T) {
	ctx := &StepContext{}
	out, err := Substitute("echo hello", ctx)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if out != "echo hello" {
		t.Fatalf("got %q, want echo hello", out)
	}
}
```

- [ ] **Step 3: 运行测试验证失败**

Run: `go test ./internal/workflow -run "TestEvalCondition|TestSubstitute" -v`
Expected: FAIL（`StepContext`/`EvalCondition`/`Substitute` 未定义，编译错误）

- [ ] **Step 4: 实现 context + expr 封装**

创建 `internal/workflow/context.go`：

```go
package workflow

// StepOutput 是单个 step 的执行结果快照，用于后续 step 通过 steps.<id>.outputs.<key> 引用。
type StepOutput struct {
	Outputs map[string]string
}

// StepContext 累积 workflow 执行中的所有可查询变量。
// Steps 键为 step.id 或索引兜底字符串（如 "0"/"1"）。
type StepContext struct {
	Steps  map[string]StepOutput
	Env    map[string]string // workflow.env 合并 step.env 后的展开值
	Params map[string]any    // 表单参数（含全局 config 合并结果，params 侧命名空间）
	Config map[string]string // config.yaml 原样（保留通道，暂供 expr 查询）
}

// Flatten 展平为 expr.Eval 的 env map：顶层 key 为 steps/env/params/config，
// steps 下再嵌套 <id>.outputs.<key>。所有值转成 any 以便 expr 反射访问。
func (c *StepContext) Flatten() map[string]any {
	stepsMap := make(map[string]any, len(c.Steps))
	for id, so := range c.Steps {
		outs := make(map[string]any, len(so.Outputs))
		for k, v := range so.Outputs {
			outs[k] = v
		}
		stepsMap[id] = map[string]any{"outputs": outs}
	}
	envMap := make(map[string]any, len(c.Env))
	for k, v := range c.Env {
		envMap[k] = v
	}
	configMap := make(map[string]any, len(c.Config))
	for k, v := range c.Config {
		configMap[k] = v
	}
	paramsMap := make(map[string]any, len(c.Params))
	for k, v := range c.Params {
		paramsMap[k] = v
	}
	return map[string]any{
		"steps":  stepsMap,
		"env":    envMap,
		"params": paramsMap,
		"config": configMap,
	}
}
```

创建 `internal/workflow/expr.go`：

```go
package workflow

import (
	"fmt"
	"regexp"

	"github.com/expr-lang/expr"
)

// EvalCondition 求值 workflow step 的 if 表达式，返回布尔结果。
// 空表达式视为 true（步骤无条件执行）。
func EvalCondition(exprStr string, ctx *StepContext) (bool, error) {
	if exprStr == "" {
		return true, nil
	}
	out, err := expr.Eval(exprStr, ctx.Flatten())
	if err != nil {
		return false, fmt.Errorf("if 表达式求值失败 %q: %w", exprStr, err)
	}
	b, ok := out.(bool)
	if !ok {
		return false, fmt.Errorf("if 表达式必须返回 bool，实际 %T: %v", out, out)
	}
	return b, nil
}

// exprPattern 匹配 ${{ ... }} 表达式片段（非贪婪）。
var exprPattern = regexp.MustCompile(`\$\{\{\s*(.+?)\s*\}\}`)

// Substitute 用 expr 引擎对 text 中所有 ${{ expr }} 片段求值并替换成字符串值。
// 用于 shell 命令预处理，剩余 ${VAR} 由 runner.Expand 处理。
// 任一片段求值失败即返回整体错误。
func Substitute(text string, ctx *StepContext) (string, error) {
	env := ctx.Flatten()
	var firstErr error
	out := exprPattern.ReplaceAllStringFunc(text, func(match string) string {
		if firstErr != nil {
			return match
		}
		sub := exprPattern.FindStringSubmatch(match)
		if len(sub) < 2 {
			return match
		}
		result, err := expr.Eval(sub[1], env)
		if err != nil {
			firstErr = fmt.Errorf("${{ %s }} 求值失败: %w", sub[1], err)
			return match
		}
		return fmt.Sprint(result)
	})
	if firstErr != nil {
		return "", firstErr
	}
	return out, nil
}
```

- [ ] **Step 5: 运行测试验证通过**

Run: `go test ./internal/workflow -v`
Expected: PASS（新测试 + 全部老测试）

- [ ] **Step 6: Commit**

```bash
git add internal/workflow/expr.go internal/workflow/context.go internal/workflow/expr_test.go go.mod go.sum
git commit -m "feat: 引入 expr-lang/expr 与 workflow StepContext/EvalCondition/Substitute"
```

---

## Task 7: Executor 改造 —— outputs 累积 + if/SKIPPED + env 分层

**Files:**
- Modify: `internal/workflow/executor.go`
- Test: `internal/workflow/executor_test.go`

**Interfaces:**
- Consumes: `StepContext`（Task 6）、`EvalCondition`/`Substitute`（Task 6）、`Result.Outputs`（Task 1）
- Produces:
  - `ActionRunFunc` 与 `ShellRunFunc` 新签名（增加 env / captureOutput 参数）
  - `Executor.Execute` 内部维护 `StepContext`，每个 step 跑完把 `Result.Outputs` 写入 `ctx.Steps[stepKey]`
  - `if` 为 false → emit `step-skip` 事件（stream="step-skip"，line="<index>"），不 dispatch，不计 retry/continue_on_error
  - shell step 的 `step.Shell` 在 dispatch 前经 `Substitute` 处理 `${{ }}` 片段

**新签名（协议契约给 Task 9 的 api.go）：**

```go
type ActionRunFunc func(actionID string, params map[string]any, env map[string]string, captureOutput *bool, emit runner.EmitFunc) runner.Result

type ShellRunFunc func(shell, timeout string, env map[string]string, captureOutput *bool, params map[string]any, emit runner.EmitFunc) runner.Result
```

- [ ] **Step 1: 写失败测试 —— outputs 累积 + if 跳过**

在 `internal/workflow/executor_test.go` 追加（先读文件看现有 mock ActionRunFunc/ShellRunFunc 怎么写的，沿用；这里给完整可编译片段）：

```go
func TestExecutor_StepOutputsAccumulate(t *testing.T) {
	wf := LoadedWorkflow{Def: WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{ID: "first", Shell: "echo 1"},
			{ID: "second", Shell: "echo 2", If: "steps.first.outputs.exit_code == '0'"},
		},
	}}
	var ranSecond bool
	shellRun := func(shellCmd, timeout string, env map[string]string, capture *bool, params map[string]any, emit runner.EmitFunc) runner.Result {
		if shellCmd == "echo 2" {
			ranSecond = true
		}
		return runner.Result{
			ExitCode: 0,
			Outputs:  map[string]string{"exit_code": "0", "success": "true"},
		}
	}
	actionRun := func(string, map[string]any, map[string]string, *bool, runner.EmitFunc) runner.Result {
		t.Fatal("no action step")
		return runner.Result{}
	}
	res := (&Executor{}).Execute(context.Background(), wf, actionRun, shellRun, nil, func(string, string) {})
	if res.ExitCode != 0 {
		t.Fatalf("exit = %d, want 0", res.ExitCode)
	}
	if !ranSecond {
		t.Fatal("second step 应被执行（if 求值为 true）")
	}
}

func TestExecutor_IfFalseSkips(t *testing.T) {
	wf := LoadedWorkflow{Def: WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{ID: "first", Shell: "echo 1"},
			{ID: "skip", Shell: "echo skipped", If: "steps.first.outputs.exit_code == '99'"},
			{ID: "third", Shell: "echo 3"},
		},
	}}
	var ran []string
	shellRun := func(shellCmd, timeout string, env map[string]string, capture *bool, params map[string]any, emit runner.EmitFunc) runner.Result {
		ran = append(ran, shellCmd)
		return runner.Result{ExitCode: 0, Outputs: map[string]string{"exit_code": "0", "success": "true"}}
	}
	var skipEvents []string
	emit := func(stream, line string) {
		if stream == "step-skip" {
			skipEvents = append(skipEvents, line)
		}
	}
	res := (&Executor{}).Execute(context.Background(), wf,
		func(string, map[string]any, map[string]string, *bool, runner.EmitFunc) runner.Result { return runner.Result{} },
		shellRun, nil, emit)
	if res.ExitCode != 0 {
		t.Fatalf("exit = %d, want 0", res.ExitCode)
	}
	if len(ran) != 2 || ran[0] != "echo 1" || ran[1] != "echo 3" {
		t.Fatalf("ran = %v, want [echo 1, echo 3]", ran)
	}
	if len(skipEvents) != 1 || skipEvents[0] != "1" {
		t.Fatalf("skipEvents = %v, want [\"1\"]", skipEvents)
	}
}

func TestExecutor_IndexFallbackID(t *testing.T) {
	wf := LoadedWorkflow{Def: WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{Shell: "echo first"},  // 无 id，用 "0"
			{Shell: "echo second", If: "steps.0.outputs.exit_code == '0'"},
		},
	}}
	var ran []string
	shellRun := func(shellCmd, timeout string, env map[string]string, capture *bool, params map[string]any, emit runner.EmitFunc) runner.Result {
		ran = append(ran, shellCmd)
		return runner.Result{ExitCode: 0, Outputs: map[string]string{"exit_code": "0"}}
	}
	res := (&Executor{}).Execute(context.Background(), wf,
		func(string, map[string]any, map[string]string, *bool, runner.EmitFunc) runner.Result { return runner.Result{} },
		shellRun, nil, func(string, string) {})
	if res.ExitCode != 0 {
		t.Fatalf("exit = %d", res.ExitCode)
	}
	if len(ran) != 2 {
		t.Fatalf("ran = %v, want 2 steps", ran)
	}
}

func TestExecutor_SubstituteShellExpr(t *testing.T) {
	wf := LoadedWorkflow{Def: WorkflowDef{
		ID: "wf-1", Title: "t",
		Steps: []Step{
			{ID: "first", Shell: "produce"},
			{ID: "consume", Shell: "use ${{ steps.first.outputs.token }}"},
		},
	}}
	var seen string
	shellRun := func(shellCmd, timeout string, env map[string]string, capture *bool, params map[string]any, emit runner.EmitFunc) runner.Result {
		if strings.HasPrefix(shellCmd, "use ") {
			seen = shellCmd
			return runner.Result{ExitCode: 0}
		}
		return runner.Result{ExitCode: 0, Outputs: map[string]string{"token": "abc123", "exit_code": "0"}}
	}
	(&Executor{}).Execute(context.Background(), wf,
		func(string, map[string]any, map[string]string, *bool, runner.EmitFunc) runner.Result { return runner.Result{} },
		shellRun, nil, func(string, string) {})
	if seen != "use abc123" {
		t.Fatalf("shell substituted = %q, want %q", seen, "use abc123")
	}
}
```

顶部 import 补 `"context"`、`"strings"`、`"testing"`、`"workflow-tool/internal/runner"`（读文件确认现有 imports 后再补差异）。

- [ ] **Step 2: 运行测试验证失败**

Run: `go test ./internal/workflow -run TestExecutor_ -v`
Expected: FAIL（`Execute` 签名不匹配 + 新逻辑未实现）

- [ ] **Step 3: 改写 Executor**

替换 `internal/workflow/executor.go` 全文：

```go
package workflow

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"workflow-tool/internal/runner"
)

// ActionRunFunc 执行已有 action。env/captureOutput 由 workflow 决定，注入进 ShellRunner。
type ActionRunFunc func(
	actionID string,
	params map[string]any,
	env map[string]string,
	captureOutput *bool,
	emit runner.EmitFunc,
) runner.Result

// ShellRunFunc 执行 inline shell step。
type ShellRunFunc func(
	shell, timeout string,
	env map[string]string,
	captureOutput *bool,
	params map[string]any,
	emit runner.EmitFunc,
) runner.Result

// Executor 按顺序执行 workflow 的 steps。
type Executor struct{}

// Execute 串行执行 wf 的每个 step。
// baseParams 是 config.yaml 合并 workflow 表单参数的结果（api 层构造）。
func (e *Executor) Execute(
	ctx context.Context,
	wf LoadedWorkflow,
	actionRun ActionRunFunc,
	shellRun ShellRunFunc,
	baseParams map[string]any,
	emit runner.EmitFunc,
) runner.Result {
	start := time.Now()
	stepCtx := &StepContext{
		Steps:  map[string]StepOutput{},
		Env:    resolveEnv(wf.Def.Env, baseParams),
		Params: baseParams,
	}

	for i, step := range wf.Def.Steps {
		stepKey := stepKey(step, i)

		// if 求值（每次现算，因为 stepCtx 随每个 step 累积变化）
		shouldRun, err := EvalCondition(step.If, stepCtx)
		if err != nil {
			emit("stderr", err.Error())
			return runner.Result{ExitCode: -1, Err: err, Duration: time.Since(start)}
		}
		if !shouldRun {
			emit("step-skip", fmt.Sprintf("%d", i))
			// 记录一个占位 output，让后续 step 可判断这一步"没跑"
			stepCtx.Steps[stepKey] = StepOutput{Outputs: map[string]string{
				"exit_code": "-1", "success": "false", "skipped": "true",
			}}
			continue
		}

		emit("step-start", fmt.Sprintf("%d", i))
		res := e.runStep(ctx, step, actionRun, shellRun, stepCtx, emit)
		emit("step-done", fmt.Sprintf("%d:%d", i, res.ExitCode))

		// 累积 outputs 到 context（供后续 step 的 if / ${{ }} 引用）
		if res.Outputs == nil {
			res.Outputs = map[string]string{
				"exit_code": strconv.Itoa(res.ExitCode),
				"success":   fmt.Sprint(res.ExitCode == 0),
			}
		}
		stepCtx.Steps[stepKey] = StepOutput{Outputs: res.Outputs}

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

// runStep 执行单个 step，含 retry 与 ${{ }} 预处理。
func (e *Executor) runStep(
	ctx context.Context,
	step Step,
	actionRun ActionRunFunc,
	shellRun ShellRunFunc,
	stepCtx *StepContext,
	emit runner.EmitFunc,
) runner.Result {
	res := e.dispatch(ctx, step, actionRun, shellRun, stepCtx, emit)
	if res.ExitCode == 0 || step.Retry <= 0 {
		return res
	}
	for attempt := 1; attempt <= step.Retry; attempt++ {
		emit("stdout", fmt.Sprintf("retry %d/%d", attempt, step.Retry))
		res = e.dispatch(ctx, step, actionRun, shellRun, stepCtx, emit)
		if res.ExitCode == 0 {
			return res
		}
	}
	return res
}

// dispatch 根据 step kind 分发一次执行。
func (e *Executor) dispatch(
	ctx context.Context,
	step Step,
	actionRun ActionRunFunc,
	shellRun ShellRunFunc,
	stepCtx *StepContext,
	emit runner.EmitFunc,
) runner.Result {
	stepEnv := mergeEnv(stepCtx.Env, step.Env)
	switch {
	case step.Sleep > 0:
		return (&runner.SleepRunner{Seconds: step.Sleep}).Run(ctx, nil, emit)
	case step.Action != "":
		return actionRun(step.Action, toAnyMap(step.Params), stepEnv, step.CaptureOutput, emit)
	case step.Shell != "":
		substituted, err := Substitute(step.Shell, stepCtx)
		if err != nil {
			emit("stderr", err.Error())
			return runner.Result{ExitCode: -1, Err: err}
		}
		return shellRun(substituted, step.Timeout, stepEnv, step.CaptureOutput, stepCtx.Params, emit)
	default:
		return runner.Result{ExitCode: -1, Err: fmt.Errorf("step 无有效 kind")}
	}
}

// stepKey 返回 step 在 context 中的键：有 id 用 id，否则用索引字符串。
func stepKey(s Step, i int) string {
	if s.ID != "" {
		return s.ID
	}
	return strconv.Itoa(i)
}

// resolveEnv 用 baseParams 对 workflow.Env 的值做 ${VAR} 展开（支持 workflow.env 引用 params/config）。
func resolveEnv(rawEnv map[string]string, baseParams map[string]any) map[string]string {
	if len(rawEnv) == 0 {
		return map[string]string{}
	}
	return runner.ExpandMap(rawEnv, baseParams)
}

// mergeEnv 合并 workflow.env 与 step.env（step 覆盖同名）。
func mergeEnv(wfEnv, stepEnv map[string]string) map[string]string {
	if len(wfEnv) == 0 && len(stepEnv) == 0 {
		return nil
	}
	out := make(map[string]string, len(wfEnv)+len(stepEnv))
	for k, v := range wfEnv {
		out[k] = v
	}
	for k, v := range stepEnv {
		out[k] = v
	}
	return out
}

// toAnyMap 将 map[string]string 转为 map[string]any。
func toAnyMap(m map[string]string) map[string]any {
	if m == nil {
		return nil
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
```

- [ ] **Step 4: 更新已有 executor 老测试签名**

老测试可能调用旧签名 `Execute(ctx, wf, actionRun, shellRun, emit)`——`go test` 会报编译错。把它们统一改为 `Execute(ctx, wf, actionRun, shellRun, nil, emit)`；老 `ActionRunFunc`/`ShellRunFunc` mock 参数也要按新签名补 `env` 与 `captureOutput`。用批量替换编辑器逐个改。

- [ ] **Step 5: 运行测试验证通过**

Run: `go test ./internal/workflow -v -race`
Expected: PASS（新测试 + 老测试全部）

- [ ] **Step 6: Commit**

```bash
git add internal/workflow/executor.go internal/workflow/executor_test.go
git commit -m "feat: Executor 支持 step outputs 累积、if/SKIPPED、env 分层、\${{ }} 预处理"
```

---
## Task 8: api.go 适配新 Executor 签名 + 传递 env/captureOutput

**Files:**
- Modify: `internal/api/api.go`

**Interfaces:**
- Consumes: 新 `ActionRunFunc`/`ShellRunFunc` 签名（Task 7）
- Produces: `makeActionRun` 与 `makeShellRun` 传递 env/captureOutput 到 `ShellRunner.Cfg`

- [ ] **Step 1: 修改 executeWorkflow 与回调**

> **实现约束（变量优先级正确性）**：workflow.env / step.env 必须同时进入 **`runParams`（供 `runner.Expand` 解析 `${VAR}`）** 与 `cfg.Env`（子进程环境）。仅进 `cfg.Env` 会导致 `${VAR}` 在 Go 侧 Expand 阶段命中不了（打 warning + 保留原样），在 Windows PowerShell 下 `${VAR}` 语法还会失效。
> 合并进 `runParams` 时的优先级：`config(merged 里的 global) < workflow.env/step.env < step.params`。即：先铺 `merged`，再覆盖 `env`，最后覆盖 step 传入的 params。这样 `runner.Expand` 与 `expr` 两条路径看到的值一致，且跨平台。


在 `internal/api/api.go` 的 `executeWorkflow` 方法中：

把 `Executor.Execute` 的调用增加 `merged` 参数：

```go
	res := (&workflow.Executor{}).Execute(ctx, lw, actionRun, shellRun, merged, emit)
```

修改 `makeActionRun` 签名与实现：

```go
func (s *Service) makeActionRun(ctx context.Context, merged map[string]any) workflow.ActionRunFunc {
	return func(actionID string, stepParams map[string]any, env map[string]string, captureOutput *bool, stepEmit runner.EmitFunc) runner.Result {
		la, ok := s.reg.Actions[actionID]
		if !ok {
			stepEmit("stderr", fmt.Sprintf("未知动作 %q", actionID))
			return runner.Result{ExitCode: -1, Err: fmt.Errorf("未知动作 %q", actionID)}
		}
		runParams := make(map[string]any, len(merged)+len(stepParams)+len(env))
		for k, v := range merged {
			runParams[k] = v
		}
		// env（workflow.env + step.env）覆盖 config/global，供 runner.Expand 解析 ${VAR}
		for k, v := range env {
			runParams[k] = v
		}
		for k, v := range stepParams {
			runParams[k] = v // step.params 优先级最高
		}
		// env 分层：action 定义的 env + workflow/step 注入的 env（后者覆盖前者）
		mergedEnv := make(map[string]string, len(la.Def.Command.Env)+len(env))
		for k, v := range la.Def.Command.Env {
			mergedEnv[k] = v
		}
		for k, v := range env {
			mergedEnv[k] = v
		}
		// captureOutput 优先级：step 显式设置 > action 定义
		capture := la.Def.Command.CaptureOutput
		if captureOutput != nil {
			capture = captureOutput
		}
		r := &runner.ShellRunner{Cfg: runner.ShellConfig{
			Shell:         la.Def.Command.Shell,
			Script:        la.Def.Command.Script,
			Cwd:           la.Cwd,
			Timeout:       la.Timeout,
			Env:           mergedEnv,
			BaseDir:       s.baseDir,
			Stream:        la.Def.Command.Stream,
			CaptureOutput: capture,
		}}
		return r.Run(ctx, runParams, stepEmit)
	}
}
```

修改 `makeShellRun` 签名与实现：

```go
func (s *Service) makeShellRun(ctx context.Context, merged map[string]any) workflow.ShellRunFunc {
	return func(shellCmd, timeoutStr string, env map[string]string, captureOutput *bool, params map[string]any, stepEmit runner.EmitFunc) runner.Result {
		timeout := 60 * time.Second
		if timeoutStr != "" {
			if d, err := time.ParseDuration(timeoutStr); err == nil {
				timeout = d
			}
		}
		// 合并 merged params + env(workflow.env/step.env) + 传入 params，优先级从低到高
		runParams := make(map[string]any, len(merged)+len(env)+len(params))
		for k, v := range merged {
			runParams[k] = v
		}
		for k, v := range env {
			runParams[k] = v
		}
		for k, v := range params {
			runParams[k] = v
		}
		r := &runner.ShellRunner{Cfg: runner.ShellConfig{
			Shell:         shellCmd,
			Timeout:       timeout,
			Env:           env,
			BaseDir:       s.baseDir,
			CaptureOutput: captureOutput,
		}}
		return r.Run(ctx, runParams, stepEmit)
	}
}
```

- [ ] **Step 2: 编译验证**

Run: `go build ./...`
Expected: 无编译错误

- [ ] **Step 3: 运行全量测试**

Run: `go test ./... -race`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add internal/api/api.go
git commit -m "feat: api.go 适配新 Executor 签名，传递 env/captureOutput/merged"
```

---

## Task 9: 前端 SKIPPED 状态 + step name 显示

**Files:**
- Modify: `frontend/src/types/events.ts`
- Modify: `frontend/src/context/ActionRunnerProvider.tsx`
- Modify: `frontend/src/components/WorkflowView.tsx`
- Modify: `frontend/src/i18n/locales/zh.json`
- Modify: `frontend/src/i18n/locales/en.json`

**Interfaces:**
- Consumes: 后端 `step-skip` 事件（stream="step-skip"，line="<index>"）
- Produces: UI 中 SKIPPED 节点灰色虚线样式；step name 优先显示

- [ ] **Step 1: 类型变更 — events.ts**

在 `frontend/src/types/events.ts` 中：

`OutputEventData.stream` 联合类型新增 `"step-skip"`：

```typescript
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

`WorkflowStepState.status` 联合类型新增 `"skipped"`：

```typescript
export interface WorkflowStepState {
  index: number;
  status: "pending" | "running" | "done" | "error" | "skipped";
  exitCode?: number;
  lines: string[];
}
```

- [ ] **Step 2: ActionRunnerProvider 处理 step-skip**

在 `frontend/src/context/ActionRunnerProvider.tsx` 的 `onOutput` 处理中（在 `step-done` 分支之后）新增：

```typescript
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

- [ ] **Step 3: WorkflowView.tsx — SKIPPED 样式 + name 字段**

在 `STATUS_I18N` 补 `skipped` key：

```typescript
const STATUS_I18N: Record<WorkflowStepState["status"], string> = {
  pending: "workflow.stepPending",
  running: "workflow.stepRunning",
  done: "workflow.stepDone",
  error: "workflow.stepError",
  skipped: "workflow.stepSkipped",
};
```

在 Pipeline Spine 渲染处，根据 `step.status === "skipped"` 对线 / 徽标 / 背景加 `opacity-40 border-dashed` 等类名以显示"灰色虚线"效果（找到渲染 step 卡片的 JSX 位置，给外层 div 条件追加类名）：

```tsx
const skipped = step.status === "skipped";
// 外层加：className={cn("...", skipped && "opacity-50 border-dashed")}
```

**step name 字段**：后端 `WorkflowStepInfo.Label` 目前由 action id / shell 前缀兜底。新增 `Name` 字段后（后端 Task 11 统一暴露），前端在合并 step 显示时优先取 `info.name`（如后端已传），否则保持现状。此步骤先只改 TS 类型 + 条件分支，待后端 binding 更新后自然连通。

在 `api.go` 的 `WorkflowStepInfo` 加 `Name string json:"name"`（后端 Task 11 做）后，前端 `StepView.name` 的来源改为 `info.name || info.label`：

```tsx
name: info.name || (info.kind === "sleep" ? t("...") : info.label),
```

暂时如果 binding 里没有 `name`，TypeScript 会 ignore——在 Task 11 后端改 + 重生 bindings 后连通。

- [ ] **Step 4: i18n**

在 `frontend/src/i18n/locales/zh.json` 的 `workflow` 分区追加：

```json
"workflow.stepSkipped": "已跳过"
```

在 `frontend/src/i18n/locales/en.json` 追加：

```json
"workflow.stepSkipped": "Skipped"
```

- [ ] **Step 5: lint + typecheck**

Run:
```bash
cd frontend && npm run lint && npm run typecheck
```
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types/events.ts frontend/src/context/ActionRunnerProvider.tsx \
  frontend/src/components/WorkflowView.tsx frontend/src/i18n/locales/zh.json \
  frontend/src/i18n/locales/en.json
git commit -m "feat: 前端新增 SKIPPED 状态样式与 step name 显示"
```

---

## Task 10: 后端 buildStepInfos 传递 name 字段 + 事件协议 + bindings 重生成

**Files:**
- Modify: `internal/api/api.go`

**Interfaces:**
- Consumes: `workflow.Step.Name`（Task 5）
- Produces: `WorkflowStepInfo.Name` 传给前端

- [ ] **Step 1: 修改 WorkflowStepInfo 与 buildStepInfos**

在 `WorkflowStepInfo` 加字段：

```go
type WorkflowStepInfo struct {
	Kind  string `json:"kind"`
	Label string `json:"label"`
	Name  string `json:"name"` // 新增：step.name 人类可读标签
}
```

在 `buildStepInfos` 中填充：

```go
func buildStepInfos(steps []workflow.Step) []WorkflowStepInfo {
	infos := make([]WorkflowStepInfo, len(steps))
	for i, s := range steps {
		info := WorkflowStepInfo{Name: s.Name}
		switch {
		case s.Action != "":
			info.Kind = "action"
			info.Label = s.Action
		case s.Sleep > 0:
			info.Kind = "sleep"
			info.Label = fmt.Sprintf("%ds", s.Sleep)
		case s.Shell != "":
			info.Kind = "shell"
			label := s.Shell
			if len(label) > 40 {
				label = label[:37] + "..."
			}
			info.Label = label
		}
		infos[i] = info
	}
	return infos
}
```

- [ ] **Step 2: 重生 bindings + 编译**

Run:
```bash
cd /Users/v_chenzhaojun/Documents/workflow-tool
wails3 generate bindings
cd frontend && npm run build && cd ..
go build ./...
```
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add internal/api/api.go frontend/bindings/
git commit -m "feat: WorkflowStepInfo 新增 name 字段，重生前端 bindings"
```

---

## Task 11: 文档同步 + 存量 YAML 迁移 + demo yaml + 验收

**Files:**
- Modify: `docs/action.md`
- Modify: `docs/workflow.md`
- Modify: `CLAUDE.md`
- Modify: `actions/adb-scrcpy.yaml`
- Modify: `actions/adb-logcat.yaml`
- Modify: `workflows/demo-install-broadcast.yaml`
- Modify: `workflows/demo-param-echo.yaml`
- Modify: `workflows/xdzs-debug-chain.yaml`
- Create: `workflows/demo-if-outputs.yaml`

**Interfaces:**
- Consumes: 整体 schema 变更（Task 3、5）
- Produces: 面向用户的文档更新、存量 YAML 迁移到新字段、可手动验收的 demo workflow

**为什么存量 YAML 要动**：`capture_output` 默认 `true` 是全新行为——`adb-scrcpy`/`adb-logcat` 是 `timeout: 24h` 的长跑/持续输出 action（投屏、日志流），一旦默认捕获，`Stdout`/`Stderr` 会无上限累积在内存里直到进程被取消，这是本次改动引入的真实回归风险，必须显式关闭。三个已有 workflow 补 `id`/`name` 不是必需（无 id 时索引兜底、无 name 时 label 兜底，行为不变），但补上能让它们在新 Pipeline Spine 上和 demo workflow 体验一致，且是后续给它们加 `if`/`retry` 引用的前提。

- [ ] **Step 1: 更新 docs/action.md**

在 `command` 字段表格追加一行：

```
| `capture_output` | 布尔（默认 true）；`false` = 不捕获全量 stdout/stderr，长跑/持续输出 action 用 |
```

在"变量替换"章节末尾补一段：

```markdown
### workflow 中的变量优先级扩展

当 action 被 workflow 引用时，变量优先级变为：

params（step.params）> workflow.env > step.env > config.yaml > 系统环境变量

`stream: llm` action 在 workflow 中运行时，即使 `capture_output: false`，仍会提取结构化 outputs（text/thinking/session_id/cost_usd/total_tokens），因为这些来自 stream-json 语义解析而非原始 stdout 转储。
```

- [ ] **Step 2: 更新 docs/workflow.md**

在"完整字段参考"的 YAML 块中追加 `env`、step 里追加 `id`/`name`/`if`/`env`/`capture_output`：

```yaml
env:                              # 可选：workflow 级默认环境变量，注入所有 step
  KEY: value

steps:
  - id: build                     # 可选：步骤标识，供 outputs/if 引用
    name: 构建                     # 可选：Pipeline Spine 显示文案
    if: steps.prev.outputs.success == 'true'  # 可选：expr 表达式，false → SKIPPED
    action: some-action
    capture_output: true          # 可选：默认 true；false 关闭捕获
    env:                          # 可选：step 级 env，覆盖 workflow.env
      KEY: override
```

新增章节：

```markdown
## step outputs（步骤间数据传递）

每个 step 执行完毕后自动生成 outputs，供后续 step 的 `if` 表达式与 `${{ }}` 引用：

### Layer 1（通用，capture_output=true 时自动填充）

- `steps.<id>.outputs.exit_code`
- `steps.<id>.outputs.stdout`
- `steps.<id>.outputs.stderr`
- `steps.<id>.outputs.success`

### Layer 2（协议，脚本主动写）

stdout 中 `##[output key=value]` 行会被解析为 `steps.<id>.outputs.key`。

### LLM step（stream: llm）

- `outputs.text` / `outputs.thinking` / `outputs.session_id` / `outputs.cost_usd` / `outputs.total_tokens`

## 条件执行（if）

`if` 字段为 expr 表达式（[expr-lang/expr](https://github.com/expr-lang/expr)），支持 `==`/`!=`/`&&`/`||`/`!` 及引擎原生的所有运算符。变量通过点路径引用：

- `steps.<id>.outputs.<key>`
- `env.<KEY>`
- `params.<ID>`
- `config.<KEY>`

`if` 求值为 false → 该 step 状态为 SKIPPED，不执行，不计入 retry/continue_on_error。

**保留字**：`params[].id` 不能是 `steps` / `env` / `params` / `config`。

## workflow.env

workflow 级 `env` 注入所有 step（优先级低于 params、高于 config.yaml）。step 级 `env` 可覆盖同名。

变量引用：`env.KEY`（expr 中）/ `${KEY}`（shell 中，由 runner.Expand 查优先级链）。
```

- [ ] **Step 3: 存量 action YAML — 长跑 action 显式 capture_output: false**

`actions/adb-scrcpy.yaml` 末尾 command 块补字段：

```yaml
command:
  shell: |
    args="--window-title=Scrcpy"
    ...
  timeout: 24h
  capture_output: false          # 投屏持续输出，禁止内存累积
```

`actions/adb-logcat.yaml` 末尾 command 块补字段：

```yaml
command:
  script: ./scripts/adb-logcat
  timeout: 24h
  capture_output: false          # 日志流持续输出
```

- [ ] **Step 4: 存量 workflow YAML — 补 id + name**

`workflows/demo-install-broadcast.yaml` 改为：

```yaml
id: demo-install-broadcast
title: 安装后拉起测试页面
icon: hi:package
description: "安装 APK → 等待 5s → 拉起 DebugActivity"
steps:
  - id: install
    name: 安装 APK
    action: adb-install
  - id: wait
    name: 等待安装落地
    sleep: 5
  - id: launch
    name: 拉起 DebugActivity
    action: adb-debug-activity
```

`workflows/demo-param-echo.yaml` steps 补 id + name：

```yaml
steps:
  - id: echo-params
    name: 回显参数
    shell: echo "msg=${WF_MSG} mode=${WF_MODE} verbose=${WF_VERBOSE} out=${WF_OUTDIR}"
  - id: wait
    name: 等待 2s
    sleep: 2
  - id: progress
    name: 推进输出
    shell: echo "步骤推进：处理完成"
  - id: fail-demo
    name: 演示失败
    shell: Write-Error "演示失败：这是一条 stderr 输出"; exit 1
```

`workflows/xdzs-debug-chain.yaml` steps 补 id + name：

```yaml
steps:
  - id: device-init
    name: 设备初始化
    action: xdzs-device-init
  - id: build
    name: 编译 Debug
    action: xdzs-build-app
    params: { VARIANT: Debug }
  - id: install
    name: 安装 APK
    action: adb-install
  - id: launch
    name: 拉起测试页面
    action: adb-debug-activity
```

- [ ] **Step 5: 创建 demo workflow**

创建 `workflows/demo-if-outputs.yaml`：

```yaml
id: demo-if-outputs
title: "演示: 条件执行与步骤输出"
icon: hi:workflow
description: "展示 step id/outputs/if 条件跳过 + ##[output] 协议 + SKIPPED 状态"

env:
  GREETING: hello

steps:
  - id: produce
    name: 生产数据
    shell: |
      echo "开始执行..."
      echo "##[output build_id=42]"
      echo "完成"

  - id: consume
    name: 消费数据
    if: steps.produce.outputs.exit_code == '0'
    shell: echo "build_id=${{ steps.produce.outputs.build_id }}, greeting=${GREETING}"

  - id: skip-this
    name: 条件跳过
    if: steps.produce.outputs.exit_code == '99'
    shell: echo "这行不会被执行"
```

- [ ] **Step 6: 同步 CLAUDE.md schema 摘要**

在 `CLAUDE.md` 的「动作 YAML（actions/*.yaml）」段落末尾补一句：

```markdown
`command` 新增可选 `capture_output`（布尔，默认 true；false 关闭全量 stdout/stderr 捕获，长跑/持续输出 action 如 scrcpy/logcat 用）。
```

在「工作流 YAML（workflows/*.yaml）」段落改写为：

```markdown
## 工作流 YAML（workflows/*.yaml）

`id` + `title` + `steps` 必填。每个 step 三选一：`action`（引用已有 action id，可用 `params` 覆盖参数）、`shell`（内联 shell 命令，可选 `timeout`）、`sleep`（等待 N 秒）。可选 `id`（步骤标识，供 outputs/if 引用，未写用索引兜底）、`name`（Pipeline Spine 显示文案）、`if`（expr 表达式条件，false → SKIPPED）、`env`（step 级环境变量）、`capture_output`（默认 true）、`retry`（失败重试次数）、`continue_on_error`（失败不中断后续步骤）。workflow 可自带顶层 `env`（注入所有 step，优先级低于 params 高于 config.yaml）与 `params`（同 action 的 ParamSpec，`id` 不可用 `steps`/`env`/`params`/`config` 保留字）。每个 step 执行完自动产出 `outputs`（exit_code/stdout/stderr/success，脚本可用 `##[output key=value]` 追加自定义 key），供后续 step 通过 `${{ steps.<id>.outputs.<key> }}` 或 `if` 表达式引用。校验逻辑在 `workflow.Validate`。

完整字段文档：[docs/workflow.md](docs/workflow.md)。
```

- [ ] **Step 7: 全量构建验证**

```bash
cd /Users/v_chenzhaojun/Documents/workflow-tool
bash deploy/build.sh
```
Expected: 前端 + bindings + 二进制编译成功

- [ ] **Step 8: 手动验收（启动 exe 后运行 demo-if-outputs workflow）**

- Pipeline Spine 应展示 3 个 step，名称为"生产数据"/"消费数据"/"条件跳过"
- 第 1 步成功（绿色/DONE）
- 第 2 步成功，输出含 `build_id=42, greeting=hello`
- 第 3 步灰色虚线 SKIPPED
- 顺带打开 `xdzs-debug-chain` / `demo-install-broadcast` / `demo-param-echo`，确认 Pipeline Spine 上 step 名称显示为新写的中文 name（而非旧的 action id / shell 前缀）

- [ ] **Step 9: Commit**

```bash
git add docs/action.md docs/workflow.md CLAUDE.md \
  actions/adb-scrcpy.yaml actions/adb-logcat.yaml \
  workflows/demo-install-broadcast.yaml workflows/demo-param-echo.yaml \
  workflows/xdzs-debug-chain.yaml workflows/demo-if-outputs.yaml
git commit -m "docs: 同步 action/workflow 文档与 CLAUDE.md，存量 YAML 迁移新字段，新增 demo-if-outputs"
```

---

## Self-Review Checklist

| Spec 要求 | 对应 Task |
|-----------|-----------|
| step id + 索引兜底 | Task 5 schema + Task 7 Executor stepKey |
| step name + Pipeline Spine 显示 | Task 5 schema + Task 9 前端 + Task 10 后端 |
| step if + SKIPPED | Task 6 expr + Task 7 Executor + Task 9 前端 |
| outputs（Layer 1 + Layer 2 协议） | Task 1 + Task 2 |
| capture_output action 字段 | Task 3 |
| LLM 结构化 outputs | Task 4 |
| Session chaining | Task 4 outputs.session_id + Task 7 `${{ }}` Substitute |
| workflow.env 分层 | Task 5 schema + Task 7 Executor resolveEnv/mergeEnv |
| step.env | Task 5 schema + Task 7 mergeEnv |
| expr-lang/expr 引入 | Task 6 |
| 保留字校验 | Task 5 Validate |
| api.go 适配 | Task 8 |
| 文档同步 | Task 11 |
| 向后兼容 | Task 7 Executor（nil baseParams + 空 if + 无 id 兜底索引） |

