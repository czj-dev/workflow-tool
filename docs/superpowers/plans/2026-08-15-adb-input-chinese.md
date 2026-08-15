# 输入文本支持中文 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `adb-input-text` 动作支持中文：纯 ASCII 走原生 `input text`，含非 ASCII 自动剪贴板桥（`cmd clipboard set` → `input keyevent 279`）。

**Architecture:** 新建 `internal/adb/input` 域子包（与 package/scrcpy 同构），`init()` 自注册 `input-text` operation。纯路由逻辑抽成纯函数便于单测；handler 分两条路径执行。`actions/adb-input-text.yaml` 从 `command.shell` 迁到 `command.adb.operation`。

**Tech Stack:** Go（不依赖 Wails，纯单测）、既有 `adbcore.RunCommand` + `adb.RegisterOperation` 框架。

**Spec:** `docs/superpowers/specs/2026-08-15-adb-input-chinese-design.md`

## Global Constraints

- operation 总数 27 → 28；注册名固定 `input-text`（`^[a-z0-9-]+$`）
- `cmd clipboard` 需 Android 10+；失败 `Retryable: false`，错误信息须含「可安装 ADBKeyboard」提示
- `RESTORE_CLIPBOARD` 恢复前延迟 ~500ms（防粘贴竞态），恢复失败仅告警不判败
- 粘贴键固定 `input keyevent 279`（KEYCODE_PASTE）
- ASCII 路径行为与现状一致：空格转 `%s`
- 改 schema 必须同步 `docs/action.md`；CLAUDE.md 中 operation 计数与目录树也要更新
- 测试不依赖真机/不依赖 Wails：只测纯函数与参数校验分支

---

### Task 1: `internal/adb/input` 域 — 路由纯函数（TDD）

**Files:**
- Create: `internal/adb/input/input.go`
- Test: `internal/adb/input/input_test.go`

**Interfaces:**
- Consumes: 无（纯函数，无依赖）
- Produces:
  - `type inputPlan struct { UseClipboard bool }`
  - `func planInput(text string) inputPlan` — 含非 ASCII/换行/制表符 → `UseClipboard: true`
  - `func escapeForInputText(s string) string` — 空格 → `%s`

- [ ] **Step 1: 写失败测试**

创建 `internal/adb/input/input_test.go`：

```go
package input

import "testing"

func TestPlanInput(t *testing.T) {
	cases := []struct {
		name string
		text string
		clip bool
	}{
		{"pure ascii", "hello", false},
		{"ascii with spaces", "hello world 123", false},
		{"digits and punctuation", "a=b-1_2.3", false},
		{"chinese", "你好", true},
		{"mixed", "abc你好", true},
		{"emoji", "ok👍", true},
		{"newline", "a\nb", true},
		{"carriage return", "a\rb", true},
		{"tab", "a\tb", true},
	}
	for _, c := range cases {
		if got := planInput(c.text); got.UseClipboard != c.clip {
			t.Errorf("%s: planInput(%q).UseClipboard = %v, want %v", c.name, c.text, got.UseClipboard, c.clip)
		}
	}
}

func TestEscapeForInputText(t *testing.T) {
	if got, want := escapeForInputText("hello world"), "hello%sworld"; got != want {
		t.Errorf("escapeForInputText = %q, want %q", got, want)
	}
	if got, want := escapeForInputText("a  b"), "a%s%sb"; got != want {
		t.Errorf("escapeForInputText = %q, want %q", got, want)
	}
	if got, want := escapeForInputText("nospace"), "nospace"; got != want {
		t.Errorf("escapeForInputText = %q, want %q", got, want)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/adb/input/`
Expected: 编译失败 `undefined: planInput` / `undefined: escapeForInputText`

- [ ] **Step 3: 最小实现**

创建 `internal/adb/input/input.go`：

```go
// Package input 是 adb 输入域：input-text operation 按 ASCII / 非 ASCII 路由，
// 含中文等非 ASCII 文本经剪贴板桥输入（input text 命令不支持非 ASCII）。
package input

import "strings"

// inputPlan 是 planInput 的路由结果。
type inputPlan struct {
	UseClipboard bool
}

// planInput 决定输入路径：含非 ASCII（中文/emoji）或控制字符（换行/制表）走
// 剪贴板桥，其余走原生 input text（与历史行为一致）。
func planInput(text string) inputPlan {
	for _, r := range text {
		if r > 127 || r == '\n' || r == '\r' || r == '\t' {
			return inputPlan{UseClipboard: true}
		}
	}
	return inputPlan{}
}

// escapeForInputText 把空格转为 %s（input text 无法直接输入字面空格）。
func escapeForInputText(s string) string {
	return strings.ReplaceAll(s, " ", "%s")
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/adb/input/ -v`
Expected: PASS（TestPlanInput、TestEscapeForInputText）

- [ ] **Step 5: Commit**

```bash
git add internal/adb/input/
git commit -m "feat(adb): input 域路由纯函数——ASCII/非 ASCII 分流与空格转义"
```

---

### Task 2: handler + 剪贴板桥 + operation 注册

**Files:**
- Create: `internal/adb/input/clipboard.go`
- Modify: `internal/adb/input/input.go`（追加 handler、init 注册、runOrFail）
- Modify: `internal/adb/input/input_test.go`（追加空 TEXT 用例）
- Modify: `internal/adb/registration_test.go`（input 域 import + 计数 + 名单）
- Modify: `main.go:19-22`（blank import 区追加一行）

**Interfaces:**
- Consumes: `planInput`/`escapeForInputText`（Task 1）；`adb.OpContext`（`ParamStr`/`ParamBool`/`Adb`/`EmitStdout`/`EmitStderr`）；`adbcore.RunCommand(ctx, ExecRequest) (*ExecResult, error)`；`adbcore.NewOperationError(op, msg, stderr, retryable)`
- Produces: operation `input-text`，params `TEXT`(必填) / `RESTORE_CLIPBOARD`(bool，默认 false)

- [ ] **Step 1: 写失败测试（空 TEXT 报错）**

在 `internal/adb/input/input_test.go` 追加（顶部 import 改为 `"context"` + `"testing"` + `"workflow-tool/internal/adb"`）：

```go
func TestHandleInputTextRequiresText(t *testing.T) {
	op := &adb.OpContext{Ctx: context.Background(), Params: map[string]any{}}
	res := handleInputText(op)
	if res.ExitCode != 2 {
		t.Errorf("ExitCode = %d, want 2", res.ExitCode)
	}
	if res.Err == nil {
		t.Error("expected non-nil Err for empty TEXT")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/adb/input/`
Expected: 编译失败 `undefined: handleInputText`

- [ ] **Step 3: 实现 handler 与剪贴板桥**

在 `internal/adb/input/input.go` 追加（import 区补充 `"workflow-tool/internal/adb"`、`"workflow-tool/internal/adbcore"`）：

```go
func init() {
	adb.RegisterOperation("input-text", handleInputText)
}

// handleInputText 按 planInput 路由：纯 ASCII 走原生 input text（空格转 %s），
// 含非 ASCII 走剪贴板桥。
func handleInputText(op *adb.OpContext) adb.OpResult {
	text := op.ParamStr("TEXT")
	if text == "" {
		return adb.OpResult{ExitCode: 2, Err: adbcore.NewOperationError("input-text", "TEXT is required", "", false)}
	}
	if planInput(text).UseClipboard {
		return runViaClipboard(op, text)
	}
	return runDirect(op, text)
}

// runDirect 原生路径：adb shell input text <escaped>。
func runDirect(op *adb.OpContext, text string) adb.OpResult {
	op.EmitStdout("路径: input text（ASCII）")
	if _, fail := runOrFail(op, "input-text", "input text 执行失败", op.Adb("shell", "input", "text", escapeForInputText(text)), false); fail != nil {
		return *fail
	}
	op.EmitStdout("已输入")
	return adb.OpResult{ExitCode: 0, Stdout: "已输入"}
}

// runOrFail 执行一次 adb ExecRequest（与 package 域同款约定）：
// 非零退出时推送 stderr 并构造结构化 OperationError。
func runOrFail(op *adb.OpContext, opName, failMsg string, req adbcore.ExecRequest, retryable bool) (*adbcore.ExecResult, *adb.OpResult) {
	res, err := adbcore.RunCommand(op.Ctx, req)
	if res == nil {
		return nil, &adb.OpResult{ExitCode: -1, Err: err, Stderr: err.Error()}
	}
	if res.ExitCode != 0 {
		op.EmitStderr(res.Stderr)
		return nil, &adb.OpResult{
			ExitCode: res.ExitCode,
			Stderr:   res.Stderr,
			Err:      adbcore.NewOperationError(opName, failMsg, strings.TrimSpace(res.Stderr), retryable),
		}
	}
	return res, nil
}
```

创建 `internal/adb/input/clipboard.go`：

```go
package input

import (
	"strings"
	"time"

	"workflow-tool/internal/adb"
)

// pasteHint 是剪贴板桥失败时给用户的原因与出路。
const pasteHint = "剪贴板桥需 Android 10+；若目标 App 不响应粘贴键，可安装 ADBKeyboard 输入法替代"

// runViaClipboard 剪贴板桥：cmd clipboard set → input keyevent 279 粘贴 →
// RESTORE_CLIPBOARD=true 时延迟 ~500ms 后恢复原剪贴板（防恢复竞态覆盖粘贴内容）。
func runViaClipboard(op *adb.OpContext, text string) adb.OpResult {
	op.EmitStdout("路径: 剪贴板桥（含非 ASCII）")
	restore := op.ParamBool("RESTORE_CLIPBOARD")

	var backup string
	if restore {
		res, fail := runOrFail(op, "input-text", "读取原剪贴板失败", op.Adb("shell", "cmd", "clipboard", "get"), false)
		if fail != nil {
			return *fail
		}
		backup = strings.TrimRight(res.Stdout, "\r\n")
	}

	if _, fail := runOrFail(op, "input-text", "设置剪贴板失败（"+pasteHint+"）", op.Adb("shell", "cmd", "clipboard", "set", text), false); fail != nil {
		return *fail
	}
	if _, fail := runOrFail(op, "input-text", "触发粘贴失败（"+pasteHint+"）", op.Adb("shell", "input", "keyevent", "279"), false); fail != nil {
		return *fail
	}

	if restore {
		select {
		case <-op.Ctx.Done():
		case <-time.After(500 * time.Millisecond):
		}
		if _, fail := runOrFail(op, "input-text", "恢复剪贴板失败", op.Adb("shell", "cmd", "clipboard", "set", backup), false); fail != nil {
			// 恢复失败不影响输入结果，仅告警。
			op.EmitStderr("警告: 恢复原剪贴板失败（不影响已输入内容）")
		}
	}
	op.EmitStdout("已通过剪贴板输入")
	return adb.OpResult{ExitCode: 0, Stdout: "已通过剪贴板输入"}
}
```

- [ ] **Step 4: 跑包测试确认通过**

Run: `go test ./internal/adb/input/ -v`
Expected: PASS（3 个测试）

- [ ] **Step 5: 注册断言更新**

`internal/adb/registration_test.go` 三处改动：

import 区（第 9-12 行后）追加：

```go
	_ "workflow-tool/internal/adb/input"
```

计数（第 19-20 行）：

```go
	if len(ops) < 28 {
		t.Fatalf("expected at least 28 registered operations, got %d: %v", len(ops), ops)
	}
```

want 名单末尾（scrcpy 段后）追加：

```go
		// input (1)
		"input-text",
```

- [ ] **Step 6: main.go blank import**

`main.go` import 区（`_ "workflow-tool/internal/adb/file"` 一组，按字母序插到 `logcat` 前）：

```go
	_ "workflow-tool/internal/adb/input"
```

- [ ] **Step 7: 跑 adb 域全部测试**

Run: `go test ./internal/adb/... -v`
Expected: 全部 PASS（含 TestOperationsRegistered，28 个 operation）

- [ ] **Step 8: Commit**

```bash
git add internal/adb/input/ internal/adb/registration_test.go main.go
git commit -m "feat(adb): input-text operation——ASCII 走 input text，非 ASCII 剪贴板桥"
```

---

### Task 3: action YAML 迁移 + 文档同步 + 全量验证

**Files:**
- Modify: `actions/adb-input-text.yaml`（整文件替换）
- Modify: `docs/action.md`（scrcpy 表格后追加「输入」小节）
- Modify: `CLAUDE.md`（架构树加 `input/`、operation 计数 27→28）

**Interfaces:**
- Consumes: operation `input-text`（Task 2）
- Produces: 用户可用动作 `adb-input-text`（支持中文）

- [ ] **Step 1: 改写 action YAML**

`actions/adb-input-text.yaml` 整文件替换为：

```yaml
id: adb-input-text
title: 输入文本
icon: hi:text
description: 向设备输入文本；纯英文走 input text，含中文等非 ASCII 自动经剪贴板粘贴（需 Android 10+，个别 App 可能不响应粘贴）
params:
  - id: TEXT
    label: 文本
    type: text
    required: true
  - id: RESTORE_CLIPBOARD
    label: 输入后恢复设备剪贴板
    type: bool
command:
  adb:
    operation: input-text
  timeout: 30s
```

- [ ] **Step 2: docs/action.md 增补**

在 `docs/action.md` scrcpy 小节（`screenshot` 行的表格）之后、`### 示例` 之前插入：

````markdown
**输入（1）**

| operation | params | 说明 |
|---|---|---|
| `input-text` | `TEXT`(text,必填)、`RESTORE_CLIPBOARD`(bool) | 纯 ASCII 走 `input text`（空格转 `%s`）；含中文/emoji/换行自动剪贴板桥（`cmd clipboard set` → `input keyevent 279` 粘贴，需 Android 10+，个别 App 可能不响应粘贴键）；`RESTORE_CLIPBOARD=true` 时粘贴后延迟 ~500ms 恢复原剪贴板（恢复失败仅告警） |
````

- [ ] **Step 3: CLAUDE.md 同步**

`CLAUDE.md` 架构节：

1. 目录树中 `internal/adb/` 的 `binary/` 与 `device/` 之间按字母序插入一行：

```
  ├── input/        文本输入 1 operation（input-text：ASCII 走 input text，非 ASCII 剪贴板桥）
```

2. 「由内置 ADBRunner 分发到 adb 域服务（27 个 operation：包管理/logcat/文件传输/scrcpy）」改为「（28 个 operation：包管理/logcat/文件传输/scrcpy/文本输入）」。

- [ ] **Step 4: 全量验证**

```bash
go test ./internal/runner ./internal/registry ./internal/workflow ./internal/adb/...
bash deploy/build.sh
```

Expected: 测试全绿；build 成功产出单二进制（YAML 由 registry 校验，`adb.operation: input-text` 能通过 `registry.validate`——它只校验 `command.adb.operation` 非空，不查注册表，无需额外改动）。

- [ ] **Step 5: 手动验证（真机，可选但推荐）**

跑 exe，动作面板执行「输入文本」：
- 输 `hello world` → 输出面板显示 `路径: input text（ASCII）`，设备输入框出现 `hello world`
- 输 `你好世界` → 显示 `路径: 剪贴板桥（含非 ASCII）`，设备输入框出现中文
- 勾选恢复剪贴板 → 输入后设备剪贴板回到原内容

- [ ] **Step 6: Commit**

```bash
git add actions/adb-input-text.yaml docs/action.md CLAUDE.md
git commit -m "feat(action): 输入文本支持中文——迁到 input-text operation 并同步文档"
```
