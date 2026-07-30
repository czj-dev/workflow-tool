# LLM Action 流式输出 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `claude -p` 类动作加流式输出：YAML `command.stream: llm` 标记 → 后端解析 stream-json 只推 assistant 文本增量 → 前端专用 LLM 视图（nexus-ui MessageMarkdown）流式渲染 markdown。

**Architecture:** registry 加 `Stream` 字段；runner 新增 `parseLLMLine` + `pumpLLM`，`stream=="llm"` 时 stdout 走 stream-json 解析（Shell 执行路径不变）；api 透传 Stream、`ActionItem` 带回、emit 复用 output 事件（`stream:"llm"`）；前端 Provider 加 `llmText` + `view:"llm"`，新 `LlmView`（nexus-ui Message）由 OutputPanel 按 view 渲染。

**Tech Stack:** Go 1.25 + Wails v3.0.0-alpha2.119 + yaml.v3；React 19 + TS + shadcn/ui + nexus-ui（shadcn add 引入，MessageMarkdown 基于 Streamdown）+ Vitest

## Global Constraints

- Wails 版本锁死 `v3.0.0-alpha2.119`，不用 alpha.3。
- `Runner` 接口 `Run(ctx, params, emit)` **不改**。
- 改 `api.go` / `registry` 后必须 `wails3 generate bindings`，否则前端类型不同步。
- `frontend/bindings/` 与 `frontend/dist/` 是 `.gitignore` 忽略的生成产物，不入库。
- 所有代码注释、commit message 用中文。
- 前端测试：`cd frontend && npm test`（jsdom mock 与 i18n 初始化已在 `src/test/setup.ts` 就绪）。
- 后端测试：`go test ./internal/runner ./internal/registry ./internal/api`。
- Windows shell 形态已用 PowerShell（`pwsh`/`powershell -NoProfile -Command`），本计划不改。
- nexus-ui 经 `npx shadcn@latest add @nexus-ui/message` 引入，源码进 `frontend/src/components/nexus-ui/`（非 npm 依赖；`@nexus-ui/*` 在 npm 不存在）。
- stream-json 解析只取 `type:"assistant"` 的 `{"type":"text"}` 块；其他行（system/thinking/result/无法解析）**跳过**（不 emit，避免污染 LLM 视图）。

---

## File Structure

**后端（改/新）：**
- `internal/registry/registry.go`（改）：`Command` 加 `Stream` 字段；`validate` 加 stream 校验。
- `internal/runner/llm.go`（新）：`parseLLMLine(line) (delta string, ok bool)` + `pumpLLM(r, emit, done)`。
- `internal/runner/llm_test.go`（新）：`parseLLMLine` 单测（造假 stream-json 行）。
- `internal/runner/shell_runner.go`（改）：`ShellConfig` 加 `Stream`；`Run` 按 `cfg.Stream` 分流 pump。
- `internal/api/api.go`（改）：`execute` 透传 `Stream`；`ActionItem` 加 `Stream`；`ListActions` 带回。

**前端（改/新）：**
- `frontend/src/context/ActionRunnerProvider.tsx`（改）：加 `llmText` 状态；`runAction` 按 `stream==="llm"` 切 `view="llm"`；output 事件按 `stream==="llm"` 累加 `llmText`；`view` 类型加 `"llm"`。
- `frontend/src/context/ActionRunnerProvider.test.tsx`（改）：补 LLM 事件累加 + view 切换测试。
- `frontend/src/components/LlmView.tsx`（新）：nexus-ui `Message` + `MessageMarkdown` 渲染 `llmText`。
- `frontend/src/components/LlmView.test.tsx`（新）：渲染 `llmText` 测试。
- `frontend/src/components/nexus-ui/`（shadcn add 生成）：message 组件源码。
- `frontend/src/components/OutputPanel.tsx`（改）：加 `view==="llm"` 分支 → `<LlmView />`。

**示例（改）：**
- `actions/claude-ask.yaml`（改）：加 `stream: llm`，shell 把 `--output-format=stream-json --verbose` 放引号外。

---

## Task 1: registry — Command.Stream 字段 + 校验

**Files:**
- Modify: `internal/registry/registry.go`
- Test: `internal/registry/registry_test.go`（追加）

**Interfaces:**
- Produces: `Command.Stream string`（`yaml:"stream"`）；`validate` 对 `stream` ∈ `{""|"llm"}` 校验。

- [ ] **Step 1: 写 registry 测试（stream 解析 + 非法值报错）**

在 `internal/registry/registry_test.go` 末尾追加：

```go
func TestLoadParsesStream(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: a
title: A
command:
  shell: echo hi
  stream: llm
`)
	reg := Load(dir, dir)
	if len(reg.Errors) != 0 {
		t.Fatalf("stream:llm 应合法，got errors: %v", reg.Errors)
	}
	la := reg.Actions["a"]
	if la.Def.Command.Stream != "llm" {
		t.Fatalf("want stream=llm，got %q", la.Def.Command.Stream)
	}
}

func TestValidateBadStream(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: a
title: A
command:
  shell: echo hi
  stream: wat
`)
	reg := Load(dir, dir)
	if len(reg.Errors) == 0 {
		t.Fatal("非法 stream 值应报错")
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
go test ./internal/registry -run Stream
```
预期：FAIL（`Command.Stream` 字段不存在，编译错误）。

- [ ] **Step 3: 改 registry.go — 加 Stream 字段 + 校验**

在 `Command` 结构体加字段：

```go
// Command 是动作的执行块。
type Command struct {
	Shell   string            `yaml:"shell"`
	Script  string            `yaml:"script"`
	Cwd     string            `yaml:"cwd"`
	Timeout string            `yaml:"timeout"`
	Env     map[string]string `yaml:"env"`
	Stream  string            `yaml:"stream"` // "" 普通逐行；"llm" 按 stream-json 解析
}
```

在 `validate` 的 `return nil` 之前加 stream 校验：

```go
	switch def.Command.Stream {
	case "", "llm":
		// 合法
	default:
		return fmt.Errorf("command.stream 非法 %q（应为空或 llm）", def.Command.Stream)
	}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
gofmt -w internal/registry/registry.go && go test ./internal/registry
```
预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add internal/registry
git commit -m "feat(registry): Command.Stream 字段 + 校验（llm 流式标记）"
```

---

## Task 2: runner — parseLLMLine + pumpLLM + Run 分流

**Files:**
- Create: `internal/runner/llm.go`, `internal/runner/llm_test.go`
- Modify: `internal/runner/shell_runner.go`

**Interfaces:**
- Consumes: `EmitFunc`（runner 包已有）。
- Produces: `parseLLMLine(line string) (delta string, ok bool)`、`pumpLLM(r io.Reader, emit EmitFunc, done chan<- struct{})`；`ShellConfig.Stream string`；`Run` 在 `cfg.Stream=="llm"` 时 stdout 走 `pumpLLM`、emit 用 `stream:"llm"`。

- [ ] **Step 1: 写 parseLLMLine 测试**

创建 `internal/runner/llm_test.go`（数据来自 claude v2.1.207 实测的真实 stream-json 行）：

```go
package runner

import "testing"

func TestParseLLMLineAssistantText(t *testing.T) {
	// 真实 assistant text 事件（简化）
	line := `{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"OK"}]}}`
	got, ok := parseLLMLine(line)
	if !ok || got != "OK" {
		t.Fatalf("want (OK,true)，got (%q,%v)", got, ok)
	}
}

func TestParseLLMLineAssistantMultipleTextBlocks(t *testing.T) {
	// 多个 text 块拼接
	line := `{"type":"assistant","message":{"content":[{"type":"text","text":"你好"},{"type":"text","text":"世界"}]}}`
	got, ok := parseLLMLine(line)
	if !ok || got != "你好世界" {
		t.Fatalf("want 拼接 你好世界，got (%q,%v)", got, ok)
	}
}

func TestParseLLMLineAssistantThinkingSkipped(t *testing.T) {
	// thinking 块（无 text）应跳过
	line := `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"思考中..."}]}}`
	got, ok := parseLLMLine(line)
	if ok || got != "" {
		t.Fatalf("thinking 行应跳过，got (%q,%v)", got, ok)
	}
}

func TestParseLLMLineSystemSkipped(t *testing.T) {
	line := `{"type":"system","subtype":"thinking_tokens","estimated_tokens":5}`
	got, ok := parseLLMLine(line)
	if ok || got != "" {
		t.Fatalf("system 行应跳过，got (%q,%v)", got, ok)
	}
}

func TestParseLLMLineResultSkipped(t *testing.T) {
	line := `{"type":"result","subtype":"success","result":"OK","duration_ms":8585}`
	got, ok := parseLLMLine(line)
	if ok || got != "" {
		t.Fatalf("result 行应跳过，got (%q,%v)", got, ok)
	}
}

func TestParseLLMLineGarbageSkipped(t *testing.T) {
	// 非 JSON 行（claude 偶发输出）不崩溃、跳过
	got, ok := parseLLMLine("这不是 JSON")
	if ok || got != "" {
		t.Fatalf("非 JSON 行应跳过，got (%q,%v)", got, ok)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
go test ./internal/runner -run ParseLLMLine
```
预期：FAIL（`parseLLMLine` 未定义）。

- [ ] **Step 3: 实现 llm.go**

创建 `internal/runner/llm.go`：

```go
package runner

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
)

// llmStreamEvent 是 claude stream-json 一行事件的通用结构（只取关心字段）。
type llmStreamEvent struct {
	Type    string `json:"type"`
	Message struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	} `json:"message"`
}

// parseLLMLine 解析 claude stream-json 的一行，提取 assistant 的 text 增量。
// 返回 (delta, true) 表示有文本要显示；(false) 表示该行无 text（system/thinking/result/无法解析），应跳过。
func parseLLMLine(line string) (string, bool) {
	line = strings.TrimSpace(line)
	if line == "" {
		return "", false
	}
	var ev llmStreamEvent
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		return "", false // 无法解析，跳过（不污染 LLM 输出）
	}
	if ev.Type != "assistant" {
		return "", false // system/result 等跳过
	}
	var sb strings.Builder
	for _, c := range ev.Message.Content {
		if c.Type == "text" {
			sb.WriteString(c.Text)
		}
	}
	if sb.Len() == 0 {
		return "", false // assistant 但只有 thinking 块
	}
	return sb.String(), true
}

// pumpLLM 逐行读取 r，按 stream-json 解析，把 assistant text 增量 emit("llm", delta)。
func pumpLLM(r io.Reader, emit EmitFunc, done chan<- struct{}) {
	defer close(done)
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		if delta, ok := parseLLMLine(sc.Text()); ok {
			emit("llm", delta)
		}
	}
}
```

- [ ] **Step 4: 运行 parseLLMLine 测试确认通过**

```bash
go test ./internal/runner -run ParseLLMLine
```
预期：PASS（6 个）。

- [ ] **Step 5: 改 shell_runner.go — ShellConfig.Stream + Run 分流**

`ShellConfig` 加字段：

```go
type ShellConfig struct {
	Shell   string
	Script  string
	Cwd     string
	Timeout time.Duration
	Env     map[string]string
	BaseDir string
	Stream  string // "" 普通逐行；"llm" 走 pumpLLM 解析 stream-json
}
```

`Run` 里把启动 pump 的那段（`go pump(stdoutPipe, "stdout", emit, doneOut)`）改为按 `cfg.Stream` 分流：

```go
	doneOut := make(chan struct{})
	doneErr := make(chan struct{})
	if cfg.Stream == "llm" {
		go pumpLLM(stdoutPipe, emit, doneOut)
	} else {
		go pump(stdoutPipe, "stdout", emit, doneOut)
	}
	go pump(stderrPipe, "stderr", emit, doneErr)
```

（stderr 始终走普通 pump；LLM 模式下 view="llm" 不显示 lines，stderr 警告不污染 LLM 视图。）

- [ ] **Step 6: 运行全部 runner 测试确认通过**

```bash
gofmt -w internal/runner/ && go test ./internal/runner
```
预期：PASS（含 Phase 1 既有 + 新 parseLLMLine 测试；`TestShellRunnerUsesParams` 等不受影响，仍用默认 Stream=""）。

- [ ] **Step 7: 提交**

```bash
git add internal/runner
git commit -m "feat(runner): stream-json 解析（parseLLMLine/pumpLLM）+ Stream 分流"
```

---

## Task 3: api — 透传 Stream + ActionItem.stream + 重生成 bindings

**Files:**
- Modify: `internal/api/api.go`
- Test: `internal/api/api_test.go`（追加）

**Interfaces:**
- Consumes: `registry.Command.Stream`、`runner.ShellConfig.Stream`、`runner.pumpLLM`（Task 1/2 产出）。
- Produces: `execute` 构造 `ShellConfig` 时带 `Stream`；`ActionItem.Stream string`（`json:"stream"`）；`ListActions` 带回；前端 bindings 同步。

- [ ] **Step 1: 写 api 测试（ListActions 带回 stream）**

在 `internal/api/api_test.go` 末尾追加：

```go
func TestListActionsIncludesStream(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	os.WriteFile(filepath.Join(dir, "a.yaml"), []byte(`id: a
title: A
command:
  shell: echo hi
  stream: llm
`), 0644)

	svc := New(registry.Load(dir, dir), dir, cfgPath)
	res := svc.ListActions()
	if len(res.Actions) != 1 {
		t.Fatalf("want 1 action, got %d", len(res.Actions))
	}
	if res.Actions[0].Stream != "llm" {
		t.Fatalf("ListActions 未带回 stream: %+v", res.Actions[0].Stream)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
go test ./internal/api -run Stream
```
预期：FAIL（`ActionItem.Stream` 字段不存在，编译错误）。

- [ ] **Step 3: 改 api.go — ActionItem 加 Stream + execute 透传 + ListActions 带回**

`ActionItem` 加字段：

```go
type ActionItem struct {
	ID          string               `json:"id"`
	Title       string               `json:"title"`
	Icon        string               `json:"icon"`
	Description string               `json:"description"`
	Params      []registry.ParamSpec `json:"params"`
	Presets     []registry.Preset    `json:"presets"`
	Stream      string               `json:"stream"`
}
```

`ListActions` 构造 `ActionItem` 时带上：

```go
		items = append(items, ActionItem{
			ID:          la.Def.ID,
			Title:       la.Def.Title,
			Icon:        la.Def.Icon,
			Description: la.Def.Description,
			Params:      la.Def.Params,
			Presets:     la.Def.Presets,
			Stream:      la.Def.Command.Stream,
		})
```

`execute` 里构造 `ShellConfig` 时带上 `Stream`：

```go
	r := &runner.ShellRunner{Cfg: runner.ShellConfig{
		Shell:   la.Def.Command.Shell,
		Script:  la.Def.Command.Script,
		Cwd:     la.Cwd, // raw，由 runner 用 params 替换
		Timeout: la.Timeout,
		Env:     la.Def.Command.Env,
		BaseDir: s.baseDir,
		Stream:  la.Def.Command.Stream,
	}}
```

- [ ] **Step 4: 运行 api 测试确认通过**

```bash
gofmt -w internal/api/api.go && go test ./internal/registry ./internal/api
```
预期：PASS。

- [ ] **Step 5: 后端整体编译 + 测试**

```bash
go build ./... && go test ./internal/runner ./internal/registry ./internal/api
```
预期：编译通过，测试全绿。

- [ ] **Step 6: 重新生成 bindings（api.go 改了）**

```bash
wails3 generate bindings
```
预期：`frontend/bindings/workflow-tool/internal/api/models.js` 的 `ActionItem` 含 `stream` 字段。

- [ ] **Step 7: 确认 bindings 含 stream 字段**

```bash
grep -n '"stream"' frontend/bindings/workflow-tool/internal/api/models.js | head
```
预期：看到 `this["stream"]` 相关行。

- [ ] **Step 8: 提交（bindings 为生成产物，不入库；只提交后端）**

```bash
git add internal/api
git commit -m "feat(api): ActionItem.stream + execute 透传 Stream（LLM 流式）"
```

---

## Task 4: 前端 Provider — llmText + view="llm" + 事件分流

**Files:**
- Modify: `frontend/src/context/ActionRunnerProvider.tsx`, `frontend/src/context/ActionRunnerProvider.test.tsx`

**Interfaces:**
- Consumes: bindings 的 `ActionItem.stream`（Task 3 重生成）。
- Produces: `RunnerContextValue` 加 `llmText: string`；`view` 类型加 `"llm"`；`runAction` 对 `stream==="llm"` 的 action 设 `view="llm"` + 清空 `llmText`；output 事件 `stream==="llm"` 累加 `llmText`。

- [ ] **Step 1: 扩展测试**

在 `ActionRunnerProvider.test.tsx` 的 `describe` 内追加：

```ts
it("stream=llm 的 output 事件累加到 llmText 并切 view=llm", async () => {
  mockListActions.mockResolvedValue({
    actions: [
      {
        id: "a1", title: "A", icon: "▶", description: "", params: [], presets: [],
        stream: "llm",
      },
    ],
    errors: [],
  });
  const { result } = renderHook(() => useActionRunner(), { wrapper });
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  await act(async () => {
    await result.current.runAction("a1", {});
  });
  expect(result.current.view).toBe("llm");
  act(() => {
    _emitForTest("action:a1:output", { data: { stream: "llm", line: "你好" } });
    _emitForTest("action:a1:output", { data: { stream: "llm", line: "世界" } });
  });
  expect(result.current.llmText).toBe("你好世界");
  // 普通 stream 不进 llmText
  act(() => {
    _emitForTest("action:a1:output", { data: { stream: "stdout", line: "x" } });
  });
  expect(result.current.llmText).toBe("你好世界");
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd frontend && npx vitest run src/context/ActionRunnerProvider.test.tsx
```
预期：FAIL（`llmText` 不存在、`view` 无 "llm"）。

- [ ] **Step 3: 改 ActionRunnerProvider.tsx**

`RunnerContextValue` 加字段 + `view` 加 `"llm"`：

```ts
export interface RunnerContextValue {
  actions: ActionItem[];
  errors: string[];
  currentId: string | null;
  lines: string[];
  status: Status;
  exitInfo: ExitInfo | null;
  globalConfig: Record<string, string>;
  formValues: Record<string, string>;
  view: "output" | "form" | "global" | "llm";
  llmText: string;
  runAction: (id: string, params?: Record<string, any>) => Promise<void>;
  cancel: () => void;
  clearOutput: () => void;
  copyOutput: () => Promise<void>;
  selectPreset: (actionId: string, presetName: string) => void;
  saveGlobalConfig: (kv: Record<string, string>) => Promise<void>;
  setView: (v: "output" | "form" | "global" | "llm") => void;
  setFormValue: (id: string, value: string) => void;
  pickDirectory: () => Promise<string>;
}
```

组件内加 `llmText` 状态（在 `view` state 旁）：

```ts
  const [view, setView] = useState<"output" | "form" | "global" | "llm">("output");
  const [llmText, setLlmText] = useState<string>("");
```

`runAction` 改：根据 action 的 `stream` 决定 view，并清空 llmText：

```ts
  const runAction = async (id: string, params: Record<string, any> = {}) => {
    setLines([]);
    setCurrentId(id);
    setStatus("running");
    setExitInfo(null);
    const action = actions.find((a) => a.id === id);
    if (action?.stream === "llm") {
      setLlmText("");
      setView("llm");
    } else {
      setView("output");
    }
    try {
      await RunAction(id, params);
    } catch (e) {
      setLines((prev) => [...prev, t("error.startFailed") + ": " + e]);
      setStatus("error");
    }
  };
```

`onOutput`（currentId 订阅的回调）按 stream 分流：

```ts
    const onOutput = (e: unknown) => {
      const d = (((e as { data?: unknown })?.data) || {}) as OutputEventData;
      if (d.stream === "llm") {
        setLlmText((prev) => prev + (d.line || ""));
        return;
      }
      const prefix = d.stream === "stderr" ? t("output.stderrPrefix") : "";
      setLines((prev) => [...prev, prefix + (d.line || "")]);
    };
```

`value` 对象加 `llmText`。

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest run src/context/ActionRunnerProvider.test.tsx
```
预期：PASS。

- [ ] **Step 5: 类型与构建校验**

```bash
npm run build
```
预期：tsc -b 无错误。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/context
git commit -m "feat(前端): Provider 加 llmText + view=llm + LLM 事件分流"
```

---

## Task 5: nexus-ui 引入 + LlmView 组件

**Files:**
- Create: `frontend/src/components/LlmView.tsx`, `frontend/src/components/LlmView.test.tsx`
- Generate: `frontend/src/components/nexus-ui/`（shadcn add）

**Interfaces:**
- Consumes: `useActionRunner()` 的 `llmText` + `status`（Task 4）。
- Produces: `<LlmView />` 渲染 `llmText`（nexus-ui Message + MessageMarkdown）。

- [ ] **Step 1: 引入 nexus-ui message 组件**

```bash
cd frontend && npx shadcn@latest add @nexus-ui/message
```
> 若提示选择/确认，按默认确认。该命令把 `message` 组件源码及依赖（含 Streamdown 等）copy 进 `src/components/nexus-ui/`，并自动 `npm install` 所需依赖。若命令失败（registry/网络问题），按 nexus-ui.dev/docs/components/message 页面的源码手动 copy 到 `src/components/nexus-ui/message.tsx`，并 `npm install streamdown` 等其 import 的依赖。

确认生成：
```bash
ls src/components/nexus-ui/
```
预期：看到 `message.tsx`（或 message 目录）。

- [ ] **Step 2: 写 LlmView 测试**

创建 `frontend/src/components/LlmView.test.tsx`：

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn().mockResolvedValue(undefined),
  PickDirectory: vi.fn().mockResolvedValue(""),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => ({}) } }));

import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import { LlmView } from "./LlmView";
import { useEffect } from "react";

// Harness：挂载后塞一段 llmText 并切 llm 视图
function Harness({ text }: { text: string }) {
  const ctx = useActionRunner() as any;
  useEffect(() => {
    ctx.__setLlmTextForTest?.(text);
  }, [text]);
  return <LlmView />;
}

describe("LlmView", () => {
  it("渲染 llmText 文本", async () => {
    render(
      <ActionRunnerProvider>
        <Harness text={"你好，**世界**"} />
      </ActionRunnerProvider>
    );
    expect(await screen.findByText(/你好/)).toBeInTheDocument();
  });
});
```

> 说明：若 nexus-ui MessageMarkdown 在 jsdom 下渲染复杂/报错，改为 mock `./LlmView` 内的 nexus-ui 部分，只断言传入文本。实现（Step 3）若需暴露测试用 setter，按实际调整；最低目标：组件渲染不崩、llmText 文本出现在 DOM。

- [ ] **Step 3: 运行确认失败**

```bash
npx vitest run src/components/LlmView.test.tsx
```
预期：FAIL（`LlmView` 不存在）。

- [ ] **Step 4: 实现 LlmView.tsx**

创建 `frontend/src/components/LlmView.tsx`：

```tsx
import { useActionRunner } from "../hooks/useActionRunner";
import {
  Message,
  MessageContent,
  MessageMarkdown,
} from "@/components/nexus-ui/message";

// LLM 输出区：用 nexus-ui Message 渲染累积的 llmText（MessageMarkdown 基于 Streamdown，流式 markdown）。
export function LlmView() {
  const { llmText, status } = useActionRunner();
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-2 p-4 overflow-auto">
      <Message from="assistant">
        <MessageContent>
          <MessageMarkdown>{llmText}</MessageMarkdown>
        </MessageContent>
      </Message>
      {status === "running" && llmText === "" && (
        <p className="text-sm text-muted-foreground">思考中…</p>
      )}
    </main>
  );
}
```

> import 路径与组件名以 Step 1 实际生成的 `nexus-ui/message` 导出为准（message 组件可能导出 `Message`/`MessageContent`/`MessageMarkdown`，若命名不同按实际调整）。

- [ ] **Step 5: 运行测试确认通过**

```bash
npx vitest run src/components/LlmView.test.tsx
```
预期：PASS。若 nexus-ui 在 jsdom 渲染报错，按 Step 2 说明 mock 掉渲染部分，保留「llmText 文本出现」断言。

- [ ] **Step 6: 构建校验**

```bash
npm run build
```
预期：tsc -b 无错误（注意 `tsconfig` 的路径别名 `@/components/...` 能解析 `nexus-ui/message`）。

- [ ] **Step 7: 提交**

```bash
git add frontend/src/components/LlmView.tsx frontend/src/components/LlmView.test.tsx frontend/src/components/nexus-ui frontend/package.json frontend/package-lock.json
git commit -m "feat(前端): LlmView（nexus-ui Message 流式 markdown 渲染）"
```

> 注：`frontend/src/components/nexus-ui/` 是 copy 进来的源码（非 npm 产物），**入库**（与 `frontend/bindings/`、`frontend/dist/` 不同）。`package.json` 变化（新增 streamdown 等依赖）也入库。

---

## Task 6: OutputPanel view="llm" 分支

**Files:**
- Modify: `frontend/src/components/OutputPanel.tsx`

**Interfaces:**
- Consumes: `<LlmView />`（Task 5）、`view` 含 `"llm"`（Task 4）。
- Produces: `OutputPanel` 在 `view==="llm"` 时渲染 `<LlmView />`。

- [ ] **Step 1: 改 OutputPanel.tsx — 加 llm 分支**

在 `OutputPanel` 顶部 import 加 `LlmView`，并在 `view === "global"` 分支后加 `view === "llm"` 分支：

```tsx
import { Card } from "@/components/ui/card";
import { useActionRunner } from "../hooks/useActionRunner";
import { OutputToolbar } from "./OutputToolbar";
import { OutputConsole } from "./OutputConsole";
import { ParamForm } from "./ParamForm";
import { GlobalConfigEditor } from "./GlobalConfigEditor";
import { LlmView } from "./LlmView";

export function OutputPanel() {
  const { view } = useActionRunner();
  if (view === "global") {
    return (
      <main className="flex min-w-0 flex-1 flex-col">
        <GlobalConfigEditor />
      </main>
    );
  }
  if (view === "llm") {
    return <LlmView />;
  }
  if (view === "form") {
    return (
      <main className="flex min-w-0 flex-1 flex-col">
        <OutputToolbar />
        <ParamForm />
      </main>
    );
  }
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <OutputToolbar />
      <Card className="m-4 flex-1 overflow-hidden p-0">
        <OutputConsole />
      </Card>
    </main>
  );
}
```

- [ ] **Step 2: 构建校验 + 全量测试**

```bash
cd frontend && npm run build && npm test
```
预期：构建通过，测试全绿（既有 OutputPanel.test 测默认 view=output，不受影响）。

- [ ] **Step 3: 提交**

```bash
git add frontend/src/components/OutputPanel.tsx
git commit -m "feat(前端): OutputPanel 加 view=llm 分支（LlmView）"
```

---

## Task 7: 联调 — claude-ask.yaml 加 stream:llm + 全量验证

**Files:**
- Modify: `actions/claude-ask.yaml`

- [ ] **Step 1: 改 claude-ask.yaml — 加 stream:llm + 修正 shell**

把 `actions/claude-ask.yaml` 改为（`--output-format=stream-json --verbose` 在 `"${QUESTION}"` 引号**外**）：

```yaml
id: claude-ask
title: 问 Claude
icon: 🤖
description: 输入问题，Claude（claude -p）流式回答，专用 LLM 视图渲染 markdown
params:
  - id: QUESTION
    label: 问题
    type: text
    required: true
presets:
  - name: 打招呼
    values: { QUESTION: 用一句话介绍你自己 }
command:
  shell: claude -p "${QUESTION}" --output-format=stream-json --verbose
  stream: llm
  timeout: 5m
```

- [ ] **Step 2: 全量构建**

```bash
cd frontend && npm run build && cd .. && go build -o workflow-tool.exe .
```
预期：两步成功。

- [ ] **Step 3: 全部单测回归**

```bash
cd frontend && npm test && cd .. && go test ./internal/runner ./internal/registry ./internal/api
```
预期：前端 + Go 测试全绿。

- [ ] **Step 4: 启动 exe 手动验收**

```bash
./workflow-tool.exe
```

逐项确认：
- [ ] 点「🤖 问 Claude」→ 进表单填问题 → 运行 → 右侧切到 LLM 视图
- [ ] token 逐步流式出现（不再长时间空白后一次性出现）
- [ ] 输出按 markdown 渲染（代码块/列表/标题格式化）
- [ ] 思考过程 / hook / token 计数等噪音**不显示**
- [ ] 普通动作（👋 打个招呼 / 🚀 部署 / 🌐 抓网页）行为不变，仍走终端输出区

- [ ] **Step 5: 提交**

```bash
git add actions/claude-ask.yaml
git commit -m "feat: claude-ask 启用 stream:llm（流式 LLM 输出）"
```

---

## Self-Review 记录

（实现前由计划作者完成；实现者无需操作）

- **Spec 覆盖**：§3 YAML schema → Task 1（Stream 字段+校验）+ Task 7（claude-ask.yaml）；§4 stream-json 解析 → Task 2（parseLLMLine 实测数据驱动）；§5 后端 → Task 1/2/3；§6 前端 → Task 4/5/6；§7 测试 → 各 Task 的 TDD 步；§8 YAGNI → 不涉及实现；§10 验收 → Task 7。全覆盖。
- **偏离 spec 的一处（已合理化）**：spec §5.2 说"无法解析的行降级为原样 emit"，但 LLM 视图只应显示 text，原样 emit JSON 行会污染。Task 2 改为**跳过**非 text 行（parseLLMLine 返回 false 时 pumpLLM 不 emit），更合理；已在 Global Constraints 注明。
- **占位符**：无 TBD/TODO；每步含完整代码或精确命令。Task 5 的 nexus-ui import 命名注明"按实际生成调整"（shadcn add 结果非完全可控，属已知不确定项，给了降级方案：手动 copy + npm install）。
- **类型一致**：`Command.Stream`（registry）→ `ShellConfig.Stream`（runner）→ `ActionItem.Stream`（api/bindings）→ `action.stream`（前端 ActionItem）→ `RunnerContextValue.llmText` + `view:"llm"`，跨层字段名一致；`parseLLMLine(line) (string, bool)` 在 Task 2 定义、Task 2 内 pumpLLM 消费；`runAction` 的 view 分流在 Task 4 定义、Task 6 OutputPanel 消费一致。
