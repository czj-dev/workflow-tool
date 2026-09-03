# logcat 过滤评审整改 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉 2026-09-03 logcat 过滤功能两轴评审中已实测确证的 6 项缺陷与规范欠账，不新增功能。

**Architecture:** 三条真 bug 各自独立收口——后端事件序号改原子递增（`internal/api/events.go`）、非法规则拒绝原因经 Provider 暴露到甲板（一个出口覆盖全部非法输入，不在前端复刻 Go RE2 校验）、草稿 token 在编辑规则时随 committed 一起带回。剩余三项是规范欠账：草稿虚线态、gofmt、文档与 yaml 收敛。

**Tech Stack:** Go 1.25（`internal/api`）、React 19 + TS + vitest + @testing-library/react（`frontend/`）、Wails v3.0.0-alpha2.119 绑定

## Global Constraints

- Wails 锁定 `v3.0.0-alpha2.119`，不升级。
- 本计划**不改任何 `internal/api` Service 方法签名**，因此不需要 `wails3 generate bindings`。若实施中意外改了签名，必须补跑 `bash deploy/build.sh`。
- 前端静态文案只加在 `frontend/src/i18n/locales/{zh,en}.json`，key 为**平铺字符串**（形如 `"logcat.filterRejected"`，不是嵌套对象）。
- 后端 stdout/stderr 文案不参与 i18n，直接透出原文。
- gofmt/goimports 强制（`~/.claude/rules/ecc/golang/coding-style.md`）。
- 函数 <50 行、文件 <800 行。`LogcatView.tsx` 当前 812 行已超标，本计划**不拆分它**（超出范围），但新增代码必须控制净增量，Task 4 会删掉一段死代码抵消。
- 不做 `git commit` 以外的 git 操作：不建分支、不 push、不 amend。
- 每个 Task 结束时工作区必须干净（无临时文件残留）。

## File Structure

| 文件 | 责任 | 本计划中的动作 |
|---|---|---|
| `internal/api/events.go` | action/workflow 事件名、payload、seq 顺序协议 | 修改：`seq` 改 `atomic.Int64`，抽 `nextSeq()` |
| `internal/api/events_test.go` | 事件协议单测 | **新建**：seq 并发唯一性 |
| `frontend/src/context/ActionRunnerProvider.tsx` | 唯一状态中枢，含 logcat 规则防抖下发 | 修改：加 `logcatFilterError` 状态与清空时机 |
| `frontend/src/context/ActionRunnerProvider.test.tsx` | Provider 行为回归 | 修改：加拒绝可见性用例 |
| `frontend/src/components/LogcatView.tsx` | logcat 两行控制甲板 + 日志区 | 修改：草稿保留、错误气泡、草稿虚线框、删死代码 |
| `frontend/src/components/LogcatView.test.tsx` | 甲板交互回归 | **新建**：草稿保留、草稿虚线态 |
| `frontend/src/i18n/locales/{zh,en}.json` | 前端文案 | 修改：加 `logcat.filterRejected` |
| `docs/action.md` | 面向使用者的 action schema 参考 | 修改：纠正「双层过滤」、补 `link` 语义 |
| `actions/adb-logcat-stream.yaml` | logcat 流式动作定义 | 修改：删「测试表单」preset |

Task 1 只碰 Go，Task 2-4 依次叠加改前端（必须按序，都动 `LogcatView.tsx`），Task 5-6 是独立收尾。

---

### Task 1: 事件序号 seq 改原子递增

**背景（为什么这是 bug）：** `internal/api/events.go:33-35` 的注释断言「并发安全依赖 runner.Run 的串行回调契约，seq 递增无需自行加锁」。这个前提在 `logcat-stream` 下不成立——该 operation 从三个 goroutine 调 emit：flush ticker 协程（`internal/adb/logcat/stream.go:90`）、控制协程的拒绝告警（`stream.go:189`）、`pidRefresher` 的包未运行告警（`stream.go:408`）。后两者在 `core.mu` 之外，与 flush 真正并发。真机 `-race` 已实测抓到该 race。后果不只是 race 本身：前端 `ActionRunnerProvider.tsx:284-292` 的 seqGate 依赖 seq 唯一有序来保证 `logcat-replace` head 帧的清空晚于旧增量帧、早于自己的 chunk，seq 重号会让门卡住或丢帧。

**Files:**
- Modify: `internal/api/events.go:23-48`
- Create: `internal/api/events_test.go`

**Interfaces:**
- Consumes: 无（本任务是起点）
- Produces: `func (e *actionEvents) nextSeq() int64` —— 供 `EmitFunc`/`Done` 取号；`actionEvents.seq` 字段类型变为 `atomic.Int64`（该结构体因此不可复制，现有代码全部经 `newActionEvents` 返回指针，无需改动调用方）

- [ ] **Step 1: 写失败测试**

创建 `internal/api/events_test.go`：

```go
package api

import (
	"sync"
	"testing"
)

// seq 必须原子递增：logcat-stream 的 emit 来自多个 goroutine（stream.go 的
// flush ticker 协程、控制协程的拒绝告警、pidRefresher 的包未运行告警），
// 「runner.OnLine 串行回调」这个前提在该 operation 下不成立。前端 seqGate
// 依赖 seq 唯一有序，重号会让 logcat-replace 的 head 帧错序。
func TestActionEventsSeqIsAtomic(t *testing.T) {
	const goroutines, perG = 8, 500
	ev := &actionEvents{}
	got := make([][]int64, goroutines)
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			out := make([]int64, 0, perG)
			for i := 0; i < perG; i++ {
				out = append(out, ev.nextSeq())
			}
			got[g] = out
		}(g)
	}
	wg.Wait()

	seen := make(map[int64]bool, goroutines*perG)
	for _, out := range got {
		for _, s := range out {
			if seen[s] {
				t.Fatalf("seq %d 重号：并发取号未原子化", s)
			}
			seen[s] = true
		}
	}
	if len(seen) != goroutines*perG {
		t.Fatalf("期望 %d 个唯一 seq，实际 %d", goroutines*perG, len(seen))
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test -race ./internal/api -run TestActionEventsSeqIsAtomic`
Expected: 编译失败，`ev.nextSeq undefined (type *actionEvents has no field or method nextSeq)`

- [ ] **Step 3: 实现**

在 `internal/api/events.go` 的 import 块加 `"sync/atomic"`（放在标准库分组，与 `"time"` 同组）。

把 `actionEvents` 结构体与注释（当前 17-43 行）整段替换为：

```go
// actionEvents 封装单个 action 的事件通道（action:<id>:output / action:<id>:done）。
//
// 顺序协议（前端契约）：Wails 的 Event.Emit 每次调用都各自起一个 goroutine 投递
// （application/events.go），事件到达前端的顺序无保证。action 是单一输出桶，
// 每条 output 自带递增 seq，done 事件带 seq+1 延续同一序号空间，前端按 seq 排序
// 还原真实产出顺序——done 若抢跑到还没到达的 output 前面，退出码行会被插错位置。
type actionEvents struct {
	app *application.App
	id  string
	seq atomic.Int64
}

func newActionEvents(app *application.App, id string) *actionEvents {
	return &actionEvents{app: app, id: id}
}

// nextSeq 取下一个事件序号。必须原子：emit 并非总是串行回调——logcat-stream 从
// flush ticker 协程、控制协程（规则拒绝告警）、pidRefresher（包未运行告警）三处
// 并发 emit（internal/adb/logcat/stream.go:90/189/408），后两处在 core.mu 之外。
// 前端 seqGate 依赖 seq 唯一有序来定 logcat-replace 帧与增量帧的先后。
func (e *actionEvents) nextSeq() int64 { return e.seq.Add(1) }

// EmitFunc 返回 runner 用的 emit：每行 output 自带递增 seq。
func (e *actionEvents) EmitFunc() runner.EmitFunc {
	return func(stream, line string) {
		e.app.Event.Emit(eventName(e.id, "output"), map[string]any{
			"stream": stream, "line": line, "seq": e.nextSeq(),
		})
	}
}
```

再把 `Done`（当前 46-48 行）里的 `e.seq+1` 改为 `e.seq.Load()+1`：

```go
// Done 发送结束事件，seq 接续最后一条 output（seq+1），前端按序应用退出码行。
func (e *actionEvents) Done(exitCode int, errMsg string, d time.Duration, readout map[string]any) {
	e.emitDone(exitCode, errMsg, d, readout, e.seq.Load()+1)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test -race ./internal/api`
Expected: `ok  workflow-tool/internal/api`（全部用例通过，无 DATA RACE 告警）

Run: `go build ./...`
Expected: 无输出（`actionEvents` 含 atomic 后不可复制，此步确认没有值传递的调用点）

- [ ] **Step 5: 提交**

```bash
git add internal/api/events.go internal/api/events_test.go
git commit -m "fix(api): action 事件 seq 改原子递增，logcat-stream 多协程 emit 不再重号"
```

---

### Task 2: 后端拒绝非法过滤规则时给出可见提示

**背景（为什么这是 bug）：** `internal/api/run.go:64` 会同步校验规则并返回 error，这一层是对的。但 `ActionRunnerProvider.tsx:390` 的 `.catch(() => {…})` 把错误整个吞掉，而 `LogcatView.tsx` 全文不渲染 stderr 通道——所以后端 `stream.go:189` 那条 warning 用户也看不到。实测表现：chip 挂在过滤条上，过滤却停在旧规则，零反馈。

触发路径有三条，共用这一个出口：
1. `pid:abc` / `tid:x1` —— `parseToken` 不校验整数（`logcatRule.ts:44` 只把 op 归一 exact），`commitInput` 的唯一闸门只试编译正则；
2. JS 合法但 Go RE2 不支持的正则 —— 实测 `(?=foo)`、`(?!foo)`、`(?<=foo)`、`(a)\1` 四个前端 `invalidRegex` 全部放行，后端全部拒绝；
3. 手写 `FILTER` preset 里的未知 key / 未知 link。

**故意不做**（YAGNI + 避免双实现漂移）：不在前端复刻 RE2 子集校验、不加 pid 整数校验。后端是权威校验方，把它的拒绝原因显示出来，一个出口覆盖三条路径。

**Files:**
- Modify: `frontend/src/context/ActionRunnerProvider.tsx`（context 类型 128-139 附近、state 269-275 附近、防抖 effect 384-398、三处 logcat 重置块 810-818 / 949-954 / 1186-1189、context value 出口 1224 附近）
- Modify: `frontend/src/components/LogcatView.tsx:187-202`（解构）与 `:678-682`（错误气泡）
- Modify: `frontend/src/i18n/locales/zh.json`、`frontend/src/i18n/locales/en.json`
- Test: `frontend/src/context/ActionRunnerProvider.test.tsx`

**Interfaces:**
- Consumes: 无（不依赖 Task 1）
- Produces: `RunnerContextValue.logcatFilterError: string` —— 空串 = 无错误；非空 = 后端最近一次拒绝的原因原文。Task 3/4 的 `LogcatView.test.tsx` 不依赖它，但 `LogcatView` 的解构列表在 Task 2 后包含它。

- [ ] **Step 1: 写失败测试**

在 `frontend/src/context/ActionRunnerProvider.test.tsx` 里，紧接现有的「规则编辑 300ms 防抖下发 UpdateLogcatFilter」用例之后插入：

```tsx
  // 回归：后端拒绝非法规则时必须暴露原因。原先 .catch 静默吞掉、logcat 视图又不
  // 渲染 stderr，表现为 chip 在、过滤停在旧规则、零反馈（pid:abc、Go RE2 不支持
  // 的正则如 (?=x)、手写 FILTER 的未知 key 都走这一条出口）。
  it("UpdateLogcatFilter 被拒时暴露 logcatFilterError，下一次成功下发后清空", async () => {
    vi.useFakeTimers();
    try {
      mockListActions.mockResolvedValue({
        actions: [
          { id: "a1", title: "A", icon: "", description: "", params: [], presets: [], stream: "logcat" },
        ],
        errors: [],
      });
      mockUpdateLogcatFilter.mockRejectedValueOnce(
        new Error('非法过滤规则: token[0]: pid value must be an integer, got "abc"'),
      );
      const { result } = renderHook(() => useActionRunner(), { wrapper });
      await act(() => Promise.resolve());
      await act(async () => {
        await result.current.runAction("a1", {});
      });
      expect(result.current.logcatFilterError).toBe("");

      act(() => {
        result.current.setLogcatRule({
          tokens: [{ key: "pid", op: "exact", negated: false, value: "abc" }],
          minLevel: "V",
          package: "",
        });
      });
      // advanceTimersByTimeAsync：既要跑掉 300ms 防抖，也要让被拒的 promise 落地
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(result.current.logcatFilterError).toContain("must be an integer");

      act(() => {
        result.current.setLogcatRule({
          tokens: [{ key: "pid", op: "exact", negated: false, value: "1234" }],
          minLevel: "V",
          package: "",
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(result.current.logcatFilterError).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/context/ActionRunnerProvider.test.tsx -t "被拒时暴露"`
Expected: FAIL —— TS 报 `Property 'logcatFilterError' does not exist on type 'RunnerContextValue'`（或运行时断言 `expected undefined to be ""`）

- [ ] **Step 3: 实现**

**3a. Provider —— context 类型。** 在 `RunnerContextValue` 里 `logcatReplaceSeq: number;` 那一行之后加：

```ts
  // 后端最近一次拒绝过滤规则的原因（空串 = 无错误）。非法正则由前端固化闸门拦，
  // 但 pid 非整数 / Go RE2 不支持的正则 / 手写 FILTER 的未知 key 只有后端能判，
  // 拒绝原因必须回到甲板，否则用户看到 chip 在、过滤不变、毫无线索。
  logcatFilterError: string;
```

**3b. Provider —— state。** 在 `const [logcatReplaceSeq, setLogcatReplaceSeq] = useState(0);` 之后加：

```ts
  const [logcatFilterError, setLogcatFilterError] = useState("");
```

**3c. Provider —— 防抖 effect。** 把 `UpdateLogcatFilter(id, toApiRule(logcatRule), false).catch(...)` 整个调用（当前 390-395 行）替换为：

```ts
      UpdateLogcatFilter(id, toApiRule(logcatRule), false)
        .then(() => setLogcatFilterError(""))
        .catch((e: unknown) => {
          // 下发失败（非法规则被后端拒 / 控制通道积压）：撤回 synced 登记，否则该规则
          // 被永久当作「已同步」，用户必须改成另一个规则才会再下发（表现为改了不生效）。
          if (logcatRuleSyncedRef.current === logcatRule)
            logcatRuleSyncedRef.current = null;
          setLogcatFilterError(e instanceof Error ? e.message : String(e));
        });
```

**3d. Provider —— 三处重置块。** 在下列三处已有的 logcat 状态重置块里各加一行 `setLogcatFilterError("");`（跟在 `setLogcatReplaceSeq(0);` 之后）：`focusRunning` 的重置块（约 810-818 行）、`runAction` 的重置块（约 949-954 行）、`clearLogcat`（约 1186-1189 行）。

**3e. Provider —— context value 出口。** 在 `logcatReplaceSeq,` 那一行之后加 `logcatFilterError,`。

**3f. i18n。** `frontend/src/i18n/locales/zh.json` 在 `"logcat.regexError"` 之后加一行：

```json
  "logcat.filterRejected": "规则被后端拒绝: {{reason}}",
```

`frontend/src/i18n/locales/en.json` 同一位置加：

```json
  "logcat.filterRejected": "Rule rejected by backend: {{reason}}",
```

**3g. LogcatView —— 取值。** 在 `useActionRunner()` 的解构列表里，`logcatReplaceSeq,` 之后加 `logcatFilterError,`。

**3h. LogcatView —— 错误气泡。** 把当前 678-682 行的 `{regexErr && (…)}` 整块替换为（三个来源共用一个气泡位，文案各自独立）：

```tsx
        {/* 错误气泡三源：前端固化闸门的非法正则、剪贴板失败、后端拒绝规则的原因
            （最后一条是 pid 非整数 / RE2 不支持的正则 / 手写 FILTER 未知 key 的唯一可见出口）。 */}
        {(regexErr || copyErr || logcatFilterError) && (
          <span className="absolute bottom-full right-3 mb-1 max-w-[70%] truncate rounded bg-destructive px-1.5 py-0.5 text-[10px] text-white">
            {regexErr || copyErr || t("logcat.filterRejected", { reason: logcatFilterError })}
          </span>
        )}
```

**3i. Provider —— 另外两处同样静默的下发点。** 除防抖 effect 外，`UpdateLogcatFilter` 还有两个调用点也在空吞错误，必须一起改，否则「清空」与「回到运行中的 logcat 动作」两条路径仍然无声。

`focusRunning` 里的重放请求（约 920 行）：

```ts
      // 用恢复的规则触发一次后端整体重放：把切走期间丢失的单缓冲条目从 raw ring 找回。
      UpdateLogcatFilter(id, toApiRule(rule), false)
        .then(() => setLogcatFilterError(""))
        .catch((e: unknown) =>
          setLogcatFilterError(e instanceof Error ? e.message : String(e)),
        );
```

`clearLogcat` 里的清空联动（约 1191 行）：

```ts
    if (currentId && runningIdsRef.current.has(currentId)) {
      UpdateLogcatFilter(currentId, toApiRule(logcatRule), true).catch((e: unknown) =>
        setLogcatFilterError(e instanceof Error ? e.message : String(e)),
      );
    }
```

注意 `clearLogcat` 这里**不要**加 `.then(() => setLogcatFilterError(""))`——3d 已经让它先把错误清空了，成功路径无需再清。

**3j. LogcatView —— 复制失败也别静默。** `onCopy`（当前 406-411 行）的 `navigator.clipboard.writeText` 无 catch，权限被拒时整个操作无声失败。**用组件本地状态承载，不要复用 `logcatFilterError`**——那条通道的气泡文案是「规则被后端拒绝: …」，套到剪贴板错误上就是错的文案。

在 `const [regexErr, setRegexErr] = useState("");`（当前 206 行）旁边加一行：

```tsx
  const [copyErr, setCopyErr] = useState("");
```

`onCopy` 替换为：

```tsx
  const onCopy = async () => {
    const text = logcatEntries.map(entryToText).join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch (e: unknown) {
      // 剪贴板被系统/浏览器拒绝时给出可见反馈（气泡位共用，文案独立）
      setCopyErr(e instanceof Error ? e.message : String(e));
      return;
    }
    setCopyErr("");
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
```

因此 3g 的解构列表**只**新增 `logcatFilterError,`，Provider 不需要向外暴露 setter。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/context/ActionRunnerProvider.test.tsx`
Expected: 全部用例 PASS（含新增的「被拒时暴露」）

Run: `cd frontend && npm run typecheck && npm run lint`
Expected: 均无错误

- [ ] **Step 5: 提交**

```bash
git add frontend/src/context/ActionRunnerProvider.tsx frontend/src/context/ActionRunnerProvider.test.tsx frontend/src/components/LogcatView.tsx frontend/src/i18n/locales/zh.json frontend/src/i18n/locales/en.json
git commit -m "fix(logcat): 后端拒绝过滤规则的原因回到甲板，不再静默吞掉"
```

---

### Task 3: 草稿 token 不再被 committed 改写吞掉

**背景（为什么这是 bug）：** `LogcatView.tsx:225-228` 的 `committed` 剔除 draft，而 `:229-230` 的 `setTokens` 只把 committed 写回 `tokens`。于是用户输入 `tag:foo`（未敲空格固化）后，任何走 committed 的操作——点行内 tag/pid（`:727`/`:757`）、top-4 快捷条（`:654`）、chip 菜单（`:304`）、空输入 Backspace（`:636`）——都会让草稿条件从规则里蒸发，过滤随之放宽，而输入框文字还在，用户看着以为仍生效。已用复刻编辑内核的测试复现。违背 spec:78「草稿随防抖即时生效」。

修法是一处：`setTokens` 把当前 drafts 带回去。草稿在 `onInputChange` 里恒定追加在 tokens 尾部，所以 committed 的索引语义不变，menuIdx / map / filter 全部照旧。

**Files:**
- Modify: `frontend/src/components/LogcatView.tsx:224-231`
- Create: `frontend/src/components/LogcatView.test.tsx`

**Interfaces:**
- Consumes: `RunnerContextValue.logcatFilterError`（Task 2 产出，本任务的解构列表里已有，不新增）
- Produces: `LogcatView.test.tsx` 里的 `startWithEntries(entries: LogcatEntry[]): Promise<void>` 与 `entry(over?: Partial<LogcatEntry>): LogcatEntry` 两个 helper —— Task 4 的用例直接复用

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/components/LogcatView.test.tsx`：

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockListActions, mockRunAction, mockUpdateLogcatFilter, mockOn } = vi.hoisted(() => {
  const listeners: Record<string, (e: unknown) => void> = {};
  return {
    mockListActions: vi.fn(),
    mockRunAction: vi.fn(() => Promise.resolve()),
    mockUpdateLogcatFilter: vi.fn(
      (_id: string, _rule: unknown, _reset: boolean) => Promise.resolve(),
    ),
    mockOn: vi.fn((name: string, cb: (e: unknown) => void) => {
      listeners[name] = cb;
      return () => {
        delete listeners[name];
      };
    }),
  };
});

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: mockListActions,
  RunAction: mockRunAction,
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn().mockResolvedValue(undefined),
  GetFragments: vi.fn().mockResolvedValue([]),
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: vi.fn().mockResolvedValue(undefined),
  PickDirectory: vi.fn().mockResolvedValue(""),
  PickFile: vi.fn().mockResolvedValue(""),
  GetActionYaml: vi.fn().mockResolvedValue(""),
  SetActionYaml: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
  UpdateLogcatFilter: mockUpdateLogcatFilter,
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { ActionRunnerProvider, _emitForTest } from "../context/ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import { LogcatView } from "./LogcatView";
import type { LogcatEntry } from "../types/events";
```

（接下一段，同一文件）

```tsx
// harness：组件测试里没有 result.current，用它把 context 暴露给测试
let runner: ReturnType<typeof useActionRunner> | null = null;
function Harness() {
  runner = useActionRunner();
  return <LogcatView />;
}

const entry = (over: Partial<LogcatEntry> = {}): LogcatEntry => ({
  date: "09-03",
  time: "17:08:42.780",
  pid: 4321,
  tid: 4321,
  level: "I",
  tag: "AudioEffect",
  message: "cmdCode = 65536",
  ...over,
});

// 启动 logcat 动作并用 replace head 帧注入日志行：head 帧直接落 state
// （applyLogcatReplace），绕开 Provider 那个 120ms 增量定时器，省掉 fake timer。
async function startWithEntries(entries: LogcatEntry[]) {
  mockListActions.mockResolvedValue({
    actions: [
      { id: "a1", title: "Logcat", icon: "", description: "", params: [], presets: [], stream: "logcat" },
    ],
    errors: [],
  });
  render(
    <ThemeProvider>
      <ActionRunnerProvider>
        <SidebarProvider>
          <Harness />
        </SidebarProvider>
      </ActionRunnerProvider>
    </ThemeProvider>,
  );
  await act(() => Promise.resolve());
  await act(async () => {
    await runner!.runAction("a1", {});
  });
  act(() => {
    _emitForTest("action:a1:output", {
      data: {
        stream: "logcat-replace",
        line: JSON.stringify({
          head: true,
          entries,
          matched: entries.length,
          total: entries.length,
          tagHistogram: {},
        }),
      },
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  runner = null;
});

describe("LogcatView 控制甲板", () => {
  // 回归：草稿 token（未敲空格固化的输入）不能被走 committed 的编辑吞掉。
  // 原实现 setTokens 只写 committed，点行内 pid 会让正在输入的条件从规则里蒸发，
  // 输入框文字却还在——看着仍生效，实际过滤已放宽。
  it("未固化的草稿在点击行内 pid 后仍留在规则里", async () => {
    const user = userEvent.setup();
    await startWithEntries([entry()]);

    const input = screen.getByPlaceholderText(/裸词/);
    await user.type(input, "tag:foo");
    await user.click(screen.getByTitle("点击：只看此进程"));

    expect(input).toHaveValue("tag:foo");
    await vi.waitFor(() =>
      expect(mockUpdateLogcatFilter).toHaveBeenLastCalledWith(
        "a1",
        {
          tokens: [
            { key: "pid", op: "exact", negated: false, value: "4321", link: "" },
            { key: "tag", op: "contains", negated: false, value: "foo", link: "" },
          ],
          minLevel: "V",
          package: "",
        },
        false,
      ),
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/components/LogcatView.test.tsx`
Expected: FAIL —— 最后一次下发只有 `pid` 一个 token（草稿 `tag:foo` 已被丢弃），断言 diff 显示 tokens 数组缺第二项

- [ ] **Step 3: 实现**

把 `LogcatView.tsx` 当前 224-231 行（`committed` memo 与 `setTokens`）整段替换为：

```tsx
  // 固化 chips = 规则里非草稿 token；草稿尾巴由 input 文本派生并即时并入规则。
  const committed = useMemo(
    () => logcatRule.tokens.filter((tk) => !tk.draft),
    [logcatRule],
  );
  // 草稿 token（onInputChange 派生，恒在 tokens 尾部）。setTokens 必须把它们带回，
  // 否则任何走 committed 的编辑（行内 toggle / 快捷条 / chip 菜单 / Backspace）
  // 都会把正在输入的条件静默丢掉：输入框文字还在，过滤却已放宽。
  const drafts = useMemo(
    () => logcatRule.tokens.filter((tk) => tk.draft),
    [logcatRule],
  );
  const setTokens = (next: LogcatToken[]) =>
    setLogcatRule({ ...logcatRule, tokens: [...next, ...drafts] });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/components/LogcatView.test.tsx`
Expected: PASS（1 个用例）

Run: `cd frontend && npx vitest run src/lib/logcatRule.test.ts src/context/ActionRunnerProvider.test.tsx && npm run typecheck`
Expected: 全部 PASS，typecheck 无错误

- [ ] **Step 5: 提交**

```bash
git add frontend/src/components/LogcatView.tsx frontend/src/components/LogcatView.test.tsx
git commit -m "fix(logcat): 编辑固化条件时不再丢掉正在输入的草稿 token"
```

---

### Task 4: 草稿呈虚线 chip 形态，删掉不可达的 draft 分支

**背景（为什么这是规范欠账）：** spec:78 要求「未固化文本以虚线边框 chip 形态呈现（看得见它已参与过滤、也看得见未定稿）」。`Chip` 组件确实有 `tok.draft` 的虚框分支（`LogcatView.tsx:111`），但 `segs`（`:336-366`）只由 committed 构建，draft 永远进不了 `Chip`——该分支是死代码，草稿目前只以输入框纯文本呈现，看不出它已参与过滤。

实现选择：让**输入框本身**成为那个虚线 chip，而不是把草稿文本再画一个 `Chip`。理由是草稿文本正躺在 input 里，另画一个等于同一段文本渲染两遍；而且把 draft 塞进 `segs` 会打乱 committed 的索引体系（menuIdx / setTokens 全部按 committed 下标寻址）。顺带删掉 `Chip` 里那个不可达的分支。

**Files:**
- Modify: `frontend/src/components/LogcatView.tsx:108-113`（删 draft 分支）、`:624-626`（输入框容器）
- Test: `frontend/src/components/LogcatView.test.tsx`

**Interfaces:**
- Consumes: Task 3 产出的 `startWithEntries` / `entry` helper
- Produces: 无（纯样式收口）

- [ ] **Step 1: 写失败测试**

在 `LogcatView.test.tsx` 的 `describe("LogcatView 控制甲板", …)` 块内，紧接上一个用例之后加：

```tsx
  // spec:78 草稿态：未固化文本要以虚线边框 chip 形态呈现。输入框本身就是那个
  // 虚线 chip——不另画 Chip，避免同一段文本渲染两遍。
  it("有未固化文本时输入框呈虚线 chip 形态", async () => {
    const user = userEvent.setup();
    await startWithEntries([entry()]);

    const input = screen.getByPlaceholderText(/裸词/);
    const shell = input.parentElement!;
    expect(shell.className).toContain("border-transparent");
    expect(shell.className).not.toContain("border-dashed");

    await user.type(input, "tag:foo");
    expect(shell.className).toContain("border-dashed");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/components/LogcatView.test.tsx -t "虚线 chip 形态"`
Expected: FAIL —— `expected 'flex min-w-40 flex-1 items-center' to contain 'border-transparent'`

- [ ] **Step 3: 实现**

**4a. 输入框容器。** 把当前 624-626 行的开标签

```tsx
        <span className="flex min-w-40 flex-1 items-center">
          <input
```

替换为：

```tsx
        {/* 草稿态（spec:78）：未固化文本本身就是那个虚线 chip——虚线同时表达
            「已参与过滤」与「未定稿」；不另画 Chip，避免同一段文本渲染两遍。 */}
        <span
          className={`flex min-w-40 flex-1 items-center rounded border px-1 ${
            input.trim()
              ? "border-dashed border-border bg-secondary/60"
              : "border-transparent"
          }`}
        >
          <input
```

**4b. 删 Chip 里不可达的 draft 分支。** 把当前 109-113 行

```tsx
      <span
        className={`inline-flex max-w-64 items-center gap-0.5 rounded border bg-secondary/60 px-1.5 py-0.5 ${
          tok.draft ? "border-dashed border-border opacity-80" : "border-border"
        }`}
      >
```

替换为：

```tsx
      {/* 只渲染固化 token：草稿不进 segs，虚线态由输入框自身承担（见行 2 控制台） */}
      <span className="inline-flex max-w-64 items-center gap-0.5 rounded border border-border bg-secondary/60 px-1.5 py-0.5">
```

同时把 `Chip` 上方注释（当前 84-86 行）末尾一句改为：「菜单项数组驱动（link 项仅正向非首个 chip 出现），保持 negate/regex/link/delete 顺序；只处理固化 token。」

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/components/LogcatView.test.tsx`
Expected: PASS（2 个用例）

Run: `cd frontend && npm run typecheck && npm run lint && npm test -- --run`
Expected: typecheck/lint 无错误；测试仅 `YamlEditor.test.tsx` 的 2 个既有失败（与本计划无关，勿修），其余全绿

- [ ] **Step 5: 提交**

```bash
git add frontend/src/components/LogcatView.tsx frontend/src/components/LogcatView.test.tsx
git commit -m "feat(logcat): 草稿输入呈虚线 chip 形态，删掉 Chip 不可达的 draft 分支"
```

---

### Task 5: gofmt 全仓库归零

**背景：** `~/.claude/rules/ecc/golang/coding-style.md` 写明「gofmt and goimports are mandatory」。实测 `gofmt -l` 命中 9 个文件，其中本次评审范围内的是 `internal/adb/logcat/rule.go`（`combo` 结构体字段未对齐、`Allow` 里 `break` 缩进错）与 `rule_test.go`；其余 7 个是历史欠账，一并处理（同一条命令，无额外风险）。

本任务没有可写的失败测试——格式化不是行为。用「命令输出从非空变为空」当红/绿。

**Files:**
- Modify: `gofmt -l` 列出的全部 `.go` 文件（预期 9 个：`internal/actionrun/build.go`、`internal/adb/foreground/format.go`、`internal/adb/logcat/rule.go`、`internal/adb/logcat/rule_test.go`、`internal/adb/runner_test.go`、`internal/api/api_test.go`、`internal/runner/llm.go`、`internal/runner/llm_runner.go`、`internal/runner/llm_test.go`）

**Interfaces:**
- Consumes: 无
- Produces: 无（纯格式化，零行为变更）

- [ ] **Step 1: 记录当前未格式化清单（红）**

Run: `gofmt -l internal/ main.go`
Expected: 输出非空，列出上述文件。把实际清单记下来，Step 4 要用它核对改动范围。

- [ ] **Step 2: 确认基线全绿（格式化前的行为快照）**

Run: `go test ./... 2>&1 | grep -v "^ok\|no test files"`
Expected: 无输出（全部包通过）。若此步已有失败，先停下来报告——不要在红基线上做格式化。

- [ ] **Step 3: 执行格式化**

Run: `gofmt -w internal/ main.go`
Expected: 无输出

- [ ] **Step 4: 确认清单归零且行为未变（绿）**

Run: `gofmt -l internal/ main.go`
Expected: 无输出

Run: `git diff --stat`
Expected: 改动文件集合与 Step 1 的清单完全一致，且 `git diff` 里只有空白/缩进变化（用 `git diff -w --stat` 复核：应显示 0 处实质改动）

Run: `go build ./... && go test ./...`
Expected: 构建无输出；测试全部 `ok`

- [ ] **Step 5: 提交**

```bash
git add -u
git commit -m "style: gofmt 全仓库归零"
```

---

### Task 6: 文档纠偏与 yaml 收敛

**背景：** 两处欠账。(1) `docs/action.md:322` 仍写「`logcat-stream` …为**双层过滤**……前端 logcat 视图另可运行时按 level/tag/message 对已缓冲条目再过滤」，与新架构完全相反（现在前端零求值，改规则走 `UpdateLogcatFilter` → 后端重筛 ring → `logcat-replace` 重放）；`link` 条件组语义在 JSON 示例里出现过但从未解释。CLAUDE.md 明确要求 schema 改动同步该文档。(2) `actions/adb-logcat-stream.yaml` 里的「测试表单」preset 是开发期临时验证物（名字即证据），不该留在仓库资产里；「对话改写」「指令分发」是真实工作场景，**保留**。

**Files:**
- Modify: `docs/action.md:322`（那一段的最后一句）与其后新增一段 `link` 说明
- Modify: `actions/adb-logcat-stream.yaml`（删「测试表单」preset 的 2 行）

**Interfaces:**
- Consumes: 无
- Produces: 无

- [ ] **Step 1: 纠正 docs/action.md 的「双层过滤」**

把 `docs/action.md` 中这句：

```
`logcat-stream` 配 `stream: logcat` 时为**双层过滤**：这里的服务端预过滤（PACKAGE/LEVEL/TAG/INCLUDE/EXCLUDE）减少 IPC 量，前端 logcat 视图另可运行时按 level/tag/message 对已缓冲条目再过滤，无需重启。
```

替换为：

```
`logcat-stream` 配 `stream: logcat` 时**只有一个求值器（后端）**：上述五个参数（或 `FILTER`）只是启动初值，运行期由 logcat 甲板经 `UpdateLogcatFilter` 整体下发新规则，后端重筛 10000 条 raw ring 并以 `logcat-replace` 帧整体重发——放宽条件能找回 ring 内的历史行。前端不做任何过滤求值，改规则无需重启动作。规则非法（未知 key、非法正则、pid/tid 非整数、未知 link）时后端拒绝并沿用旧规则，拒绝原因回显在甲板上，不静默降级。
```

- [ ] **Step 2: 补 `link` 条件组语义**

在 `FILTER`（仅 `logcat-stream`）那一段之后新增一段：

```
`link` 是条件组连接符：`"or"` 表示该 token **另起一个条件组**，组间任一组完全命中即通过；缺省或 `"and"` 表示并入当前组。组内语义是同 key OR、跨 key AND（每组按 key 建桶）。取反 token（`negated: true`）是全局排除，不参与分组、其 `link` 被忽略。首个正向 token 的 `link` 无前组可切，等同并入。无任何 `"or"` 的规则退化为单组，与旧语义一致。未知 `link` 值后端硬失败。
```

- [ ] **Step 3: 删「测试表单」preset**

在 `actions/adb-logcat-stream.yaml` 的 `presets:` 列表里删掉这一项（`- name: 测试表单` 及其 `values:` 行，共 2 行）。保留「云端响应」「对话改写」「指令分发」三项。

- [ ] **Step 4: 验证**

Run: `grep -c "name: 测试表单" actions/adb-logcat-stream.yaml || true`
Expected: `0`

Run: `grep -c "^  - name: " actions/adb-logcat-stream.yaml`
Expected: `3`

Run: `grep -c "双层过滤" docs/action.md || true`
Expected: `0`

Run: `grep -c "link\` 是条件组连接符" docs/action.md`
Expected: `1`

Run: `bash deploy/backend.sh`
Expected: 构建成功。随后启动一次生成的二进制，打开 logcat 动作确认 preset 分段条只剩 3 个且都能点开（YAML 资产的 schema 校验发生在启动时的 `registry.Load`，这是唯一的实测口）。

- [ ] **Step 5: 提交**

```bash
git add docs/action.md actions/adb-logcat-stream.yaml
git commit -m "docs(action): 纠正 logcat 双层过滤口径并补 link 条件组语义；删临时 preset"
```

---

## 不在本计划范围（评审里划到后续档的项）

| 项 | 为什么现在不做 |
|---|---|
| spec:82 的补全层（key 补全 + tag 值补全 + Tab 接受 + 选中态） | 是真功能不是缺陷；且 Tab 键当前被「固化」占用，需先重新设计键位 |
| 覆盖率 45.5% → 80%（`applyUpdate` / `handleStream` / `pidRefresher` / `parseEntry` / `UpdateLogcatFilter` 全 0%） | 独立一档工作量。这些路径已在 2026-09-03 真机验证中逐条跑通（动态增删/组合 9 步本地对账一致、运行期切包、Reset、非法规则拒绝），当前缺的是回归保护而非正确性 |
| `LogcatView.tsx` 812 行拆分 | 改动面大；本计划只控净增量（Task 4 删死代码抵消 Task 2/3 的新增） |
| `LogcatLinkMockup.tsx`（638 行）+ `main.tsx` 的 `?mockup=logcat-link` 门控 | spec:93 只点名 `frontend/src/mockup/`（已删）；这个残留精神上同属 throwaway，但归清理档 |
| `filter.go` 旧 `buildFilter/allow` 与 `rule.go` 求值器双份语义 | spec:126 明确「`logcat-batch` 落盘动作不动」 |
| Go/TS 跨语言重复（分组算法、legacy 映射、key 别名表、直方图排序）的一致性测试 | 需新建跨语言对照基建，独立一档 |
| `stream.go:89/206` 的 `json.Marshal` 失败静默 | `logcatPayload` / `replaceFrame` 全是标量字段，Marshal 不可能失败；加告警属不可达分支的防御性代码 |
| `matched/total` 增量自愈读数不自洽（`Provider:313-317`） | 是 e3de558 的显式取舍（注释在案），改它要先定义「两帧之间读数怎么算」 |

## Self-Review 结论

1. **覆盖**：「确证缺陷 + 规范欠账」档 7 项全部落到 Task —— seq race(1)、非法规则静默(2)、草稿丢弃(3)、草稿虚线态与死代码(4)、gofmt(5)、docs 漂移(6)、临时 preset(6)。自查补了两处初版问题：(a) `UpdateLogcatFilter` 另有两个空吞 catch（`focusRunning` / `clearLogcat`）与 `onCopy` 无 catch，已并入 Task 2 的 3i/3j——只改防抖那一处的话，「清空」与「切回运行中动作」两条路径依旧无声；(b) 初版让剪贴板错误复用 `logcatFilterError`，会把「规则被后端拒绝: …」的文案套到剪贴板失败上，已改为组件本地 `copyErr`。
2. **占位符**：无 TBD / 「适当的错误处理」/「参照 Task N」类表述；每个改代码的步骤都给了完整代码块，每个验证步骤都给了命令与预期输出。
3. **类型一致**：`nextSeq()`（Task 1 定义 → 同任务内 `EmitFunc`/`Done` 使用）、`logcatFilterError`（Task 2 定义 → 同任务内 LogcatView 只读消费）、`copyErr`（Task 2 内组件本地）、`drafts`/`setTokens`（Task 3）、`startWithEntries`/`entry`（Task 3 定义 → Task 4 复用，同文件内故不加 export）—— 跨任务命名一致。

**执行顺序**：Task 1 / 5 / 6 相互独立，可任意穿插；Task 2 → 3 → 4 必须按序（都改 `LogcatView.tsx`，且 4 复用 3 建的测试文件）。Task 5 建议排在 Task 1 之后，让 `events.go` 的新代码一并过 gofmt。

---









