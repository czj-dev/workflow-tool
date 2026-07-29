# 前端 React + TypeScript 迁移 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 workflow-tool 的前端从 Vanilla JS 迁移到 React 18 + TypeScript + shadcn/ui，并加入 react-i18next 中英文切换，功能与 Phase 1 等价。

**Architecture:** 前端单项目（非 monorepo），Vite 构建产物仍落 `frontend/dist`（Go 侧 embed 零改动）。运行状态由 React Context + `useActionRunner` hook 管理，事件订阅用 `useEffect` 生命周期化。界面语言由 i18next 单例独立管理。后端（api.go / main.go / internal）完全不动。

**Tech Stack:** React 18 + TypeScript + Vite + shadcn/ui (Tailwind v4) + react-i18next + i18next + Vitest + @testing-library/react

## Global Constraints

- Wails 版本锁死 `v3.0.0-alpha2.119`，**不用 alpha.3**（绑定机制坏）。
- **不改 `api.go` / `main.go` / `internal/*`**；本计划不触发 `wails3 generate bindings` 的"因 api.go 变更"重跑，但 Task 1 会重跑一次以在干净环境重建 `frontend/bindings/`。
- 构建产物必须落 `frontend/dist/`（`main.go` 的 `//go:embed all:frontend/dist` 不变）。
- 主题用 shadcn preset `b1YofLADC`（天蓝主题色 + 薄雾蓝基础色），不手写色值。
- i18n 只覆盖**前端静态界面文案**；动作 `title/description/icon`（用户 YAML）、后端 emit 的报错、stdout/stderr 输出**不翻译**。
- 所有代码注释、commit message 用中文。

---

## Task 1: 脚手架 — 初始化 React+TS+shadcn 前端

**Files:**
- Delete: `frontend/index.html`, `frontend/main.js`, `frontend/style.css`, `frontend/package.json`, `frontend/package-lock.json`
- Regenerate: `frontend/bindings/`（整体重建）
- Create: `frontend/vite.config.ts`（init 生成后追加 vitest 配置）, `frontend/tsconfig.app.json`（追加 allowJs）, `frontend/src/test/setup.ts`

**Interfaces:**
- Produces: 一个能 `npm run build` 产出 `frontend/dist/`、且 `tsc --noEmit` 通过的 React+TS 工程；`frontend/bindings/` 重新就位。

- [ ] **Step 1: 清空旧前端（bindings 稍后重生成）**

在仓库根执行（Git Bash）：

```bash
cd frontend
rm -f index.html main.js style.css package.json package-lock.json
rm -rf node_modules bindings dist
cd ..
```

- [ ] **Step 2: shadcn 初始化（携带主题 preset）**

```bash
cd frontend
npx shadcn@latest init --preset b1YofLADC --template vite
cd ..
```

预期：生成 `index.html`、`package.json`、`vite.config.ts`、`tsconfig.json` / `tsconfig.app.json` / `tsconfig.node.json`、`components.json`、`src/main.tsx`、`src/App.tsx`、`src/index.css`、`src/lib/utils.ts` 等。若交互提示，选默认/yes。

- [ ] **Step 3: 重建 Wails bindings**

```bash
wails3 generate bindings
```

预期：重新生成 `frontend/bindings/workflow-tool/internal/api/{service.js,models.js}` 等。

- [ ] **Step 4: 安装额外依赖**

```bash
cd frontend
npm install @wailsio/runtime i18next react-i18next
npm install -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
cd ..
```

- [ ] **Step 5: tsconfig 开 allowJs（识别 bindings/*.js 的 JSDoc 类型）**

编辑 `frontend/tsconfig.app.json`，在 `compilerOptions` 内加入：

```json
"allowJs": true,
```

- [ ] **Step 6: 配置 Vitest（追加到 vite.config.ts）**

把 `frontend/vite.config.ts` 改为（保留 init 生成的 react/tailwindcss 插件与 alias，追加 `test` 与 triple-slash）：

```ts
/// <reference types="vitest" />
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
  },
})
```

- [ ] **Step 7: 创建测试 setup**

创建 `frontend/src/test/setup.ts`：

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 8: 加 test 脚本到 package.json**

在 `frontend/package.json` 的 `scripts` 加入：

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 9: 验证构建与类型**

```bash
cd frontend
npm run build
npx tsc --noEmit
cd ..
```

预期：`npm run build` 产出 `frontend/dist/`（含 `index.html`）；`tsc --noEmit` 无错误。

- [ ] **Step 10: 验证 exe 仍可启动（脚手架等价）**

```bash
go build -o workflow-tool.exe .
./workflow-tool.exe
```

预期：exe 启动，窗口显示 shadcn 默认 App 页面（此时还未接业务，看到默认欢迎页即可），证明 embed 链路通。关闭窗口。

- [ ] **Step 11: 提交**

```bash
git add frontend
git commit -m "feat: 初始化 React+TS+shadcn 前端脚手架（preset 主题、vitest）"
```

---

## Task 2: i18n 基础设施

**Files:**
- Create: `frontend/src/i18n/index.ts`, `frontend/src/i18n/locales/zh.json`, `frontend/src/i18n/locales/en.json`, `frontend/src/i18n/i18n.test.ts`
- Modify: `frontend/src/main.tsx`（import i18n）

**Interfaces:**
- Produces: 默认导出的 i18next 实例，`lng` 为 `localStorage('lang')` 或 `'zh'`；组件可用 `useTranslation()`。

- [ ] **Step 1: 写文案资源 zh.json**

创建 `frontend/src/i18n/locales/zh.json`：

```json
{
  "sidebar.title": "动作",
  "main.selectAction": "选择一个动作",
  "main.stop": "停止",
  "main.clear": "清空",
  "main.copy": "复制",
  "main.copied": "已复制",
  "empty.noActions": "（无动作，在 actions/ 放 YAML）",
  "error.loadFailed": "加载失败",
  "error.startFailed": "启动失败",
  "output.stderrPrefix": "[stderr] ",
  "output.exitLine": "--- 退出码 {{exitCode}}{{err}} ---",
  "output.errSuffix": "  错误: {{err}}"
}
```

- [ ] **Step 2: 写文案资源 en.json**

创建 `frontend/src/i18n/locales/en.json`：

```json
{
  "sidebar.title": "Actions",
  "main.selectAction": "Select an action",
  "main.stop": "Stop",
  "main.clear": "Clear",
  "main.copy": "Copy",
  "main.copied": "Copied",
  "empty.noActions": "(No actions. Put YAML in actions/)",
  "error.loadFailed": "Load failed",
  "error.startFailed": "Start failed",
  "output.stderrPrefix": "[stderr] ",
  "output.exitLine": "--- exit code {{exitCode}}{{err}} ---",
  "output.errSuffix": "  error: {{err}}"
}
```

- [ ] **Step 3: 写 i18n 初始化（TDD：先写测试）**

创建 `frontend/src/i18n/i18n.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import i18n from "./index";

// i18n 是单例（模块加载时 init 一次），测试间状态会泄漏，
// 故每个测试前重置语言为 zh 并清空 localStorage，保证隔离。
describe("i18n", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("zh");
  });

  it("中文文案正确", () => {
    expect(i18n.language).toMatch(/^zh/);
    expect(i18n.t("main.stop")).toBe("停止");
  });

  it("切换到 en 后文案变化", async () => {
    await i18n.changeLanguage("en");
    expect(i18n.t("main.stop")).toBe("Stop");
  });

  it("支持插值", () => {
    expect(i18n.t("output.exitLine", { exitCode: 0, err: "" })).toBe(
      "--- 退出码 0 ---"
    );
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

```bash
cd frontend && npx vitest run src/i18n/i18n.test.ts
```

预期：FAIL（`./index` 不存在）。

- [ ] **Step 5: 实现 i18n 初始化**

创建 `frontend/src/i18n/index.ts`：

```ts
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zh from "./locales/zh.json";
import en from "./locales/en.json";

const saved = localStorage.getItem("lang");

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: saved || "zh",
  fallbackLng: "zh",
  interpolation: { escapeValue: false },
});

export default i18n;
```

- [ ] **Step 6: 运行测试确认通过**

```bash
npx vitest run src/i18n/i18n.test.ts
```

预期：3 个测试 PASS。

- [ ] **Step 7: main.tsx 引入 i18n**

在 `frontend/src/main.tsx` 顶部（其他 import 之前）加入：

```ts
import "./i18n";
```

- [ ] **Step 8: 类型与构建校验**

```bash
npx tsc --noEmit && npm run build
```

预期：无错误，产出 dist。

> 注：`resolveJsonModule` 在 Vite React TS 模板默认开启，import JSON 无需额外配置。

- [ ] **Step 9: 提交**

```bash
git add frontend/src/i18n frontend/src/main.tsx
git commit -m "feat: 接入 react-i18next，中英文案 + localStorage 记忆"
```

---

## Task 3: 事件类型 + ActionRunnerProvider + useActionRunner（核心，TDD）

**Files:**
- Create: `frontend/src/types/events.ts`, `frontend/src/context/ActionRunnerProvider.tsx`, `frontend/src/hooks/useActionRunner.ts`, `frontend/src/context/ActionRunnerProvider.test.tsx`

**Interfaces:**
- Consumes: `ListActions` / `RunAction` / `CancelAction`（来自 `../../bindings/workflow-tool/internal/api/service.js`），`ActionItem`（来自 `../../bindings/workflow-tool/internal/api/models.js`），`Events`（来自 `@wailsio/runtime`）。
- Produces: `ActionRunnerProvider` 组件 + `useActionRunner()` hook，返回 `{ actions, errors, currentId, lines, status, exitInfo, runAction, cancel, clearOutput, copyOutput }`。

- [ ] **Step 1: 写事件类型**

创建 `frontend/src/types/events.ts`：

```ts
// 后端 emit 的 output 事件 payload
export interface OutputEventData {
  stream: "stdout" | "stderr";
  line: string;
}

// 后端 emit 的 done 事件 payload
export interface DoneEventData {
  exitCode: number;
  err: string;
  duration: string;
}
```

- [ ] **Step 2: 写 Provider 测试（TDD）**

创建 `frontend/src/context/ActionRunnerProvider.test.tsx`：

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";

// mock bindings
const mockListActions = vi.fn();
const mockRunAction = vi.fn(() => Promise.resolve());
const mockCancelAction = vi.fn();
vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: (...a: unknown[]) => mockListActions(...a),
  RunAction: (...a: unknown[]) => mockRunAction(...a),
  CancelAction: (...a: unknown[]) => mockCancelAction(...a),
}));

// mock @wailsio/runtime 的 Events.On：记录回调，返回取消订阅
const listeners: Record<string, (e: unknown) => void> = {};
const mockOn = vi.fn((name: string, cb: (e: unknown) => void) => {
  listeners[name] = cb;
  return () => { delete listeners[name]; };
});
vi.mock("@wailsio/runtime", () => ({ Events: { On: (...a: unknown[]) => mockOn(...a) } }));

import { ActionRunnerProvider, _emitForTest } from "./ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";

const wrapper = ({ children }: { children: ReactNode }) =>
  <ActionRunnerProvider>{children}</ActionRunnerProvider>;

beforeEach(() => {
  Object.keys(listeners).forEach((k) => delete listeners[k]);
  mockListActions.mockReset();
  mockRunAction.mockReset().mockResolvedValue(undefined);
  mockCancelAction.mockReset();
  mockOn.mockClear();
});

describe("ActionRunnerProvider", () => {
  it("挂载时拉取动作列表", async () => {
    mockListActions.mockResolvedValue({
      actions: [{ id: "a1", title: "A1", icon: "▶", description: "" }],
      errors: [],
    });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    expect(result.current.actions).toHaveLength(1);
    expect(result.current.actions[0].id).toBe("a1");
  });

  it("runAction 后 status=running 并订阅事件", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => { await result.current.runAction("a1"); });
    expect(result.current.status).toBe("running");
    expect(mockRunAction).toHaveBeenCalledWith("a1");
    expect(mockOn).toHaveBeenCalledWith("action:a1:output", expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith("action:a1:done", expect.any(Function));
  });

  it("收到 output 事件追加行（stderr 加前缀）", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => { await result.current.runAction("a1"); });
    act(() => {
      _emitForTest("action:a1:output", { data: { stream: "stderr", line: "boom" } });
      _emitForTest("action:a1:output", { data: { stream: "stdout", line: "hi" } });
    });
    expect(result.current.lines).toEqual(["[stderr] boom", "hi"]);
  });

  it("收到 done 事件（exitCode 0）置 status=done", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => { await result.current.runAction("a1"); });
    act(() => {
      _emitForTest("action:a1:done", { data: { exitCode: 0, err: "", duration: "1s" } });
    });
    expect(result.current.status).toBe("done");
    expect(result.current.exitInfo?.exitCode).toBe(0);
  });

  it("收到 done 事件（exitCode≠0）置 status=error", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => { await result.current.runAction("a1"); });
    act(() => {
      _emitForTest("action:a1:done", { data: { exitCode: 2, err: "oops", duration: "1s" } });
    });
    expect(result.current.status).toBe("error");
  });

  it("cancel 调用 CancelAction", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => { await result.current.runAction("a1"); });
    act(() => result.current.cancel());
    expect(mockCancelAction).toHaveBeenCalledWith("a1");
  });

  it("clearOutput 清空 lines", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => { await result.current.runAction("a1"); });
    act(() => _emitForTest("action:a1:output", { data: { stream: "stdout", line: "x" } }));
    act(() => result.current.clearOutput());
    expect(result.current.lines).toEqual([]);
  });
});
```

> 说明：测试通过 `_emitForTest` 触发被 mock 的 `Events.On` 回调，避免直接访问内部 listeners。

- [ ] **Step 3: 运行测试确认失败**

```bash
npx vitest run src/context/ActionRunnerProvider.test.tsx
```

预期：FAIL（模块不存在）。

- [ ] **Step 4: 实现 Provider**

创建 `frontend/src/context/ActionRunnerProvider.tsx`：

```tsx
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Events } from "@wailsio/runtime";
import { useTranslation } from "react-i18next";
import {
  ListActions,
  RunAction,
  CancelAction,
} from "../../bindings/workflow-tool/internal/api/service.js";
import type { ActionItem } from "../../bindings/workflow-tool/internal/api/models.js";
import type { OutputEventData, DoneEventData } from "../types/events";

type Status = "idle" | "running" | "done" | "error";
interface ExitInfo {
  exitCode: number;
  err: string;
  duration: string;
}

export interface RunnerContextValue {
  actions: ActionItem[];
  errors: string[];
  currentId: string | null;
  lines: string[];
  status: Status;
  exitInfo: ExitInfo | null;
  runAction: (id: string) => Promise<void>;
  cancel: () => void;
  clearOutput: () => void;
  copyOutput: () => Promise<void>;
}

// 事件分发表：测试用 _emitForTest 触发；运行时由 Events.On 回调写入
const handlers: Record<string, (e: unknown) => void> = {};
// 测试辅助：模拟后端 emit 一个事件
export function _emitForTest(name: string, e: unknown) {
  handlers[name]?.(e);
}

export const RunnerContext = createContext<RunnerContextValue | null>(null);

export function ActionRunnerProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [exitInfo, setExitInfo] = useState<ExitInfo | null>(null);
  const linesRef = useRef<string[]>([]);
  linesRef.current = lines;

  // 挂载时拉取动作列表
  useEffect(() => {
    ListActions()
      .then((res) => {
        setActions((res && res.actions) || []);
        setErrors((res && res.errors) || []);
      })
      .catch((e) => setErrors([t("error.loadFailed") + ": " + e]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 按 currentId 订阅事件
  useEffect(() => {
    if (!currentId) return;
    const unsubs: Array<() => void> = [];

    const onOutput = (e: unknown) => {
      const d = (((e as { data?: unknown })?.data) || {}) as OutputEventData;
      const prefix = d.stream === "stderr" ? t("output.stderrPrefix") : "";
      setLines((prev) => [...prev, prefix + (d.line || "")]);
    };
    const onDone = (e: unknown) => {
      const d = (((e as { data?: unknown })?.data) || {}) as DoneEventData;
      const errSuffix = d.err ? t("output.errSuffix", { err: d.err }) : "";
      setLines((prev) => [
        ...prev,
        t("output.exitLine", { exitCode: d.exitCode, err: errSuffix }),
      ]);
      setStatus(d.exitCode === 0 ? "done" : "error");
      setExitInfo(d);
    };

    handlers[`action:${currentId}:output`] = onOutput;
    handlers[`action:${currentId}:done`] = onDone;
    unsubs.push(Events.On(`action:${currentId}:output`, onOutput));
    unsubs.push(Events.On(`action:${currentId}:done`, onDone));

    return () => {
      delete handlers[`action:${currentId}:output`];
      delete handlers[`action:${currentId}:done`];
      unsubs.forEach((fn) => fn && fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  const runAction = async (id: string) => {
    setLines([]);
    setCurrentId(id);
    setStatus("running");
    setExitInfo(null);
    try {
      await RunAction(id);
    } catch (e) {
      setLines((prev) => [...prev, t("error.startFailed") + ": " + e]);
      setStatus("error");
    }
  };

  const cancel = () => {
    if (currentId) CancelAction(currentId);
  };

  const clearOutput = () => setLines([]);

  const copyOutput = async () => {
    await navigator.clipboard.writeText(linesRef.current.join("\n"));
  };

  const value: RunnerContextValue = {
    actions,
    errors,
    currentId,
    lines,
    status,
    exitInfo,
    runAction,
    cancel,
    clearOutput,
    copyOutput,
  };

  return <RunnerContext.Provider value={value}>{children}</RunnerContext.Provider>;
}
```

- [ ] **Step 5: 实现 hook**

创建 `frontend/src/hooks/useActionRunner.ts`：

```ts
import { useContext } from "react";
import { RunnerContext, type RunnerContextValue } from "../context/ActionRunnerProvider";

export function useActionRunner(): RunnerContextValue {
  const ctx = useContext(RunnerContext);
  if (!ctx) {
    throw new Error("useActionRunner 必须在 ActionRunnerProvider 内使用");
  }
  return ctx;
}
```

- [ ] **Step 6: 运行测试确认通过**

```bash
npx vitest run src/context/ActionRunnerProvider.test.tsx
```

预期：7 个测试 PASS。

- [ ] **Step 7: 类型与构建校验**

```bash
npx tsc --noEmit && npm run build
```

预期：无错误。

- [ ] **Step 8: 提交**

```bash
git add frontend/src/types frontend/src/context frontend/src/hooks
git commit -m "feat: ActionRunnerProvider + useActionRunner（事件流状态管理，含单测）"
```

---

## Task 4: AppSidebar（shadcn Sidebar 组件）+ ActionItem

**Files:**
- Create: `frontend/src/components/AppSidebar.tsx`, `frontend/src/components/ActionItem.tsx`, `frontend/src/components/AppSidebar.test.tsx`
- 需先添加 shadcn 组件：`sidebar`（自带折叠，`collapsible="icon"`）

**Interfaces:**
- Consumes: `useActionRunner()` 的 `actions` / `errors` / `currentId` / `status` / `runAction`；`useTranslation()`；shadcn Sidebar context（由 App.tsx 的 `SidebarProvider` 提供）。
- Produces: `<AppSidebar />` —— 基于 shadcn Sidebar 的可折叠侧边栏。

- [ ] **Step 1: 添加 shadcn 组件（sidebar 及后续所需）**

```bash
cd frontend
npx shadcn@latest add sidebar scroll-area card
cd ..
```

预期：生成 `src/components/ui/{sidebar,scroll-area,card}.tsx`。`sidebar` 会自动安装其依赖（`button`、`separator`、`sheet`、`input`、`skeleton`、`tooltip`）；`scroll-area` 供 OutputConsole、`card` 供 OutputPanel 使用（Task 5）。若提示确认依赖，选 yes。

- [ ] **Step 2: 写 ActionItem（Sidebar 菜单项）**

创建 `frontend/src/components/ActionItem.tsx`：

```tsx
import {
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
} from "@/components/ui/sidebar";
import type { ActionItem as ActionItemType } from "../../bindings/workflow-tool/internal/api/models.js";
import { useActionRunner } from "../hooks/useActionRunner";

export function ActionItem({ action }: { action: ActionItemType }) {
  const { currentId, status, runAction } = useActionRunner();
  const isCurrent = currentId === action.id;
  const mark =
    status === "running" ? "●" : status === "done" ? "✓" : status === "error" ? "✗" : "";

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isCurrent}
        tooltip={action.description || action.title}
        onClick={() => runAction(action.id)}
      >
        {action.icon && <span>{action.icon}</span>}
        <span>{action.title}</span>
        {isCurrent && mark && <SidebarMenuBadge>{mark}</SidebarMenuBadge>}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
```

> 折叠（`collapsible="icon"`）时，`SidebarMenuButton` 自动只显示 icon（emoji）并通过 `tooltip` 显示标题/描述。

- [ ] **Step 3: 写 AppSidebar（shadcn Sidebar）**

创建 `frontend/src/components/AppSidebar.tsx`：

```tsx
import { useTranslation } from "react-i18next";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";
import { ActionItem } from "./ActionItem";

export function AppSidebar() {
  const { t } = useTranslation();
  const { actions, errors } = useActionRunner();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <span className="px-2 text-xs font-semibold text-muted-foreground">
              {t("sidebar.title")}
            </span>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {actions.length === 0 && errors.length === 0 && (
                <p className="px-2 text-sm text-muted-foreground">
                  {t("empty.noActions")}
                </p>
              )}
              {actions.map((a) => (
                <ActionItem key={a.id} action={a} />
              ))}
              {errors.map((e, i) => (
                <SidebarMenuItem key={`err-${i}`}>
                  <span className="px-2 text-sm text-destructive">⚠ {e}</span>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
```

> `Sidebar` 必须在 `SidebarProvider` 内使用（Task 6 的 App.tsx 提供）。`collapsible="icon"` 让侧边栏可折叠为图标栏；折叠/展开由 OutputToolbar 的 `SidebarTrigger`（Task 5）触发。

- [ ] **Step 4: 写渲染测试**

创建 `frontend/src/components/AppSidebar.test.tsx`：

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({
    actions: [{ id: "a1", title: "打个招呼", icon: "👋", description: "d" }],
    errors: [],
  }),
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => {} } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { AppSidebar } from "./AppSidebar";

describe("AppSidebar", () => {
  it("渲染动作列表", async () => {
    render(
      <ActionRunnerProvider>
        <SidebarProvider>
          <AppSidebar />
        </SidebarProvider>
      </ActionRunnerProvider>
    );
    expect(await screen.findByText("打个招呼")).toBeInTheDocument();
    expect(screen.getByText("动作")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: 运行测试确认通过**

```bash
npx vitest run src/components/AppSidebar.test.tsx
```

预期：PASS。

- [ ] **Step 6: 类型与构建校验**

```bash
npx tsc --noEmit && npm run build
```

预期：无错误。

- [ ] **Step 7: 提交**

```bash
git add frontend/src/components
git commit -m "feat: AppSidebar（shadcn Sidebar）+ ActionItem 组件（可折叠、状态灯）"
```

---

## Task 5: OutputPanel + OutputToolbar + OutputConsole + LangSwitch

**Files:**
- Create: `frontend/src/components/OutputPanel.tsx`, `frontend/src/components/OutputToolbar.tsx`, `frontend/src/components/OutputConsole.tsx`, `frontend/src/components/LangSwitch.tsx`, `frontend/src/components/OutputPanel.test.tsx`

**Interfaces:**
- Consumes: `useActionRunner()`（`currentId` / `actions` / `lines` / `status` / `cancel` / `clearOutput` / `copyOutput`）；`useTranslation()`；i18next 实例。
- Produces: `<OutputPanel />` 渲染右栏（含工具栏 + 终端区 + 语言切换）。

- [ ] **Step 1: 写 LangSwitch**

创建 `frontend/src/components/LangSwitch.tsx`：

```tsx
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export function LangSwitch() {
  const { i18n } = useTranslation();
  const next = i18n.language?.startsWith("zh") ? "en" : "zh";
  const label = i18n.language?.startsWith("zh") ? "EN" : "中";
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        i18n.changeLanguage(next);
        localStorage.setItem("lang", next);
      }}
    >
      {label}
    </Button>
  );
}
```

- [ ] **Step 2: 写 OutputConsole**

创建 `frontend/src/components/OutputConsole.tsx`：

```tsx
import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useActionRunner } from "../hooks/useActionRunner";

export function OutputConsole() {
  const { lines } = useActionRunner();
  const bottomRef = useRef<HTMLDivElement>(null);

  // 新行自动滚到底
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [lines]);

  return (
    <ScrollArea className="flex-1 bg-zinc-950">
      <pre className="p-4 font-mono text-[13px] leading-relaxed text-zinc-100 whitespace-pre-wrap">
        {lines.join("\n")}
        <div ref={bottomRef} />
      </pre>
    </ScrollArea>
  );
}
```

- [ ] **Step 3: 写 OutputToolbar**

创建 `frontend/src/components/OutputToolbar.tsx`：

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";
import { LangSwitch } from "./LangSwitch";

export function OutputToolbar() {
  const { t } = useTranslation();
  const { actions, currentId, status, cancel, clearOutput, copyOutput } =
    useActionRunner();
  const [copied, setCopied] = useState(false);
  const current = actions.find((a) => a.id === currentId);
  const running = status === "running";

  const onCopy = async () => {
    await copyOutput();
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <header className="flex items-center justify-between border-b px-4 py-2">
      <div className="flex items-center gap-2">
        <SidebarTrigger />
        <span className="font-semibold">
          {current
            ? `${current.icon || "▶"} ${current.title}`
            : t("main.selectAction")}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onCopy}>
          {copied ? t("main.copied") : t("main.copy")}
        </Button>
        <Button variant="outline" size="sm" onClick={clearOutput}>
          {t("main.clear")}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={!running}
          onClick={cancel}
        >
          {t("main.stop")}
        </Button>
        <LangSwitch />
      </div>
    </header>
  );
}
```

- [ ] **Step 4: 写 OutputPanel**

创建 `frontend/src/components/OutputPanel.tsx`：

```tsx
import { Card } from "@/components/ui/card";
import { OutputToolbar } from "./OutputToolbar";
import { OutputConsole } from "./OutputConsole";

export function OutputPanel() {
  return (
    <main className="flex flex-1 flex-col min-w-0">
      <OutputToolbar />
      <Card className="m-4 flex-1 overflow-hidden p-0">
        <OutputConsole />
      </Card>
    </main>
  );
}
```

- [ ] **Step 5: 写渲染测试**

创建 `frontend/src/components/OutputPanel.test.tsx`：

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({
    actions: [{ id: "a1", title: "A1", icon: "▶", description: "" }],
    errors: [],
  }),
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => {} } }));

import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { OutputPanel } from "./OutputPanel";

describe("OutputPanel", () => {
  it("渲染默认提示与工具栏按钮", async () => {
    render(<ActionRunnerProvider><OutputPanel /></ActionRunnerProvider>);
    expect(await screen.findByText("选择一个动作")).toBeInTheDocument();
    expect(screen.getByText("停止")).toBeInTheDocument();
    expect(screen.getByText("清空")).toBeInTheDocument();
    expect(screen.getByText("复制")).toBeInTheDocument();
    // 语言切换默认显示 EN（当前中文）
    expect(screen.getByText("EN")).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: 运行测试确认通过**

```bash
npx vitest run src/components/OutputPanel.test.tsx
```

预期：PASS。

- [ ] **Step 7: 类型与构建校验**

```bash
npx tsc --noEmit && npm run build
```

预期：无错误。

- [ ] **Step 8: 提交**

```bash
git add frontend/src/components
git commit -m "feat: OutputPanel/Toolbar/Console/LangSwitch 组件（清空、复制、语言切换）"
```

---

## Task 6: App 组装 + 入口

**Files:**
- Modify: `frontend/src/App.tsx`, `frontend/src/main.tsx`, `frontend/index.html`

**Interfaces:**
- Consumes: `ActionRunnerProvider`、`AppSidebar`、`OutputPanel`（前序任务）。
- Produces: 完整双栏应用，`main.tsx` 挂载。

- [ ] **Step 1: 写 App.tsx**

把 `frontend/src/App.tsx` 替换为：

```tsx
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { ActionRunnerProvider } from "./context/ActionRunnerProvider";
import { AppSidebar } from "./components/AppSidebar";
import { OutputPanel } from "./components/OutputPanel";

export default function App() {
  return (
    <ActionRunnerProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <OutputPanel />
        </SidebarInset>
      </SidebarProvider>
    </ActionRunnerProvider>
  );
}
```

> `SidebarProvider` 管理侧边栏布局与折叠状态；`AppSidebar` 是可折叠侧边栏，`SidebarInset` 是右侧主内容区（自动让出侧边栏宽度）。

- [ ] **Step 2: 确认 main.tsx**

`frontend/src/main.tsx` 应为（Task 2 已加 `import "./i18n"`；确认结构与下一致）：

```tsx
import "./i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

> 注意：shadcn vite 模板的 `index.html` 挂载点 id 可能是 `root`。下一步在 index.html 统一为 `app`，二者保持一致即可（此处用 `app`）。

- [ ] **Step 3: 调整 index.html 挂载点与标题**

把 `frontend/index.html` 的 `<body>` 内挂载点改为 `<div id="app"></div>`，`<title>` 改为 `Workflow Tool`，并确保引入 `/src/main.tsx`。完整示例：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Workflow Tool</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: 类型与构建校验**

```bash
cd frontend && npx tsc --noEmit && npm run build && cd ..
```

预期：无错误，`frontend/dist/index.html` 产出。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/App.tsx frontend/src/main.tsx frontend/index.html
git commit -m "feat: App 双栏组装 + 入口挂载"
```

---

## Task 7: exe 联调与功能等价验证

**Files:** 无新增/修改（验证任务）

- [ ] **Step 1: 全量构建**

```bash
cd frontend && npm run build && cd ..
go build -o workflow-tool.exe .
```

预期：两步均成功。

- [ ] **Step 2: 启动并验证外观**

```bash
./workflow-tool.exe
```

预期：双栏窗口；左侧"动作"标题 + 3 个示例动作；主题为天蓝主色 + 薄雾蓝基底；输出区暗底 monospace。

- [ ] **Step 3: 验证功能等价（手动）**

逐项确认（对应 spec §9）：

- [ ] 点「👋 打个招呼」→ 输出 `hello`，结束显示 `--- 退出码 0 ---`，状态灯 `✓`
- [ ] 点「🚀 部署」→ 流式输出，过程中状态灯 `●`，"停止"按钮可点击中断
- [ ] 触发 cwd 未设环境变量的动作 → 输出后端友好提示（中文，不翻译，符合边界）
- [ ] 状态灯随 running/done/error 正确变化
- [ ] "清空"按钮清空输出区
- [ ] "复制"按钮把输出写入剪贴板（粘贴验证）
- [ ] 点 "EN" → 界面静态文案切换为英文（"Actions"/"Stop"/"Clear"/"Copy" 等）；动作标题、输出内容不变
- [ ] 切到英文后关闭 exe，重新启动 → 仍为英文（localStorage 记忆生效）

- [ ] **Step 4: 全部单测回归**

```bash
cd frontend && npm test && cd ..
```

预期：所有测试 PASS。

- [ ] **Step 5: 提交（如有验证中发现的修复）**

若无修复则跳过；若有：

```bash
git add -A
git commit -m "fix: 联调验证中发现的问题修复"
```

---

## Task 8: 更新 README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新前端说明**

在 `README.md` 的「项目结构」与「构建」相关处，把前端描述从 Vanilla JS 更新为 React + TS + shadcn/ui；在构建流程补一句 dev 联调约束：

> 改前端：`cd frontend && npm run build && cd .. && go build`。单独 `npm run dev` 可调样式，但联调后端必须 `go build` 跑 exe（`Call.ByID` 仅 Wails 运行时可用）。

- [ ] **Step 2: 补 i18n 说明**

在 README 加一节或几行：界面静态文案走 `frontend/src/i18n/locales/{zh,en}.json`，新增文案只改 JSON；动作内容与后端报错不参与翻译。

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs: README 更新前端技术栈与 i18n 说明"
```

---

## Self-Review 记录

（实现前由计划作者完成；实现者无需操作）

- **Spec 覆盖**：§1-2 脚手架/技术栈 → Task 1；§3 主题 → Task 1 preset；§4 组件结构 → Task 4/5/6；§5 状态/数据流 → Task 3；§5.5 语言状态 → Task 2/5；§6 类型 → Task 1(allowJs)+Task 3(events)；§7 构建 → Task 1/7；§8 增强 → Task 4(状态灯)+Task 5(工具栏/i18n)；§8.1 i18n → Task 2；§9 验收 → Task 7。全覆盖。
- **占位符**：无 TBD/TODO；每步含完整代码或精确命令。
- **类型一致**：`useActionRunner` 返回字段名（`actions/errors/currentId/lines/status/exitInfo/runAction/cancel/clearOutput/copyOutput`）在 Task 3 定义，Task 4/5 消费处一致；`_emitForTest`、`RunnerContext` 跨 Task 3 测试与实现一致。
