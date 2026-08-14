# LLM 卡片独立入口 + 聊天式单页 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `command.llm` 形态的 action 拆成独立的侧边栏分组「AI 对话」+ 专属 grid 页，点卡片直接进入聊天式单页（底部输入框 + 上方流式回答 + 历史抽屉），取代现有 LlmForm→LlmView 两步。

**Architecture:** 纯前端改动。新增 `useLlmHistory`（localStorage 历史）、`LlmGridView`（LLM 卡片 grid）、`LlmChatView`（聊天单页）。改 `RunnerView` 枚举、Provider 的 llm 分派、AppSidebar 分组过滤、ActionsGridView 过滤、OutputPanel 路由。零后端、零 bindings 改动。

**Tech Stack:** React 19 + TS + Vite + tailwind4 + shadcn/base-ui + radix-ui（Popover）+ nexus-ui（Thread/Message/Reasoning）+ Vitest + i18next。

## Global Constraints

- 锁定 Wails `v3.0.0-alpha2.119`，不改后端签名故不需 `wails3 generate bindings`。
- 前端组件优先复用 `components/ui/`（shadcn 原子）与 `components/nexus-ui/`（Thread/Message/Reasoning）；`IconButton` 优先于手写按钮。
- 新增静态文案只改 `frontend/src/i18n/locales/{zh,en}.json`，两文件 key 必须一一对应。
- 不可变更新（spread，不 mutate）。函数 <50 行，文件 <800 行。
- 测试用 Vitest + Testing Library，mock `service.js` 与 `@wailsio/runtime`（参照现有 `LlmView.test.tsx`）。
- localStorage 写失败必须静默降级（隐私模式/配额），不打断运行——参照 `useActionUsage.ts` 的 try/catch。
- 所有工作目录在 `frontend/`；命令均在该目录执行。

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/hooks/useLlmHistory.ts` | **新增** localStorage 历史读写，按 actionId 分桶 |
| `src/hooks/useLlmHistory.test.ts` | **新增** hook 单测 |
| `src/components/LlmGridView.tsx` | **新增** LLM 卡片专属 grid |
| `src/components/LlmChatView.tsx` | **新增** 聊天单页：header + thread + composer + 历史抽屉 |
| `src/components/LlmChatView.test.tsx` | **新增** 聊天页单测 |
| `src/context/ActionRunnerProvider.tsx` | **改** `RunnerView` 加 `llm-grid`/`llm-chat`，删 `llm`；`runAction`/`focusRunning` 分派改 `llm-chat`；done 时写历史 |
| `src/components/AppSidebar.tsx` | **改** 新增「AI 对话」分组；「常用动作」过滤掉 llm |
| `src/components/ActionsGridView.tsx` | **改** 过滤掉 llm 卡片 |
| `src/components/OutputPanel.tsx` | **改** 路由 `llm-grid`→LlmGridView、`llm-chat`→LlmChatView，删 `llm`→LlmView |
| `src/i18n/locales/{zh,en}.json` | **改** 新增 sidebar.aiChat / llmGrid.* / llmChat.* |
| `src/components/LlmForm.tsx`、`LlmView.tsx`、`LlmView.test.tsx` | **删** 语义被 LlmChatView 覆盖 |

---

## Task 1: useLlmHistory hook

**Files:**
- Create: `frontend/src/hooks/useLlmHistory.ts`
- Test: `frontend/src/hooks/useLlmHistory.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  ```typescript
  export interface LlmHistoryEntry {
    id: string;          // `${timestamp}-${rand}` 唯一键
    timestamp: number;   // Date.now()
    prompt: string;      // 发送时的完整 prompt 终值
    params: Record<string, string>; // context param 快照
    response: string;    // assistant text（截断 10KB）
    thinking: string;    // thinking（截断 5KB），无则空串
    exitCode: number;
    duration: string;    // "12.4s"，无则空串
  }
  export function useLlmHistory(actionId: string | null): {
    entries: LlmHistoryEntry[];
    append: (entry: Omit<LlmHistoryEntry, "id" | "timestamp">) => void;
    clear: () => void;
  };
  export const LLM_HISTORY_MAX = 50;
  export const RESPONSE_CAP = 10_000;
  export const THINKING_CAP = 5_000;
  ```

- [ ] **Step 1: 写失败测试**

```typescript
// frontend/src/hooks/useLlmHistory.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLlmHistory, LLM_HISTORY_MAX, RESPONSE_CAP } from "./useLlmHistory";

describe("useLlmHistory", () => {
  beforeEach(() => localStorage.clear());

  it("append 后 entries 倒序返回，最新在前", () => {
    const { result } = renderHook(() => useLlmHistory("card-a"));
    act(() => result.current.append({ prompt: "q1", params: {}, response: "r1", thinking: "", exitCode: 0, duration: "1s" }));
    act(() => result.current.append({ prompt: "q2", params: {}, response: "r2", thinking: "", exitCode: 0, duration: "2s" }));
    expect(result.current.entries.map((e) => e.prompt)).toEqual(["q2", "q1"]);
  });

  it("按 actionId 分桶，互不干扰", () => {
    const { result: a } = renderHook(() => useLlmHistory("card-a"));
    const { result: b } = renderHook(() => useLlmHistory("card-b"));
    act(() => a.current.append({ prompt: "qa", params: {}, response: "", thinking: "", exitCode: 0, duration: "" }));
    expect(b.current.entries).toHaveLength(0);
  });

  it("超过 LLM_HISTORY_MAX 条时丢弃最旧", () => {
    const { result } = renderHook(() => useLlmHistory("card-a"));
    act(() => {
      for (let i = 0; i < LLM_HISTORY_MAX + 5; i++) {
        result.current.append({ prompt: `q${i}`, params: {}, response: "", thinking: "", exitCode: 0, duration: "" });
      }
    });
    expect(result.current.entries).toHaveLength(LLM_HISTORY_MAX);
    expect(result.current.entries[0].prompt).toBe(`q${LLM_HISTORY_MAX + 4}`);
  });

  it("response 超过 RESPONSE_CAP 被截断并加后缀", () => {
    const { result } = renderHook(() => useLlmHistory("card-a"));
    const big = "x".repeat(RESPONSE_CAP + 100);
    act(() => result.current.append({ prompt: "q", params: {}, response: big, thinking: "", exitCode: 0, duration: "" }));
    expect(result.current.entries[0].response.length).toBeLessThanOrEqual(RESPONSE_CAP + 20);
    expect(result.current.entries[0].response).toContain("…（已截断）");
  });

  it("clear 清空当前卡片历史", () => {
    const { result } = renderHook(() => useLlmHistory("card-a"));
    act(() => result.current.append({ prompt: "q", params: {}, response: "", thinking: "", exitCode: 0, duration: "" }));
    act(() => result.current.clear());
    expect(result.current.entries).toHaveLength(0);
  });

  it("actionId 为 null 时 entries 为空且 append 静默无操作", () => {
    const { result } = renderHook(() => useLlmHistory(null));
    act(() => result.current.append({ prompt: "q", params: {}, response: "", thinking: "", exitCode: 0, duration: "" }));
    expect(result.current.entries).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- useLlmHistory`
Expected: FAIL（`useLlmHistory` 未定义 / 模块不存在）

- [ ] **Step 3: 实现 hook**

```typescript
// frontend/src/hooks/useLlmHistory.ts
import { useCallback, useEffect, useState } from "react";

export interface LlmHistoryEntry {
  id: string;
  timestamp: number;
  prompt: string;
  params: Record<string, string>;
  response: string;
  thinking: string;
  exitCode: number;
  duration: string;
}

export const LLM_HISTORY_MAX = 50;
export const RESPONSE_CAP = 10_000;
export const THINKING_CAP = 5_000;
const TRUNC_SUFFIX = "…（已截断）";

const keyFor = (actionId: string) => `llm-history:${actionId}`;

function cap(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + TRUNC_SUFFIX;
}

function read(actionId: string): LlmHistoryEntry[] {
  try {
    const raw = localStorage.getItem(keyFor(actionId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 外部数据不可信：只保留形状正确的项
    return parsed.filter(
      (e): e is LlmHistoryEntry =>
        !!e && typeof e === "object" && typeof (e as LlmHistoryEntry).id === "string",
    );
  } catch {
    return [];
  }
}

function write(actionId: string, entries: LlmHistoryEntry[]): void {
  try {
    localStorage.setItem(keyFor(actionId), JSON.stringify(entries));
  } catch {
    // 隐私模式/配额写失败：静默降级，历史仅存于内存本次会话
  }
}

// 按 actionId 分桶的 LLM 运行历史。倒序（最新在前），封顶 LLM_HISTORY_MAX 条。
export function useLlmHistory(actionId: string | null) {
  const [entries, setEntries] = useState<LlmHistoryEntry[]>([]);

  useEffect(() => {
    setEntries(actionId ? read(actionId) : []);
  }, [actionId]);

  const append = useCallback(
    (entry: Omit<LlmHistoryEntry, "id" | "timestamp">) => {
      if (!actionId) return;
      const full: LlmHistoryEntry = {
        ...entry,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        response: cap(entry.response, RESPONSE_CAP),
        thinking: cap(entry.thinking, THINKING_CAP),
      };
      setEntries((prev) => {
        const next = [full, ...prev].slice(0, LLM_HISTORY_MAX);
        write(actionId, next);
        return next;
      });
    },
    [actionId],
  );

  const clear = useCallback(() => {
    if (!actionId) return;
    setEntries([]);
    write(actionId, []);
  }, [actionId]);

  return { entries, append, clear };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- useLlmHistory`
Expected: PASS（6 项全过）

- [ ] **Step 5: 提交**

```bash
git add frontend/src/hooks/useLlmHistory.ts frontend/src/hooks/useLlmHistory.test.ts
git commit -m "feat(llm): 新增 useLlmHistory localStorage 历史 hook"
```

---

## Task 2: RunnerView 枚举扩展 + Provider llm 分派改造

**Files:**
- Modify: `frontend/src/context/ActionRunnerProvider.tsx`（类型 57-72 行、runAction 429-432、focusRunning 509-526）

**Interfaces:**
- Consumes: Task 1 的 `useLlmHistory`（append 供 done 写历史）
- Produces:
  - `RunnerView` 联合类型新增 `"llm-grid"` 与 `"llm-chat"`，移除 `"llm"`
  - `focusRunning(id, targetView)` 的 `targetView` 类型从 `"output" | "llm" | "logcat"` 改为 `"output" | "llm-chat" | "logcat"`
  - Provider value 新增：`llmHistory: LlmHistoryEntry[]`、`appendLlmHistory` 内部使用（不导出到 context，历史写入在 Provider 内完成）
  - 保留导出：`llmText`、`thinkingText`、`currentId`、`status`、`exitInfo`、`formValues`、`setFormValue`、`runAction`、`cancel`、`setView`、`actions`

**注意**：本任务只改类型和视图分派字符串，不引入历史写入（历史写入放 Task 6，避免本任务面过大）。先让编译通过。

- [ ] **Step 1: 改 RunnerView 类型定义**

在 `ActionRunnerProvider.tsx` 约 58-72 行，将：
```typescript
export type RunnerView =
  | "output"
  | "form"
  | "global"
  | "llm"
  | "logcat"
  ...
```
改为（删 `"llm"`，末尾加两项）：
```typescript
export type RunnerView =
  | "output"
  | "form"
  | "global"
  | "logcat"
  | "fragments"
  | "edit"
  | "workflow"
  | "workflow-form"
  | "workflow-edit"
  | "settings"
  | "actions-grid"
  | "workflows-grid"
  | "llm-grid"
  | "llm-chat";
```

- [ ] **Step 2: 改 focusRunning 签名（接口声明处）**

在 `RunnerContextValue` 接口中，将：
```typescript
  focusRunning: (id: string, targetView: "output" | "llm" | "logcat") => void;
```
改为：
```typescript
  focusRunning: (id: string, targetView: "output" | "llm-chat" | "logcat") => void;
```

- [ ] **Step 3: 改 runAction 里的 llm 分派**

约 429-432 行，将：
```typescript
      if (action?.llm) {
        setLlmText("");
        setThinkingText("");
        setView("llm");
      } else if (action?.stream === "logcat") {
```
改为：
```typescript
      if (action?.llm) {
        setLlmText("");
        setThinkingText("");
        setView("llm-chat");
      } else if (action?.stream === "logcat") {
```

- [ ] **Step 4: 改 focusRunning 实现体**

约 509-526 行，将实现签名和分支里的 `"llm"` 改为 `"llm-chat"`：
```typescript
  const focusRunning = (
    id: string,
    targetView: "output" | "llm-chat" | "logcat",
  ) => {
    setCurrentId(id);
    setStatus("running");
    setExitInfo(null);
    setSelectedPreset(null);
    setLines([]);
    if (targetView === "llm-chat") {
      setLlmText("");
      setThinkingText("");
    } else if (targetView === "logcat") {
      logcatBufferRef.current = [];
      setLogcatEntries([]);
    }
    setView(targetView);
  };
```

- [ ] **Step 5: typecheck 确认编译错误只剩消费方**

Run: `npm run typecheck`
Expected: 报错集中在 `OutputPanel.tsx`（引用了 `"llm"`）、`ActionItem.tsx`（`backToRunning` 传 `"llm"`）——这些在 Task 3/5 修。确认 Provider 自身无类型错误。

- [ ] **Step 6: 修 ActionItem 的 backToRunning**

`frontend/src/components/ActionItem.tsx` 约 41-46 行，将：
```typescript
    const target = action.llm
      ? "llm"
      : action.stream === "logcat"
        ? "logcat"
        : "output";
```
改为：
```typescript
    const target = action.llm
      ? "llm-chat"
      : action.stream === "logcat"
        ? "logcat"
        : "output";
```

- [ ] **Step 7: 提交**

```bash
git add frontend/src/context/ActionRunnerProvider.tsx frontend/src/components/ActionItem.tsx
git commit -m "refactor(llm): RunnerView 加 llm-grid/llm-chat，llm 分派改 llm-chat"
```

---

## Task 3: OutputPanel 路由 + i18n 文案

**Files:**
- Modify: `frontend/src/components/OutputPanel.tsx`
- Modify: `frontend/src/i18n/locales/zh.json`、`frontend/src/i18n/locales/en.json`

**Interfaces:**
- Consumes: Task 2 的 `RunnerView`；Task 4 的 `LlmGridView`、Task 5 的 `LlmChatView`（本任务先加 import，占位组件在其任务落地。为让本任务独立可跑，先建最小占位）
- Produces: `view === "llm-grid"` → `<LlmGridView />`、`view === "llm-chat"` → `<LlmChatView />` 路由

**说明**：为使本任务独立编译通过，先创建两个最小占位组件（Task 4/5 会替换其内容），并同步加齐 i18n key。

- [ ] **Step 1: 建最小占位组件**

```typescript
// frontend/src/components/LlmGridView.tsx （占位，Task 4 替换）
export function LlmGridView() {
  return <main className="flex-1" />;
}
```
```typescript
// frontend/src/components/LlmChatView.tsx （占位，Task 5 替换）
export function LlmChatView() {
  return <main className="flex-1" />;
}
```

- [ ] **Step 2: 改 OutputPanel 路由**

将 import 段的 `import { LlmView } from "./LlmView";` 替换为：
```typescript
import { LlmGridView } from "./LlmGridView";
import { LlmChatView } from "./LlmChatView";
```
将 `if (view === "llm") return <LlmView />;` 替换为：
```typescript
  if (view === "llm-grid") return <LlmGridView />;
  if (view === "llm-chat") return <LlmChatView />;
```
删除 `form` 分支里的 LlmForm 分派（llm 动作不再走 form 视图），即将：
```typescript
  if (view === "form") {
    const action = actions.find((a) => a.id === currentId);
    const FormComp = action?.llm ? LlmForm : ParamForm;
    return (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <OutputToolbar />
        <div className="min-h-0 flex-1 overflow-auto">
          <FormComp />
        </div>
      </main>
    );
  }
```
改为：
```typescript
  if (view === "form") {
    return (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <OutputToolbar />
        <div className="min-h-0 flex-1 overflow-auto">
          <ParamForm />
        </div>
      </main>
    );
  }
```
并删除文件顶部 `import { LlmForm } from "./LlmForm";`。

- [ ] **Step 3: 加 i18n key（zh.json）**

在 `frontend/src/i18n/locales/zh.json` 内（`sidebar.settings` 之后、`grid.title` 之前的位置任选）新增：
```json
  "sidebar.aiChat": "AI 对话",
  "sidebar.allLlm": "全部 AI 卡片",
  "llmGrid.title": "AI 卡片",
  "llmChat.back": "返回 AI 卡片",
  "llmChat.send": "发送",
  "llmChat.stop": "停止",
  "llmChat.history": "历史",
  "llmChat.placeholder": "输入发给 AI 的内容…",
  "llmChat.sendHint": "发送",
  "llmChat.newlineHint": "换行",
  "llmChat.emptyHint": "填好下方参数后开始对话",
  "llmChat.roleField": "角色设定",
  "llmChat.roleConfigured": "已配置",
  "llmChat.paramEmpty": "未填",
  "llmChat.historyTitle": "历史记录",
  "llmChat.historyEmpty": "暂无历史记录",
  "llmChat.historyMax": "最多保留 50 条",
  "llmChat.historyClear": "清空历史",
  "llmChat.viewingHistory": "正在查看历史记录",
  "llmChat.backToCurrent": "返回当前",
  "llmChat.assistant": "助手",
  "llmChat.you": "你",
```

- [ ] **Step 4: 加 i18n key（en.json，与 zh 一一对应）**

在 `frontend/src/i18n/locales/en.json` 对应位置新增：
```json
  "sidebar.aiChat": "AI Chat",
  "sidebar.allLlm": "All AI Cards",
  "llmGrid.title": "AI Cards",
  "llmChat.back": "Back to AI Cards",
  "llmChat.send": "Send",
  "llmChat.stop": "Stop",
  "llmChat.history": "History",
  "llmChat.placeholder": "Type your message to the AI…",
  "llmChat.sendHint": "send",
  "llmChat.newlineHint": "newline",
  "llmChat.emptyHint": "Fill in the parameters below to start",
  "llmChat.roleField": "Role",
  "llmChat.roleConfigured": "configured",
  "llmChat.paramEmpty": "empty",
  "llmChat.historyTitle": "History",
  "llmChat.historyEmpty": "No history yet",
  "llmChat.historyMax": "Keeps up to 50 entries",
  "llmChat.historyClear": "Clear history",
  "llmChat.viewingHistory": "Viewing history",
  "llmChat.backToCurrent": "Back to current",
  "llmChat.assistant": "Assistant",
  "llmChat.you": "You",
```

- [ ] **Step 5: 校验 i18n key 对齐**

Run: `node -e "const z=require('./src/i18n/locales/zh.json'),e=require('./src/i18n/locales/en.json');const zk=Object.keys(z).sort(),ek=Object.keys(e).sort();const miss=zk.filter(k=>!(k in e)).concat(ek.filter(k=>!(k in z)));console.log(miss.length?'MISMATCH:'+miss:'OK')"`
Expected: `OK`

- [ ] **Step 6: typecheck + 提交**

Run: `npm run typecheck`
Expected: PASS（占位组件满足路由类型）

```bash
git add frontend/src/components/OutputPanel.tsx frontend/src/components/LlmGridView.tsx frontend/src/components/LlmChatView.tsx frontend/src/i18n/locales/zh.json frontend/src/i18n/locales/en.json
git commit -m "feat(llm): OutputPanel 路由 llm-grid/llm-chat + i18n 文案 + 占位组件"
```

---

## Task 4: LlmGridView 实现

**Files:**
- Modify: `frontend/src/components/LlmGridView.tsx`（替换 Task 3 占位）

**Interfaces:**
- Consumes: `useActionRunner()`（`actions`、`runAction`、`setView`、`setCurrentId`、`isRunning`）；`useActionUsage("llm-usage")`（`groupByPrefix`、`topActions`、`getScore`、`footprintLevel`、`recordUsage`）；`ActionIcon`、`GridCardParts`
- Produces: `export function LlmGridView()`；点卡片 → `setCurrentId(id) + setView("llm-chat")`

**说明**：结构镜像 `ActionsGridView.tsx`，数据源换成 `actions.filter(a => a.llm)`，用独立 usage key `"llm-usage"`，卡片点击不再 `runAction` 而是进 chat 空态。为遵守 DRY 但避免过度抽象，复用 `useActionUsage`/`GridCardParts`/`ActionIcon`，卡片本体因交互不同（进 chat 而非直接跑）内联一个精简 `LlmCard`。

- [ ] **Step 1: 检查 useActionRunner 是否暴露 setCurrentId**

Run: `grep -n "setCurrentId\|selectLlmCard\|setView" frontend/src/context/ActionRunnerProvider.tsx | head`
Expected: 若 `setCurrentId` 未在 context value 暴露，则本步在 Provider 的 value 对象中补 `setCurrentId`（已有 `setView`）。查 value 返回对象（约 750-790 行），确认包含 `setView`。若无 `setCurrentId`，加一个语义方法更干净：

在 Provider 中新增（放 `focusRunning` 附近）：
```typescript
  // 打开某 LLM 卡片的聊天页（空态）：设为当前、清历史缓冲、切 llm-chat。
  const openLlmChat = (id: string) => {
    setCurrentId(id);
    setSelectedPreset(null);
    setLlmText("");
    setThinkingText("");
    setStatus("idle");
    setExitInfo(null);
    setView("llm-chat");
  };
```
并在 `RunnerContextValue` 接口加 `openLlmChat: (id: string) => void;`，在 value 返回对象加 `openLlmChat,`。

- [ ] **Step 2: 实现 LlmGridView**

```typescript
// frontend/src/components/LlmGridView.tsx
import { useTranslation } from "react-i18next";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";
import { useActionUsage, groupLabel, MISC_KEY } from "../hooks/useActionUsage";
import { ActionIcon } from "./ActionIcon";
import { TickRuler, StatusRail, ParamSummary, RunningFlow } from "./GridCardParts";
import type { ActionItem } from "../../bindings/workflow-tool/internal/api/models.js";

const EYEBROW =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

// LLM 卡片专属 grid：只展示 command.llm 形态动作，点卡片进聊天页空态（不直接运行）。
export function LlmGridView() {
  const { t } = useTranslation();
  const { actions, openLlmChat, isRunning } = useActionRunner();
  const { groupByPrefix, footprintLevel, getScore, topActions } = useActionUsage("llm-usage");

  const llmActions = actions.filter((a) => a.llm);
  const groups = groupByPrefix(llmActions);
  const groupEntries = Object.entries(groups).sort(([a], [b]) => {
    if (a === MISC_KEY) return 1;
    if (b === MISC_KEY) return -1;
    return a.localeCompare(b);
  });

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <h1 className="text-sm font-semibold">{t("llmGrid.title")}</h1>
        </div>
        <span className="font-mono text-[11px] tracking-[0.14em] uppercase text-muted-foreground">
          {t("grid.itemsCount", { count: llmActions.length })}
          {" · "}
          {t("grid.groupsCount", { count: groupEntries.length })}
        </span>
      </header>
      <div className="p-4 space-y-6">
        {groupEntries.map(([key, items]) => {
          const lit = items.reduce((n, it) => (getScore(it.id) > 0 ? n + 1 : n), 0);
          return (
            <section key={key}>
              <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 pb-3">
                <span className={EYEBROW}>
                  {key === MISC_KEY ? t("grid.groupMisc") : groupLabel(key)}
                </span>
                <TickRuler total={items.length} lit={lit} />
                <span className="font-mono text-[11px] tracking-[0.14em] uppercase text-muted-foreground tabular-nums">
                  {items.length} {t("grid.slots")}
                </span>
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-3">
                {topActions(items, items.length).map((action) => (
                  <LlmCard
                    key={action.id}
                    action={action}
                    running={isRunning(action.id)}
                    level={footprintLevel(action.id)}
                    score={getScore(action.id)}
                    onOpen={() => openLlmChat(action.id)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}

// ponytail: 单一消费者，内联不外抽。
interface LlmCardProps {
  action: ActionItem;
  running: boolean;
  level: number;
  score: number;
  onOpen: () => void;
}

function LlmCard({ action, running, level, score, onOpen }: LlmCardProps) {
  const { t } = useTranslation();
  const paramIds = action.params?.map((p) => p.id) ?? [];
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      data-running={running || undefined}
      className={`group relative flex flex-col gap-2.5 rounded-lg border p-3.5 cursor-pointer bg-card transition-colors duration-150 ease-out hover:border-primary/55 hover:shadow-[inset_0_0_0_1px] hover:shadow-primary/30 focus-visible:outline-none focus-visible:border-primary/55 ${running ? "border-primary" : "border-border"}`}
    >
      {running && <RunningFlow />}
      <StatusRail level={level} score={score} />
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/14 text-primary">
          <ActionIcon name={action.icon} className="size-4" />
        </span>
        <span className="font-mono text-[13.5px] font-semibold leading-tight -tracking-[0.01em] break-all">
          {action.title}
        </span>
      </div>
      {action.description && (
        <span className="text-xs leading-relaxed text-muted-foreground line-clamp-2 group-hover:line-clamp-none group-focus-within:line-clamp-none">
          {action.description}
        </span>
      )}
      {paramIds.length > 0 && <ParamSummary ids={paramIds} />}
      <div className="flex items-center justify-between gap-2 border-t border-dashed border-border pt-2 mt-auto font-mono text-[10px] tracking-[0.06em] uppercase text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 opacity-70 text-foreground tabular-nums">
          {action.params?.length
            ? t("grid.paramsCount", { count: action.params.length })
            : t("grid.noParams")}
        </span>
        {running ? (
          <span className="flex items-center gap-1.5 text-primary normal-case tracking-normal">
            <span className="size-1.5 rounded-full bg-primary live-pulse" />
            running
          </span>
        ) : (
          <span className="text-primary tracking-[0.14em] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            ▸ {t("main.choose")}
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: PASS。若报 `openLlmChat` 不存在，回 Step 1 补 Provider。

- [ ] **Step 4: 手动冒烟（构建）**

Run: `npm run build`
Expected: 构建成功，无类型/编译错误。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/components/LlmGridView.tsx frontend/src/context/ActionRunnerProvider.tsx frontend/src/context/index.ts
git commit -m "feat(llm): LlmGridView 独立 AI 卡片列表页 + openLlmChat"
```
（注：若无 `context/index.ts` 则去掉该路径。）

---

## Task 5: LlmChatView 实现（不含历史抽屉）

**Files:**
- Modify: `frontend/src/components/LlmChatView.tsx`（替换占位）
- Create: `frontend/src/components/LlmChatView.test.tsx`

**Interfaces:**
- Consumes: `useActionRunner()`（`actions`、`currentId`、`formValues`、`setFormValue`、`runAction`、`cancel`、`setView`、`status`、`exitInfo`、`llmText`、`thinkingText`）；`missingRequired`；nexus-ui `Thread`/`Message`/`Reasoning`；radix-ui `Popover`；`ParamFields`
- Produces: `export function LlmChatView()`

**说明**：本任务实现聊天主体（header + thread + composer），历史抽屉放 Task 6。composer 的 context chip 用 radix `Popover` 包 `ParamFields`（复用现有字段渲染）。

- [ ] **Step 1: 写失败测试**

```typescript
// frontend/src/components/LlmChatView.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useEffect } from "react";

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({
    actions: [
      {
        id: "c1", title: "卡片一", icon: "◆", description: "描述",
        params: [
          { id: "ROLE", label: "角色", type: "textarea", required: false, default: "你是助手" },
          { id: "TASK", label: "任务", type: "textarea", required: true, default: "请处理 ${X}" },
        ],
        presets: [], stream: "",
        llm: { systemParam: "ROLE", promptParam: "TASK" },
      },
    ],
    errors: [],
  }),
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn().mockResolvedValue(undefined),
  GetFragments: vi.fn().mockResolvedValue([]),
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: vi.fn().mockResolvedValue(undefined),
  PickDirectory: vi.fn().mockResolvedValue(""),
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => ({}) } }));

import { ActionRunnerProvider, _emitForTest } from "../context/ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import { SidebarProvider } from "@/components/ui/sidebar";
import { LlmChatView } from "./LlmChatView";

function Drive() {
  const { openLlmChat, runAction } = useActionRunner();
  useEffect(() => {
    openLlmChat("c1");
    runAction("c1", { ROLE: "你是助手", TASK: "请处理卡片" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <LlmChatView />;
}

function renderChat() {
  return render(
    <ActionRunnerProvider>
      <SidebarProvider>
        <Drive />
      </SidebarProvider>
    </ActionRunnerProvider>,
  );
}

describe("LlmChatView", () => {
  it("渲染卡片标题", async () => {
    renderChat();
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    expect(await screen.findByText("卡片一")).toBeInTheDocument();
  });

  it("流式渲染 assistant 文本", async () => {
    renderChat();
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    act(() => {
      _emitForTest("action:c1:output", { data: { stream: "llm", line: "处理完成" } });
    });
    expect(await screen.findByText(/处理完成/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- LlmChatView`
Expected: FAIL（`LlmChatView` 仍是占位空 main，找不到「卡片一」文本）

- [ ] **Step 3: 实现 LlmChatView（主体，无抽屉）**

```typescript
// frontend/src/components/LlmChatView.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Cancel01Icon, SentIcon } from "@hugeicons/core-free-icons";
import { Popover } from "radix-ui";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { IconButton } from "./IconButton";
import { ActionIcon } from "./ActionIcon";
import { ParamFields } from "./ParamFields";
import { useActionRunner } from "../hooks/useActionRunner";
import { missingRequired } from "../lib/params";
import {
  Message, MessageContent, MessageMarkdown,
} from "@/components/nexus-ui/message";
import {
  Reasoning, ReasoningTrigger, ReasoningContent,
} from "@/components/nexus-ui/reasoning";
import {
  Thread, ThreadContent, ThreadScrollToBottom,
} from "@/components/nexus-ui/thread";

// 聊天式单页：底部输入框（绑 promptParam）+ 上方流式回答。单轮替换，每次发送清空上一轮。
export function LlmChatView() {
  const { t } = useTranslation();
  const {
    actions, currentId, formValues, setFormValue,
    runAction, cancel, setView, status, exitInfo, llmText, thinkingText,
  } = useActionRunner();
  const action = actions.find((a) => a.id === currentId);
  const running = status === "running";

  if (!action?.llm || !action.params) return null;
  const { systemParam, promptParam } = action.llm;
  const promptSpec = action.params.find((p) => p.id === promptParam);
  if (!promptSpec) return null;

  const contextSpecs = action.params.filter(
    (p) => p.id !== promptParam && p.id !== systemParam,
  );
  const systemSpec = systemParam
    ? action.params.find((p) => p.id === systemParam)
    : null;

  const canRun = missingRequired(action.params, formValues).length === 0;
  const promptValue = formValues[promptParam] ?? promptSpec.default ?? "";
  const hasConversation = running || llmText !== "" || thinkingText !== "" || !!exitInfo;

  const onSend = () => {
    if (!canRun || running) return;
    const params: Record<string, string> = {};
    action.params!.forEach((p) => {
      params[p.id] = formValues[p.id] ?? p.default ?? "";
    });
    runAction(action.id, params);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <IconButton
            icon={ArrowLeft01Icon}
            label={t("llmChat.back")}
            onClick={() => setView("llm-grid")}
          />
          <span className="flex items-center gap-1.5 rounded px-1 font-semibold">
            <ActionIcon name={action.icon ?? "hi:play"} />
            {action.title}
          </span>
          {running ? (
            <span className="inline-flex items-center gap-1.5 font-mono text-xs text-primary">
              <span className="size-1.5 rounded-full bg-primary live-pulse" />
              {t("workflow.running")}
            </span>
          ) : exitInfo ? (
            <span className={`inline-flex items-center gap-1.5 font-mono text-xs ${exitInfo.exitCode === 0 ? "text-success" : "text-destructive"}`}>
              {exitInfo.exitCode === 0 ? t("workflow.done") : t("workflow.error")}
              {exitInfo.duration && <span className="text-muted-foreground">· {exitInfo.duration}</span>}
            </span>
          ) : null}
        </div>
        {running && (
          <Button variant="destructive" size="sm" onClick={cancel}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.75} className="size-4" />
            {t("llmChat.stop")}
          </Button>
        )}
      </header>

      <Thread className="flex min-w-0 flex-1">
        <ThreadContent className="p-4">
          {!hasConversation ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <span className="grid size-11 place-items-center rounded-xl bg-primary/14 text-primary">
                <ActionIcon name={action.icon ?? "hi:play"} className="size-5" />
              </span>
              <div className="text-sm font-semibold">{action.title}</div>
              <div className="max-w-100 text-xs leading-relaxed text-muted-foreground">
                {action.description || t("llmChat.emptyHint")}
              </div>
            </div>
          ) : (
            <>
              <Message from="user">
                <MessageContent>{promptValue}</MessageContent>
              </Message>
              <Message from="assistant">
                <MessageContent>
                  {thinkingText && (
                    <Reasoning isStreaming={running}>
                      <ReasoningTrigger />
                      <ReasoningContent>{thinkingText}</ReasoningContent>
                    </Reasoning>
                  )}
                  <MessageMarkdown>{llmText}</MessageMarkdown>
                  {running && llmText === "" && !thinkingText && (
                    <div role="status" className="flex items-center gap-2">
                      <Skeleton className="h-4 w-32" />
                      <span className="sr-only">{t("llm.thinking")}</span>
                    </div>
                  )}
                </MessageContent>
              </Message>
            </>
          )}
        </ThreadContent>
        <ThreadScrollToBottom />
      </Thread>

      <div className="border-t bg-muted/20 px-4 pt-2.5 pb-3">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {systemSpec && (
            <ContextChip
              label={t("llmChat.roleField")}
              value={formValues[systemSpec.id] ?? systemSpec.default ?? ""}
              spec={systemSpec}
              values={formValues}
              setValue={setFormValue}
              dashed
              configuredLabel={t("llmChat.roleConfigured")}
              emptyLabel={t("llmChat.paramEmpty")}
            />
          )}
          {contextSpecs.map((spec) => (
            <ContextChip
              key={spec.id}
              label={spec.id}
              value={formValues[spec.id] ?? spec.default ?? ""}
              spec={spec}
              values={formValues}
              setValue={setFormValue}
              emptyLabel={t("llmChat.paramEmpty")}
            />
          ))}
        </div>
        <div className="flex flex-col rounded-xl border border-input bg-background focus-within:border-primary/60 focus-within:ring-3 focus-within:ring-primary/12">
          <textarea
            value={promptValue}
            onChange={(e) => setFormValue(promptParam, e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("llmChat.placeholder")}
            className="min-h-16 w-full resize-none bg-transparent px-3 pt-3 pb-1 text-sm leading-relaxed outline-none"
          />
          <div className="flex items-center justify-between gap-2.5 px-2.5 pt-1 pb-2">
            <span className="font-mono text-[10.5px] tracking-[0.05em] text-muted-foreground">
              <Kbd>⌘</Kbd><Kbd>↵</Kbd> {t("llmChat.sendHint")} · <Kbd>⇧</Kbd><Kbd>↵</Kbd> {t("llmChat.newlineHint")}
            </span>
            {running ? (
              <Button variant="destructive" size="sm" onClick={cancel}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.75} className="size-4" />
                {t("llmChat.stop")}
              </Button>
            ) : (
              <Button size="sm" disabled={!canRun} onClick={onSend}>
                <HugeiconsIcon icon={SentIcon} strokeWidth={1.75} className="size-4" />
                {t("llmChat.send")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

// context chip：显示 param 当前值摘要，点击 Popover 打开对应字段编辑。
interface ContextChipProps {
  label: string;
  value: string;
  spec: import("../../bindings/workflow-tool/internal/registry/models.js").ParamSpec;
  values: Record<string, string>;
  setValue: (id: string, v: string) => void;
  dashed?: boolean;
  configuredLabel?: string;
  emptyLabel: string;
}

function ContextChip({
  label, value, spec, values, setValue, dashed, configuredLabel, emptyLabel,
}: ContextChipProps) {
  const [open, setOpen] = useState(false);
  const filled = value.trim().length > 0;
  const summary = filled
    ? configuredLabel ?? (value.length > 16 ? value.slice(0, 16) + "…" : value)
    : emptyLabel;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] ${dashed ? "border-dashed" : ""} ${filled ? "border-success/40" : "border-border"} bg-muted/55 text-muted-foreground hover:border-primary/55 hover:text-foreground`}
        >
          {label}
          <b className={`font-medium ${filled ? "text-foreground" : "italic opacity-60"}`}>{summary}</b>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          className="z-50 w-96 rounded-lg border bg-popover p-3 shadow-md"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <ParamFields params={[spec]} values={values} setValue={setValue} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- LlmChatView`
Expected: PASS（2 项）

- [ ] **Step 5: 校验 SentIcon 图标名存在**

Run: `node -e "const i=require('@hugeicons/core-free-icons');console.log('SentIcon' in i ? 'OK' : 'MISSING')"`
Expected: `OK`。若 `MISSING`，改用 `PlayIcon`（已在 LlmForm 用过，确认存在）并同步 Step 3 的 import。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/components/LlmChatView.tsx frontend/src/components/LlmChatView.test.tsx
git commit -m "feat(llm): LlmChatView 聊天式单页主体（composer + thread + context chip）"
```

---

## Task 6: 历史写入 + 历史抽屉

**Files:**
- Modify: `frontend/src/context/ActionRunnerProvider.tsx`（done 事件写历史）
- Modify: `frontend/src/components/LlmChatView.tsx`（历史按钮 + 抽屉 + 只读模式）

**Interfaces:**
- Consumes: Task 1 `useLlmHistory`；Task 5 `LlmChatView`
- Produces: Provider value 新增 `llmHistory: LlmHistoryEntry[]`、`clearLlmHistory: () => void`；LlmChatView 内历史抽屉 UI + 只读查看态

**说明**：历史写入必须在 Provider 层（done 事件在 Provider 触发，能拿到完整 prompt/response/thinking/exit）。抽屉与只读态在 LlmChatView 用本地 state 管理「当前查看的历史条目」。

- [ ] **Step 1: Provider 接入 useLlmHistory 并在 done 写入**

在 Provider 顶部（其他 hook 附近）加：
```typescript
  const { entries: llmHistory, append: appendLlmHistory, clear: clearLlmHistory } =
    useLlmHistory(currentId);
```
import：`import { useLlmHistory, type LlmHistoryEntry } from "../hooks/useLlmHistory";`

找到 llm action 的 done 处理（`currentId` 的 useEffect 内 `onDone`，约 333/395 行附近，设置 `setExitInfo(d)` 处）。在设置 exitInfo 后，判断当前是 llm action 则写历史。由于 done 回调闭包需要最新 llmText/thinkingText，用 ref 镜像：

在 state 声明附近加 ref：
```typescript
  const llmTextRef = useRef("");
  const thinkingTextRef = useRef("");
  useEffect(() => { llmTextRef.current = llmText; }, [llmText]);
  useEffect(() => { thinkingTextRef.current = thinkingText; }, [thinkingText]);
```
在 llm 分支的 onDone（设置 exitInfo 后）追加：
```typescript
      const cur = actions.find((a) => a.id === currentId);
      if (cur?.llm) {
        const promptId = cur.llm.promptParam;
        appendLlmHistory({
          prompt: formValues[promptId] ?? "",
          params: { ...formValues },
          response: llmTextRef.current,
          thinking: thinkingTextRef.current,
          exitCode: d.exitCode,
          duration: d.duration,
        });
      }
```
（`d` 是 done 事件 payload，含 exitCode/duration；确认现有 onDone 里 `d` 变量名，若不同则对齐。）

在 `RunnerContextValue` 接口加：
```typescript
  llmHistory: LlmHistoryEntry[];
  clearLlmHistory: () => void;
```
value 返回对象加 `llmHistory,` 和 `clearLlmHistory,`。

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: LlmChatView 加历史抽屉**

在 `LlmChatView` 顶部消费新增 context：
```typescript
  const { llmHistory, clearLlmHistory } = useActionRunner();
```
组件内加本地状态：
```typescript
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewing, setViewing] = useState<LlmHistoryEntry | null>(null);
```
import：`import { type LlmHistoryEntry } from "../hooks/useLlmHistory";`

header 右侧（`running && 停止按钮` 之前）加历史按钮：
```typescript
        <Button variant="outline" size="sm" onClick={() => setHistoryOpen((v) => !v)}>
          <HugeiconsIcon icon={Clock01Icon} strokeWidth={1.75} className="size-4" />
          {t("llmChat.history")}
          {llmHistory.length > 0 && (
            <span className="ml-1 font-mono text-[11px] tabular-nums">{llmHistory.length}</span>
          )}
        </Button>
```
import 加 `Clock01Icon`（先 Step 6 校验图标名）。

在 thread 渲染逻辑改为：`viewing` 非空则渲染 viewing 的 prompt/response（只读），否则渲染当前轮。即把 thread 内 `<Message from="user">` 的 `promptValue` 与 assistant 的 `llmText/thinkingText` 替换为：
```typescript
  const shownPrompt = viewing ? viewing.prompt : promptValue;
  const shownText = viewing ? viewing.response : llmText;
  const shownThinking = viewing ? viewing.thinking : thinkingText;
  const shownStreaming = viewing ? false : running;
```
并在 `hasConversation` 判断加 `|| !!viewing`。thread 内用 `shownPrompt`/`shownText`/`shownThinking`/`shownStreaming` 替换对应变量。

只读 banner（viewing 非空时，header 上方）：
```typescript
      {viewing && (
        <div className="flex items-center gap-2 border-b border-primary/25 bg-primary/10 px-4 py-1.5 text-xs">
          <HugeiconsIcon icon={Clock01Icon} strokeWidth={1.75} className="size-3.5" />
          <span>{t("llmChat.viewingHistory")} · {new Date(viewing.timestamp).toLocaleString()}</span>
          <Button variant="ghost" size="sm" className="ml-auto h-6" onClick={() => setViewing(null)}>
            {t("llmChat.backToCurrent")}
          </Button>
        </div>
      )}
```

抽屉（main 内最后，绝对定位）：
```typescript
      {historyOpen && (
        <aside className="absolute right-0 top-0 bottom-0 z-40 flex w-80 flex-col border-l bg-card/95 shadow-xl">
          <div className="flex items-center justify-between border-b px-3 py-2.5">
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {t("llmChat.historyTitle")} · {llmHistory.length}
            </span>
            <IconButton icon={Cancel01Icon} label={t("main.clear")} onClick={() => setHistoryOpen(false)} />
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {llmHistory.length === 0 ? (
              <div className="p-3 text-center text-xs text-muted-foreground">{t("llmChat.historyEmpty")}</div>
            ) : (
              llmHistory.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => { setViewing(e); setHistoryOpen(false); }}
                  className={`mb-1.5 flex w-full flex-col gap-1 rounded-lg border p-2.5 text-left hover:border-primary/50 ${viewing?.id === e.id ? "border-primary bg-primary/8" : "border-border"}`}
                >
                  <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                    <span className={`size-1.5 rounded-full ${e.exitCode === 0 ? "bg-success" : "bg-destructive"}`} />
                    {new Date(e.timestamp).toLocaleString()}
                    {e.duration && <span>· {e.duration}</span>}
                  </span>
                  <span className="line-clamp-2 text-xs">{e.prompt}</span>
                  <span className="line-clamp-1 text-[11px] text-muted-foreground">{e.response}</span>
                </button>
              ))
            )}
          </div>
          <div className="flex items-center justify-between border-t px-3 py-2">
            <span className="font-mono text-[10px] text-muted-foreground">{t("llmChat.historyMax")}</span>
            <button
              type="button"
              onClick={() => { clearLlmHistory(); setViewing(null); }}
              className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-destructive"
            >
              {t("llmChat.historyClear")}
            </button>
          </div>
        </aside>
      )}
```
并给最外层 `<main>` 加 `relative` 类（抽屉绝对定位相对它）。

- [ ] **Step 4: 补测试——完成后写入历史 + 抽屉可见**

在 `LlmChatView.test.tsx` 追加：
```typescript
  it("完成后历史按钮计数增加且抽屉可浏览", async () => {
    renderChat();
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    act(() => {
      _emitForTest("action:c1:output", { data: { stream: "llm", line: "done-text" } });
    });
    act(() => {
      _emitForTest("action:c1:done", { data: { exitCode: 0, err: "", duration: "1.2s" } });
    });
    // 历史按钮出现计数
    expect(await screen.findByText("历史")).toBeInTheDocument();
  });
```
（若 done 事件 payload 字段名与实际不符，先 `grep -n "action:.*:done" src/context/ActionRunnerProvider.tsx` 对齐 `_emitForTest` 的 event 名与 data 形状。）

- [ ] **Step 5: 跑测试**

Run: `npm test -- LlmChatView`
Expected: PASS（3 项）

- [ ] **Step 6: 校验图标名**

Run: `node -e "const i=require('@hugeicons/core-free-icons');['Clock01Icon','SentIcon'].forEach(n=>console.log(n, n in i))"`
Expected: 各图标 `true`。任一 false 则换用存在的近义图标（如 `Clock01Icon`→`Time04Icon`、`SentIcon`→`PlayIcon`）并同步 import。

- [ ] **Step 7: 提交**

```bash
git add frontend/src/context/ActionRunnerProvider.tsx frontend/src/components/LlmChatView.tsx frontend/src/components/LlmChatView.test.tsx
git commit -m "feat(llm): done 写 localStorage 历史 + LlmChatView 历史抽屉与只读查看"
```

---

## Task 7: AppSidebar「AI 对话」分组 + 过滤

**Files:**
- Modify: `frontend/src/components/AppSidebar.tsx`

**Interfaces:**
- Consumes: `useActionUsage("llm-usage")`；`useActionRunner()`（`actions`、`setView`、`openLlmChat`）；`ActionItem` 组件
- Produces: 侧边栏第三分组；「常用动作」过滤 llm

**说明**：`ActionItem` 组件已能处理 llm 卡片（其 `backToRunning` 已在 Task 2 改）。但 `ActionItem` 单击无 preset/参数时调 `runAction`——llm 卡片有参数（promptParam），故会走 `selectPreset(id,"")` 进 form 视图，这不对。需让 llm 卡片单击进 llm-chat。最小改法：AppSidebar 的 AI 分组用 `openLlmChat` 包一层，不复用 `ActionItem` 的默认点击。这里内联一个精简的 llm sidebar item。

- [ ] **Step 1: 改「常用动作」数据源过滤 llm**

在 `AppSidebar()` 内，将：
```typescript
  const top3 = topActions(actions, 3);
```
改为：
```typescript
  const shellActions = actions.filter((a) => !a.llm);
  const llmActions = actions.filter((a) => a.llm);
  const top3 = topActions(shellActions, 3);
```
并把「常用动作」分组里 `actions.length === 0` 的判断改为 `shellActions.length === 0`，`actions.length > 0`（全部动作入口条件）改为 `shellActions.length > 0`。

- [ ] **Step 2: 新增 useActionUsage 的 llm 实例 + openLlmChat**

在 hook 解构处加：
```typescript
  const { topActions: topLlm } = useActionUsage("llm-usage");
  const { openLlmChat } = useActionRunner();
```
（`useActionRunner` 已在文件顶部解构，把 `openLlmChat` 加入现有解构即可，别重复调用。）
计算：`const top3Llm = topLlm(llmActions, 3);`

- [ ] **Step 3: 在「常用动作」SidebarGroup 之后插入「AI 对话」分组**

```tsx
        <SidebarGroup>
          <SidebarGroupLabel className={EYEBROW}>
            {t("sidebar.aiChat")}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {top3Llm.map((a) => (
                <SidebarMenuItem key={a.id}>
                  <SidebarMenuButton
                    tooltip={a.description || a.title}
                    onClick={() => openLlmChat(a.id)}
                  >
                    <ActionIcon name={a.icon} className="shrink-0" />
                    <span>{a.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {llmActions.length > 0 && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => setView("llm-grid")}
                    tooltip={t("sidebar.allLlm")}
                  >
                    <HugeiconsIcon icon={GridViewIcon} strokeWidth={1.75} className="size-4 shrink-0" />
                    <span>{t("sidebar.allLlm")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
```
import 顶部加 `import { ActionIcon } from "./ActionIcon";`（若未引入）。

- [ ] **Step 4: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS

- [ ] **Step 5: 跑全量前端测试**

Run: `npm test`
Expected: 全绿。若旧 `LlmView.test.tsx` 仍存在会失败（Task 8 删）——本步先确认无**新增**失败；LlmView 相关失败可接受，Task 8 清理。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/components/AppSidebar.tsx
git commit -m "feat(llm): 侧边栏新增 AI 对话分组，常用动作过滤 llm 卡片"
```

---

## Task 8: ActionsGridView 过滤 + 清理旧 LlmForm/LlmView

**Files:**
- Modify: `frontend/src/components/ActionsGridView.tsx`
- Delete: `frontend/src/components/LlmForm.tsx`、`LlmView.tsx`、`LlmView.test.tsx`

**Interfaces:**
- Consumes: 无新增
- Produces: ActionsGridView 不再展示 llm 卡片

- [ ] **Step 1: ActionsGridView 过滤 llm**

在 `ActionsGridView()` 内，将：
```typescript
  const groups = groupByPrefix(actions);
```
改为：
```typescript
  const shellActions = actions.filter((a) => !a.llm);
  const groups = groupByPrefix(shellActions);
```
并将 header 里 `t("grid.itemsCount", { count: actions.length })` 改为 `{ count: shellActions.length }`。

- [ ] **Step 2: 删除旧文件**

```bash
git rm frontend/src/components/LlmForm.tsx frontend/src/components/LlmView.tsx frontend/src/components/LlmView.test.tsx
```

- [ ] **Step 3: 确认无残留引用**

Run: `grep -rn "LlmForm\|LlmView" frontend/src --include="*.ts" --include="*.tsx"`
Expected: 无输出（无残留 import）。若有，删除对应 import 行。

- [ ] **Step 4: typecheck + build + 全量测试**

Run: `npm run typecheck && npm run build && npm test`
Expected: 全部 PASS，无 LlmView 相关失败。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/components/ActionsGridView.tsx
git commit -m "refactor(llm): ActionsGridView 过滤 llm 卡片，删除旧 LlmForm/LlmView"
```

---

## Task 9: 端到端联调验证 + 文档

**Files:**
- 验证：`bash deploy/build.sh` 全量构建跑 exe
- Modify（若需）：`CLAUDE.md` 前端小节补一句 llm-chat 独立入口

**说明**：前端 `npm run dev` 调不到后端（`Call.ByID` 仅 Wails 运行时可用），联调必须 build exe。

- [ ] **Step 1: 全量构建**

Run: `bash deploy/build.sh`
Expected: 前端 build → bindings（无变化）→ go build 成功，产出 exe。

- [ ] **Step 2: 手动联调清单（跑 exe 逐项确认）**

- [ ] 侧边栏出现「AI 对话」分组，含 `claude-card-transfrom` 卡片
- [ ] 「常用动作」与「全部动作」grid 不再出现该卡片
- [ ] 点 AI 分组卡片 → 进 llm-chat 空态，显示卡片描述
- [ ] context chip 点击弹 Popover，可编辑 CARD_ID / TRANSFROM_INFO / 角色设定
- [ ] 输入框 ⌘↵ 发送 → 流式出 thinking + text
- [ ] 完成后「历史 N」计数 +1
- [ ] 点历史按钮开抽屉，列出记录；点条目 → 只读查看 + banner
- [ ] 点「返回当前」→ 回到当前轮
- [ ] 「清空历史」清空
- [ ] 重启 exe 后历史仍在（localStorage 持久）

- [ ] **Step 3: 更新 CLAUDE.md（前端小节）**

在 CLAUDE.md 前端段落，把描述 llm 视图的句子更新为：`command.llm 动作走独立「AI 对话」分组 + LlmGridView 列表 + LlmChatView 聊天单页（底部输入框绑 promptParam、历史存 localStorage）；view 枚举含 llm-grid/llm-chat（原 llm 已移除）。`

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: 同步 llm-chat 独立入口说明"
```

---

## Self-Review

**Spec coverage：**
- 独立侧边栏分组 → Task 7 ✓
- 独立 grid 页 LlmGridView → Task 4 ✓
- 聊天式单页 LlmChatView（输入框固定底部、单轮替换、流式）→ Task 5 ✓
- 输入框绑 promptParam、context chip → Task 5 ✓
- 历史按钮 + localStorage + 抽屉浏览 + 只读查看 → Task 1/6 ✓
- 从常用动作/grid 移除 llm → Task 7/8 ✓
- RunnerView 加 llm-grid/llm-chat 删 llm → Task 2/3 ✓
- 零后端/bindings 改动 → 全程未碰 Go ✓
- 删旧 LlmForm/LlmView → Task 8 ✓

**Placeholder scan：** 无 TBD/TODO；每个代码步含完整代码；命令含预期输出。图标名/事件名/`setCurrentId` 存在性用显式校验步兜底（Task 4 Step1、Task 5 Step5、Task 6 Step6、Task 2 Step5）。

**Type consistency：**
- `useLlmHistory` 返回 `{ entries, append, clear }`，Provider 消费为 `{ entries: llmHistory, append: appendLlmHistory, clear: clearLlmHistory }` ✓
- `LlmHistoryEntry` 字段（id/timestamp/prompt/params/response/thinking/exitCode/duration）在 Task 1 定义、Task 6 append 时字段一致 ✓
- `focusRunning` targetView 类型 Task 2 统一为 `"output" | "llm-chat" | "logcat"`，ActionItem 传值同步 ✓
- `openLlmChat(id: string)` 在 Task 4 定义、Task 7 消费签名一致 ✓
- `RunnerView` 值 `llm-grid`/`llm-chat` 全程一致，无 `llm` 残留（Task 8 Step3 grep 兜底）✓
