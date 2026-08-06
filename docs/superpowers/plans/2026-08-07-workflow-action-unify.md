# Workflow 交互看齐 Action 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 workflow 在侧边栏(top3 + 「全部」入口)、Grid 视图、个性图标、usage 统计上与 action 完全统一。

**Architecture:** 纯前端改造,后端零改动(`WorkflowDef.Icon` / `WorkflowItem.Icon` 透传 / binding 已就绪)。把 `useActionUsage` 泛化(参数化 storageKey + 泛型 `topActions`/`groupByPrefix`),使 workflow 复用同一套"常用排序 + 前缀分组 + 足迹"算法但数据隔离;新增 `WorkflowsGridView`(内联 `WorkflowCard`,与 `ActionCard` 同构,去掉 preset);在侧栏 / Grid / 表单的运行调用点记录 workflow usage。

**Tech Stack:** React 19 + TypeScript + Vite + Tailwind v4 + base-ui/shadcn + hugeicons;vitest + @testing-library/react。

## Global Constraints

- **后端零改动**:不动 `internal/`、`api.go`、bindings,无需 `wails3 generate bindings` / `go build`。改完前端 `cd frontend && npm run build` 即可;联调再 `bash deploy/build.sh`。
- **前端验证三件套**(vitest 须在 `frontend/` 下跑,否则读不到 config → i18n 崩):
  - `cd frontend && npm test` / 单文件 `cd frontend && npx vitest run src/<path>.test.tsx`
  - `cd frontend && npm run lint`
  - `cd frontend && npm run typecheck`
- **i18n**:新增静态文案双写 `frontend/src/i18n/locales/{zh,en}.json`;测试查中文文案。
- **复用**:`IconButton`(图标按钮)、`ActionIcon`(图标渲染)、shadcn 原子;`EYEBROW` 等宽大写常量沿用既有定义。
- **不改文档**:`docs/workflow.md` 已有 `icon` 字段说明,本次无 schema 变更,无需改文档。
- **不扩大范围**:action 的 `ParamForm.onRun` 同样不记 usage(历史现状),本次不顺带修,只在 workflow 侧做对。

---

## 设计方向(frontend-design brainstorm 结论)

**Subject / Audience / 单一目标**:高频用户在十几个 action + 若干 workflow 之间切换;目标是让 workflow 像 action 一样「侧栏只露常用的、一键进网格总览、卡片即运行」,降低发现与触发成本。

**视觉**:不引入新设计语言。`WorkflowCard` 是 `ActionCard` 的同构变体,复用精密控制台的全部签名元素:
- 琥珀图标块(`bg-primary/14`)+ 5 段足迹条(usage 驱动)
- 等宽标题(`font-mono`)、虚线分隔的底部元信息条
- hover 上浮 + 琥珀阴影;running 态呼吸边框 + `live-pulse`
- **去掉 preset chips**(workflow 无 preset 概念,docs 明确「不支持」)
- 元信息条:`{{n}} 步 · {{n}} 参数`(或 `· 无参数`),取代 action 的 `{{n}} 参数 · {{n}} 预设`

**克制**:不为 workflow 引入新的配色/字体/动效。差异化只来自内容(步骤数 vs 预设数),不来自装饰。这是「统一」诉求的正确解读 —— 一致性本身就是这次的设计目标。

**交互对称表**(action → workflow):

| 入口 | Action | Workflow(目标) |
|---|---|---|
| 侧栏分区标题 | 常用动作(`frequentActions`) | 常用工作流(`frequentWorkflows`) |
| 侧栏展示 | `topActions(actions,3)` | `topWorkflows(workflows,3)` |
| 侧栏「全部」 | → `actions-grid` | → `workflows-grid` |
| Grid 卡片点 | 有参→form / 无参→run+记 | 有参→`selectWorkflow` / 无参→`runWorkflow`+记 |
| Grid ✎ | → `selectPreset(id,"")` form | → `selectWorkflow(id)` form |
| 详情标题点 | → `edit` | → `workflow-edit`(已实现 ✅) |
| 图标 | `action.icon` | `workflow.icon`(管线已通 ✅) |

---

## File Structure

| 文件 | 责任 | 本次动作 |
|---|---|---|
| `frontend/src/hooks/useActionUsage.ts` | usage 统计算法(衰减/分组/足迹) | 改:参数化 storageKey + 泛型化 |
| `frontend/src/hooks/useActionUsage.test.ts` | hook 单测 | 改:新增 key 隔离 + 泛型用例 |
| `frontend/src/i18n/locales/{zh,en}.json` | 静态文案 | 改:新增 4 个 key |
| `frontend/src/components/WorkflowsGridView.tsx` | workflow 网格 + 内联 WorkflowCard | **新建** |
| `frontend/src/components/WorkflowsGridView.test.tsx` | 网格测试 | **新建** |
| `frontend/src/context/ActionRunnerProvider.tsx` | `RunnerView` 枚举 | 改:加 `workflows-grid` |
| `frontend/src/components/OutputPanel.tsx` | view 分派 | 改:加 `workflows-grid` 分支 |
| `frontend/src/components/AppSidebar.tsx` | 侧栏 | 改:workflow 分区 top3 + 「全部」入口 |
| `frontend/src/components/AppSidebar.test.tsx` | 侧栏测试 | 改:新增 workflow top3 用例 |
| `frontend/src/components/WorkflowItem.tsx` | 侧栏 workflow 项 | 改:handleClick 分支 + 记 usage |
| `frontend/src/components/WorkflowItem.test.tsx` | workflow 项测试 | **新建** |
| `frontend/src/components/WorkflowParamForm.tsx` | workflow 表单 | 改:`onRun` 记 usage |
| `frontend/src/components/WorkflowView.tsx` | workflow 详情 | 改:header 加返回 grid 入口 |

---

## Task 1: 泛化 useActionUsage(参数化 storageKey + 泛型)

**Files:**
- Modify: `frontend/src/hooks/useActionUsage.ts`
- Test: `frontend/src/hooks/useActionUsage.test.ts`

**Interfaces:**
- Produces: `useActionUsage(storageKey = "action-usage")`;`topActions<T extends {id:string}>`、`groupByPrefix<T extends {id:string}>` 泛型化。默认参数 `"action-usage"` 保证既有 4 个调用点(ActionItem / ActionsGridView / AppSidebar / PresetList)与全部既有测试零改动。

- [ ] **Step 1: 写失败测试 —— storageKey 隔离 + 泛型**

在 `useActionUsage.test.ts` 末尾(`describe("useActionUsage")` 内最后)新增:

```typescript
  describe("storageKey 隔离与泛型", () => {
    it("不同 storageKey 的计数互不干扰(workflow 复用算法但数据隔离)", () => {
      const { result: actionUsage } = renderHook(() =>
        useActionUsage("action-usage"),
      );
      const { result: wfUsage } = renderHook(() =>
        useActionUsage("workflow-usage"),
      );

      act(() => {
        actionUsage.current.recordUsage("shared-id");
      });

      expect(actionUsage.current.getScore("shared-id")).toBeGreaterThan(0);
      expect(wfUsage.current.getScore("shared-id")).toBe(0);
    });

    it("topActions / groupByPrefix 接受任意 { id } 形状(workflow 复用)", () => {
      const { result } = renderHook(() => useActionUsage("workflow-usage"));
      const wfs = [
        { id: "demo-x", title: "t" },
        { id: "adb-y", title: "t" },
      ] as { id: string; title: string }[];

      expect(result.current.topActions(wfs, 2).map((w) => w.id)).toEqual([
        "demo-x",
        "adb-y",
      ]);
      expect(Object.keys(result.current.groupByPrefix(wfs)).sort()).toEqual([
        "adb",
        "demo",
      ]);
    });

    it("默认 storageKey 仍为 action-usage(向后兼容)", () => {
      localStorage.setItem("action-usage", JSON.stringify({ legacy: 3 }));
      const { result } = renderHook(() => useActionUsage());
      expect(result.current.getScore("legacy")).toBe(3);
    });
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd frontend && npx vitest run src/hooks/useActionUsage.test.ts`
Expected: FAIL —— 隔离用例失败(两个实例共用 `"action-usage"`,wfUsage 也能读到 shared-id);泛型用例可能 TS 编译报错(`ActionItem[]` 不接受 `{id,title}[]`)。

- [ ] **Step 3: 改 hook —— 参数化 + 泛型**

把 `frontend/src/hooks/useActionUsage.ts` 改为(仅这三处变动:`readUsage`/`writeUsage` 加参数、`useActionUsage` 加默认参数、`topActions`/`groupByPrefix` 泛型化):

```typescript
function readUsage(key: string): UsageMap {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const clean: UsageMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) clean[k] = v;
    }
    return clean;
  } catch {
    return {};
  }
}

function writeUsage(key: string, map: UsageMap): void {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    // localStorage 写失败（隐私模式/配额）不该打断运行，退化为纯内存计数
  }
}
```

`useState` 初始化改为读传入 key;`recordUsage` 闭包带 key:

```typescript
// 使用频次：默认 action-usage；workflow 复用本 hook 时传 "workflow-usage" 实现数据隔离。
// 算法（衰减/分组/足迹）完全共享，仅 storageKey 不同。
export function useActionUsage(storageKey = "action-usage") {
  const [usage, setUsage] = useState<UsageMap>(() => readUsage(storageKey));

  const recordUsage = useCallback((id: string) => {
    setUsage((prev) => {
      const next = decayAndBump(prev, id);
      writeUsage(storageKey, next);
      return next;
    });
  }, [storageKey]);

  const getScore = useCallback((id: string) => usage[id] ?? 0, [usage]);

  // 按分数降序取前 n；分数相同（含全为 0 的首次启动）保持原顺序。
  // 泛型 <T extends { id: string }>：action 与 workflow 复用同一排序。
  const topActions = useCallback(
    <T extends { id: string }>(items: T[], n: number = DEFAULT_TOP_N) =>
      items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
          const diff = (usage[b.item.id] ?? 0) - (usage[a.item.id] ?? 0);
          return diff !== 0 ? diff : a.index - b.index;
        })
        .slice(0, n)
        .map(({ item }) => item),
    [usage],
  );

  // 按 id 第一段前缀分组；无 "-" 分隔符的归 MISC_KEY。组内保持原顺序。
  const groupByPrefix = useCallback(<T extends { id: string }>(items: T[]) => {
    const groups: Record<string, T[]> = {};
    for (const item of items) {
      const dash = item.id.indexOf("-");
      const key = dash > 0 ? item.id.slice(0, dash) : MISC_KEY;
      (groups[key] ??= []).push(item);
    }
    return groups;
  }, []);

  const footprintLevel = useCallback(
    (id: string) =>
      Math.min(
        FOOTPRINT_SEGMENTS,
        Math.ceil(Math.log2((usage[id] ?? 0) + 1)),
      ),
    [usage],
  );

  return { recordUsage, getScore, topActions, groupByPrefix, footprintLevel };
}
```

> 注:文件顶部常量(`STORAGE_KEY` 旧常量)删除——它已被参数取代。`decayAndBump` / `groupLabel` / `MISC_KEY` / `FOOTPRINT_SEGMENTS` / `DEFAULT_TOP_N` 不变。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd frontend && npx vitest run src/hooks/useActionUsage.test.ts`
Expected: PASS —— 全部既有用例(默认 key)+ 3 个新用例全绿。

- [ ] **Step 5: 全量测试 + 类型检查,确认既有调用点无破坏**

Run: `cd frontend && npm test && npm run typecheck`
Expected: PASS —— 4 个既有调用点(`ActionItem`/`ActionsGridView`/`AppSidebar`/`PresetList`)因默认参数零改动。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useActionUsage.ts frontend/src/hooks/useActionUsage.test.ts
git commit -m "refactor(frontend): useActionUsage 参数化 storageKey + 泛型化，为 workflow 复用铺路"
```

---

## Task 2: i18n 新增 workflow 侧栏 / Grid 文案

**Files:**
- Modify: `frontend/src/i18n/locales/zh.json`
- Modify: `frontend/src/i18n/locales/en.json`

**Interfaces:**
- Produces: `sidebar.frequentWorkflows`、`sidebar.allWorkflows`、`grid.wfTitle`、`grid.stepsCount`。复用既有 `grid.itemsCount`/`grid.groupsCount`/`grid.groupMisc`/`grid.noParams`/`grid.paramsCount`/`grid.editParams`。

- [ ] **Step 1: zh.json 新增 4 个 key**

在 `zh.json` 的 `"grid.editPreset": "编辑预设参数",` 行之后、`"settings.title"` 之前插入:

```json
  "grid.editPreset": "编辑预设参数",
  "grid.wfTitle": "全部工作流",
  "grid.stepsCount": "{{count}} 步",
```

并在 `"sidebar.frequentActions": "常用动作",` 之后插入两个 sidebar key:

```json
  "sidebar.frequentActions": "常用动作",
  "sidebar.frequentWorkflows": "常用工作流",
  "sidebar.allActions": "全部动作",
  "sidebar.allWorkflows": "全部工作流",
```

- [ ] **Step 2: en.json 新增对应 4 个 key**

同样位置,`en.json`:

```json
  "grid.editPreset": "Edit preset params",
  "grid.wfTitle": "All Workflows",
  "grid.stepsCount": "{{count}} steps",
```

```json
  "sidebar.frequentActions": "Frequent",
  "sidebar.frequentWorkflows": "Frequent",
  "sidebar.allActions": "All Actions",
  "sidebar.allWorkflows": "All Workflows",
```

- [ ] **Step 3: 校验 JSON 合法 + lint**

Run: `cd frontend && npm run lint`
Expected: PASS(JSON 语法合法,i18n key 未被 lint 拦截)。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/i18n/locales/zh.json frontend/src/i18n/locales/en.json
git commit -m "feat(i18n): 新增 workflow 侧栏常用/全部入口与 grid 文案"
```

---

## Task 3: 新建 WorkflowsGridView + 内联 WorkflowCard

**Files:**
- Create: `frontend/src/components/WorkflowsGridView.tsx`
- Test: `frontend/src/components/WorkflowsGridView.test.tsx`

**Interfaces:**
- Consumes: `useActionRunner()` → `workflows`/`runWorkflow`/`selectWorkflow`/`runningWorkflowId`;`useActionUsage("workflow-usage")` → `groupByPrefix`/`footprintLevel`/`recordUsage`;`ActionIcon`、`IconButton`、`groupLabel`/`MISC_KEY`/`FOOTPRINT_SEGMENTS`。
- Produces: `<WorkflowsGridView />` 组件,供 Task 4 的 OutputPanel 分派。

- [ ] **Step 1: 写失败测试 —— 分组渲染 + 点击行为**

创建 `frontend/src/components/WorkflowsGridView.test.tsx`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockListWorkflows, mockRunWorkflow, mockOn } = vi.hoisted(() => ({
  mockListWorkflows: vi.fn(),
  mockRunWorkflow: vi.fn(() => Promise.resolve()),
  mockOn: vi.fn(() => () => {}),
}));

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  RunAction: vi.fn(),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn(),
  GetFragments: vi.fn().mockResolvedValue([]),
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: vi.fn(),
  PickDirectory: vi.fn(),
  ListWorkflows: mockListWorkflows,
  RunWorkflow: mockRunWorkflow,
  CancelWorkflow: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { WorkflowsGridView } from "./WorkflowsGridView";

beforeEach(() => {
  mockListWorkflows.mockReset();
  mockRunWorkflow.mockReset().mockResolvedValue(undefined);
  mockOn.mockClear();
  localStorage.clear();
});

function wrap() {
  return (
    <ActionRunnerProvider>
      <SidebarProvider>
        <WorkflowsGridView />
      </SidebarProvider>
    </ActionRunnerProvider>
  );
}

const mkWf = (id: string, title: string, extra: Partial<{}> = {}) => ({
  id,
  title,
  icon: "hi:workflow",
  description: "",
  params: [],
  steps: [{ action: "x" }],
  ...extra,
});

describe("WorkflowsGridView", () => {
  it("按 id 前缀分组渲染 workflow 卡片与分组头", async () => {
    mockListWorkflows.mockResolvedValue({
      workflows: [
        mkWf("demo-a", "演示A"),
        mkWf("adb-b", "ADB串流"),
      ],
      errors: [],
    });
    render(wrap());
    expect(await screen.findByText("演示A")).toBeInTheDocument();
    expect(screen.getByText("ADB串流")).toBeInTheDocument();
    expect(screen.getByText("Demo")).toBeInTheDocument();
    expect(screen.getByText("ADB")).toBeInTheDocument();
  });

  it("点击无参数 workflow 卡片直接运行并记 usage", async () => {
    const user = userEvent.setup();
    mockListWorkflows.mockResolvedValue({
      workflows: [mkWf("demo-run", "直跑")],
      errors: [],
    });
    render(wrap());
    await user.click(await screen.findByText("直跑"));
    expect(mockRunWorkflow).toHaveBeenCalledWith("demo-run", {});
    expect(localStorage.getItem("workflow-usage")).toContain("demo-run");
  });

  it("点击有参数 workflow 卡片进表单,不直接运行", async () => {
    const user = userEvent.setup();
    mockListWorkflows.mockResolvedValue({
      workflows: [
        mkWf("demo-form", "带参", {
          params: [
            {
              id: "MSG",
              label: "消息",
              type: "text",
              required: false,
              default: "",
              options: [],
            },
          ],
        }),
      ],
      errors: [],
    });
    render(wrap());
    await user.click(await screen.findByText("带参"));
    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  it("渲染个性图标(emoji 原样显示)", async () => {
    mockListWorkflows.mockResolvedValue({
      workflows: [mkWf("demo-emoji", "表情", { icon: "🚀" })],
      errors: [],
    });
    render(wrap());
    expect(await screen.findByText("🚀")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd frontend && npx vitest run src/components/WorkflowsGridView.test.tsx`
Expected: FAIL —— `WorkflowsGridView` 模块不存在,导入报错。

- [ ] **Step 3: 实现 WorkflowsGridView.tsx**

创建 `frontend/src/components/WorkflowsGridView.tsx`(结构完全对标 `ActionsGridView.tsx`,去掉 preset,元信息换成 steps/params):

```tsx
import { useTranslation } from "react-i18next";
import { Edit02Icon } from "@hugeicons/core-free-icons";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { IconButton } from "./IconButton";
import { useActionRunner } from "../hooks/useActionRunner";
import {
  useActionUsage,
  groupLabel,
  FOOTPRINT_SEGMENTS,
  MISC_KEY,
} from "../hooks/useActionUsage";
import { ActionIcon } from "./ActionIcon";
import type { WorkflowItem as WorkflowItemType } from "../../bindings/workflow-tool/internal/api/models.js";

// 等宽大写 eyebrow(与 ActionsGridView 一致)
const EYEBROW =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

// Grid 页:按 id 前缀分组展示所有 workflow。点卡片 = 有参进表单 / 无参直接运行;右上 ✎ 进表单。
export function WorkflowsGridView() {
  const { t } = useTranslation();
  const { workflows, runWorkflow, selectWorkflow, runningWorkflowId } =
    useActionRunner();
  const { groupByPrefix, footprintLevel, recordUsage } =
    useActionUsage("workflow-usage");

  const groups = groupByPrefix(workflows);
  const groupEntries = Object.entries(groups).sort(([a], [b]) => {
    if (a === MISC_KEY) return 1;
    if (b === MISC_KEY) return -1;
    return a.localeCompare(b);
  });
  const groupCount = groupEntries.length;

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <h1 className="text-sm font-semibold">{t("grid.wfTitle")}</h1>
        </div>
        <span className="font-mono text-[11px] tracking-[0.14em] uppercase text-muted-foreground">
          {t("grid.itemsCount", { count: workflows.length })}
          {" · "}
          {t("grid.groupsCount", { count: groupCount })}
        </span>
      </header>

      <div className="p-4 space-y-6">
        {groupEntries.map(([key, items]) => (
          <section key={key}>
            <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 pb-3">
              <span className={EYEBROW}>
                {key === MISC_KEY ? t("grid.groupMisc") : groupLabel(key)}
              </span>
              <span className="h-px bg-border" />
              <span className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground">
                {items.length}
              </span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
              {items.map((wf) => (
                <WorkflowCard
                  key={wf.id}
                  workflow={wf}
                  running={runningWorkflowId === wf.id}
                  level={footprintLevel(wf.id)}
                  onRun={(params) => {
                    runWorkflow(wf.id, params);
                    recordUsage(wf.id);
                  }}
                  onEdit={() => selectWorkflow(wf.id)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

// ——— 内联 WorkflowCard ———
// 与 ActionCard 同构,去掉 preset(workflow 无 preset 概念),元信息换成 步骤数/参数数。
interface WorkflowCardProps {
  workflow: WorkflowItemType;
  running: boolean;
  level: number; // 足迹亮段数 0-5
  onRun: (params: Record<string, string>) => void;
  onEdit: () => void;
}

function WorkflowCard({
  workflow,
  running,
  level,
  onRun,
  onEdit,
}: WorkflowCardProps) {
  const { t } = useTranslation();
  const hasParams = (workflow.params?.length ?? 0) > 0;
  const stepCount = workflow.steps?.length ?? 0;

  const handleCardClick = () => {
    if (hasParams) {
      onEdit(); // 进 workflow-form
    } else {
      onRun({});
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleCardClick();
        }
      }}
      className={`
        group relative flex flex-col gap-2.5 rounded-lg border p-3.5 cursor-pointer
        transition-all duration-150 ease-out
        hover:border-primary/55 hover:-translate-y-0.5 hover:shadow-[0_4px_20px_-8px] hover:shadow-primary/40
        ${running ? "border-primary" : "border-border"}
      `}
    >
      {running && (
        <span className="pointer-events-none absolute inset-[-1px] rounded-lg border border-primary/60 animate-pulse" />
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/14 text-primary">
            <ActionIcon name={workflow.icon || "hi:workflow"} className="size-4" />
          </span>
          <div className="flex gap-[3px] items-center">
            {Array.from({ length: FOOTPRINT_SEGMENTS }, (_, i) => (
              <span
                key={i}
                className={`h-0.5 w-2 rounded-sm ${
                  i < level ? "bg-primary/65" : "bg-foreground/12"
                }`}
              />
            ))}
          </div>
        </div>
        {hasParams && (
          <span className="opacity-0 group-hover:opacity-100 transition-opacity">
            <IconButton
              icon={Edit02Icon}
              label={t("grid.editParams")}
              onClick={(e) => {
                e?.stopPropagation?.();
                onEdit();
              }}
            />
          </span>
        )}
      </div>

      <span className="font-mono text-sm font-semibold leading-tight tracking-[0.02em]">
        {workflow.title}
      </span>

      {workflow.description && (
        <span className="text-xs leading-relaxed text-muted-foreground line-clamp-2">
          {workflow.description}
        </span>
      )}

      <div
        className="flex items-center justify-between gap-2 border-t border-dashed border-border pt-2 mt-auto
        font-mono text-[10px] tracking-[0.06em] uppercase text-muted-foreground"
      >
        <span className="rounded bg-muted px-1.5 py-0.5 opacity-70 text-foreground">
          {t("grid.stepsCount", { count: stepCount })}
          {hasParams
            ? ` · ${t("grid.paramsCount", { count: workflow.params!.length })}`
            : ` · ${t("grid.noParams")}`}
        </span>
        {running && (
          <span className="flex items-center gap-1.5 text-primary">
            <span className="size-1.5 rounded-full bg-primary live-pulse" />
            running
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd frontend && npx vitest run src/components/WorkflowsGridView.test.tsx`
Expected: PASS —— 4 个用例全绿。

- [ ] **Step 5: 类型检查**

Run: `cd frontend && npm run typecheck`
Expected: PASS —— `WorkflowItem` 类型兼容泛型 `groupByPrefix`/`topActions`。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/WorkflowsGridView.tsx frontend/src/components/WorkflowsGridView.test.tsx
git commit -m "feat(frontend): 新增 WorkflowsGridView,workflow 网格与 ActionCard 同构"
```

---

## Task 4: RunnerView 加 workflows-grid + OutputPanel 分派

**Files:**
- Modify: `frontend/src/context/ActionRunnerProvider.tsx:49-60`(`RunnerView` 枚举)
- Modify: `frontend/src/components/OutputPanel.tsx`

**Interfaces:**
- Produces: `RunnerView` 新增 `"workflows-grid"`;`OutputPanel` 在该 view 渲染 `<WorkflowsGridView />`。

- [ ] **Step 1: RunnerView 枚举加 workflows-grid**

`frontend/src/context/ActionRunnerProvider.tsx` 第 49-60 行,在 `"actions-grid";` 之前加一行:

```typescript
export type RunnerView =
  | "output"
  | "form"
  | "global"
  | "llm"
  | "fragments"
  | "edit"
  | "workflow"
  | "workflow-form"
  | "workflow-edit"
  | "settings"
  | "actions-grid"
  | "workflows-grid";
```

- [ ] **Step 2: OutputPanel 加分派分支**

`frontend/src/components/OutputPanel.tsx`,在 import 区加:

```typescript
import { WorkflowsGridView } from "./WorkflowsGridView";
```

在 `if (view === "actions-grid") return <ActionsGridView />;` 行之后加:

```typescript
  if (view === "workflows-grid") return <WorkflowsGridView />;
```

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `cd frontend && npm run typecheck && npm test`
Expected: PASS —— `setView("workflows-grid")` 现在是合法 `RunnerView`;既有 `OutputPanel.test.tsx` 不受影响(新增分支不影响既有 view)。

> 分派的端到端验证在 Task 5(侧栏入口点击后渲染)集成覆盖。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/context/ActionRunnerProvider.tsx frontend/src/components/OutputPanel.tsx
git commit -m "feat(frontend): RunnerView 加 workflows-grid,OutputPanel 分派到网格视图"
```

---

## Task 5: 侧栏 workflow top3 + 「全部」入口 + WorkflowItem 记 usage

**Files:**
- Modify: `frontend/src/components/AppSidebar.tsx`
- Modify: `frontend/src/components/AppSidebar.test.tsx`
- Modify: `frontend/src/components/WorkflowItem.tsx`
- Create: `frontend/src/components/WorkflowItem.test.tsx`

**Interfaces:**
- Consumes:`useActionUsage("workflow-usage")` → `topActions`(命名 `topWorkflows`)。
- WorkflowItem 改造:`handleClick` 区分有无 params(有→`selectWorkflow` 进表单;无→`runWorkflow`+记 usage),`handleDoubleClick` 记 usage。对称 `ActionItem`。

- [ ] **Step 1: 写失败测试 —— 侧栏 top3 + 全部入口**

在 `AppSidebar.test.tsx` 的 `describe("AppSidebar", () => { ... })` 内末尾新增(沿用该文件既有 mock,即 `mockListWorkflows`/`mockListActions` 已在顶部 mock 块就绪):

```typescript
  it("workflow 超过 3 个时侧栏只展示前 3 个 + 全部工作流入口", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockListWorkflows.mockResolvedValue({
      workflows: [
        { id: "w1", title: "W1", icon: "hi:workflow", description: "", params: [], steps: [{ action: "x" }] },
        { id: "w2", title: "W2", icon: "hi:workflow", description: "", params: [], steps: [{ action: "x" }] },
        { id: "w3", title: "W3", icon: "hi:workflow", description: "", params: [], steps: [{ action: "x" }] },
        { id: "w4", title: "W4", icon: "hi:workflow", description: "", params: [], steps: [{ action: "x" }] },
      ],
      errors: [],
    });
    render(wrap());
    expect(await screen.findByText("常用工作流")).toBeInTheDocument();
    expect(screen.getByText("W1")).toBeInTheDocument();
    expect(screen.getByText("W3")).toBeInTheDocument();
    expect(screen.queryByText("W4")).not.toBeInTheDocument();
    expect(screen.getByText("全部工作流")).toBeInTheDocument();
  });

  it("workflow 为空时显示空提示,不显示全部入口", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockListWorkflows.mockResolvedValue({ workflows: [], errors: [] });
    render(wrap());
    expect(await screen.findByText(/无工作流/)).toBeInTheDocument();
    expect(screen.queryByText("全部工作流")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd frontend && npx vitest run src/components/AppSidebar.test.tsx`
Expected: FAIL —— 找不到「常用工作流」(现分区标题是 `sidebar.workflows`="工作流")、W4 仍出现(现全部展示)、无「全部工作流」入口。

- [ ] **Step 3: 改 AppSidebar —— workflow 分区 top3 + 全部入口**

`frontend/src/components/AppSidebar.tsx`:

(a) 顶部已有 `const { topActions } = useActionUsage();`,改为同时拿 workflow 的 top(同一 hook,不同 storageKey 实例):

```typescript
  const { topActions } = useActionUsage();
  const { topActions: topWorkflows } = useActionUsage("workflow-usage");
```

(b) 在 `const top3 = topActions(actions, 3);` 之下加:

```typescript
  const top3Wf = topWorkflows(workflows, 3);
```

(c) 把 workflows 分区(原 `{workflows.map((w) => <WorkflowItem ... />)}`)整体替换为:

```tsx
        <SidebarGroup>
          <SidebarGroupLabel className={EYEBROW}>
            {t("sidebar.frequentWorkflows")}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {workflows.length === 0 && workflowErrors.length === 0 && (
                <Empty className="flex-none items-start border-none p-2 text-left">
                  <EmptyDescription>{t("workflow.empty")}</EmptyDescription>
                </Empty>
              )}
              {top3Wf.map((w) => (
                <WorkflowItem key={w.id} workflow={w} />
              ))}
              {workflowErrors.map((e, i) => (
                <SidebarMenuItem key={`wf-err-${i}`}>
                  <Alert variant="destructive" className="py-2">
                    <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.75} />
                    <AlertDescription>{e}</AlertDescription>
                  </Alert>
                </SidebarMenuItem>
              ))}
              {/* 全部工作流入口(对称「全部动作」) */}
              {workflows.length > 0 && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => setView("workflows-grid")}
                    tooltip={t("sidebar.allWorkflows")}
                  >
                    <HugeiconsIcon
                      icon={GridViewIcon}
                      strokeWidth={1.75}
                      className="size-4 shrink-0"
                    />
                    <span>{t("sidebar.allWorkflows")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
```

> `GridViewIcon` 已在文件顶部 import(「全部动作」入口在用)。`setView` 已在 `useActionRunner()` 解构。

- [ ] **Step 4: 运行侧栏测试确认通过**

Run: `cd frontend && npx vitest run src/components/AppSidebar.test.tsx`
Expected: PASS。

- [ ] **Step 5: 写 WorkflowItem 测试 —— 单击无参直接跑+记 / 有参进表单**

创建 `frontend/src/components/WorkflowItem.test.tsx`(mock 模式同 `WorkflowsGridView.test.tsx`):

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockListWorkflows, mockRunWorkflow, mockOn } = vi.hoisted(() => ({
  mockListWorkflows: vi.fn(),
  mockRunWorkflow: vi.fn(() => Promise.resolve()),
  mockOn: vi.fn(() => () => {}),
}));

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  RunAction: vi.fn(),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn(),
  GetFragments: vi.fn().mockResolvedValue([]),
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: vi.fn(),
  PickDirectory: vi.fn(),
  ListWorkflows: mockListWorkflows,
  RunWorkflow: mockRunWorkflow,
  CancelWorkflow: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { AppSidebar } from "./AppSidebar";

beforeEach(() => {
  mockListWorkflows.mockReset();
  mockRunWorkflow.mockReset().mockResolvedValue(undefined);
  mockOn.mockClear();
  localStorage.clear();
});

// 通过渲染 AppSidebar 间接测 WorkflowItem(它在侧栏内被实例化)。
function wrap() {
  return (
    <ActionRunnerProvider>
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    </ActionRunnerProvider>
  );
}

describe("WorkflowItem", () => {
  it("单击无参数 workflow 直接运行并记 usage", async () => {
    const user = userEvent.setup({ delay: null });
    // ActionItem 用 250ms 延时区分单击/双击;WorkflowItem 同款,跳过延时。
    mockListWorkflows.mockResolvedValue({
      workflows: [
        { id: "w-run", title: "直跑", icon: "hi:workflow", description: "", params: [], steps: [{ action: "x" }] },
      ],
      errors: [],
    });
    render(wrap());
    await user.click(await screen.findByText("直跑"));
    expect(mockRunWorkflow).toHaveBeenCalledWith("w-run", {});
    expect(localStorage.getItem("workflow-usage")).toContain("w-run");
  });

  it("双击有参数 workflow 也直接运行", async () => {
    const user = userEvent.setup({ delay: null });
    mockListWorkflows.mockResolvedValue({
      workflows: [
        {
          id: "w-form", title: "带参", icon: "hi:workflow", description: "",
          params: [{ id: "MSG", label: "消息", type: "text", required: false, default: "", options: [] }],
          steps: [{ action: "x" }],
        },
      ],
      errors: [],
    });
    render(wrap());
    await user.dblClick(await screen.findByText("带参"));
    expect(mockRunWorkflow).toHaveBeenCalledWith("w-form", {});
  });
});
```

> `delay: null` 让 `userEvent` 不等真实的 250ms 单击/双击窗口,但 `WorkflowItem` 内部 `setTimeout(...,250)` 仍按真实定时器跑。第一条用例需配合 vitest 的定时器:若单击因 250ms 延时未触发 `runWorkflow`,在断言前加 `await new Promise((r) => setTimeout(r, 300));`。**实现 Step 6 后若用例 1 不稳定,补这一行 await。**

- [ ] **Step 6: 改 WorkflowItem —— handleClick 分支 + 记 usage**

`frontend/src/components/WorkflowItem.tsx`:

(a) 引入 workflow usage:

```typescript
import { useActionUsage } from "../hooks/useActionUsage";
```

在组件内(`useActionRunner()` 解构之后)加:

```typescript
  const { recordUsage } = useActionUsage("workflow-usage");
  const hasParams = (workflow.params?.length ?? 0) > 0;
```

(b) `handleClick` 改为按 params 分支(原版无脑 `selectWorkflow`,现在无参直接跑+记):

```typescript
  const handleClick = () => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      if (isRunning) {
        focusWorkflow(workflow.id);
        return;
      }
      if (hasParams) {
        selectWorkflow(workflow.id); // 进 workflow-form
      } else {
        runWorkflow(workflow.id, {});
        recordUsage(workflow.id);
      }
    }, DOUBLE_CLICK_DELAY);
  };
```

(c) `handleDoubleClick` 的两处 `runWorkflow(workflow.id)` 之后各加 `recordUsage(workflow.id)`:

```typescript
  const handleDoubleClick = () => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    if (isRunning) {
      focusWorkflow(workflow.id);
      return;
    }
    runWorkflow(workflow.id, {});
    recordUsage(workflow.id);
  };
```

- [ ] **Step 7: 运行 WorkflowItem 测试 + 全量验证**

Run: `cd frontend && npx vitest run src/components/WorkflowItem.test.tsx`
Expected: PASS。若用例 1(单击)因 250ms 延时不稳定,按 Step 5 注释补 `await new Promise((r) => setTimeout(r, 300));`。

Run: `cd frontend && npm test && npm run lint && npm run typecheck`
Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/AppSidebar.tsx frontend/src/components/AppSidebar.test.tsx frontend/src/components/WorkflowItem.tsx frontend/src/components/WorkflowItem.test.tsx
git commit -m "feat(frontend): 侧栏 workflow 改 top3+全部入口,WorkflowItem 记 usage"
```

---

## Task 6: WorkflowParamForm 表单提交记 usage

**Files:**
- Modify: `frontend/src/components/WorkflowParamForm.tsx`

**Interfaces:**
- Consumes:`useActionUsage("workflow-usage")` → `recordUsage`。在 `onRun` 成功提交 `runWorkflow` 时记录。

- [ ] **Step 1: 改 WorkflowParamForm —— onRun 记 usage**

`frontend/src/components/WorkflowParamForm.tsx`:

(a) 引入 hook:

```typescript
import { useActionUsage } from "../hooks/useActionUsage";
```

在组件内 `useActionRunner()` 解构之后加:

```typescript
  const { recordUsage } = useActionUsage("workflow-usage");
```

(b) `onRun` 在 `runWorkflow(...)` 之后加 `recordUsage(workflow.id)`:

```typescript
  const onRun = () => {
    if (!canRun) return;
    const p: Record<string, string> = {};
    params.forEach((spec) => {
      p[spec.id] = workflowFormValues[spec.id] ?? spec.default ?? "";
    });
    runWorkflow(workflow.id, p);
    recordUsage(workflow.id);
  };
```

- [ ] **Step 2: 全量验证(记录点属集成行为,靠既有 lint/typecheck + 手动联调保证)**

Run: `cd frontend && npm run lint && npm run typecheck && npm test`
Expected: PASS。

> 说明:usage 记录是副作用(localStorage 写),端到端验证在「Task 8 联调」:跑带参 workflow → 侧栏 / grid 出现足迹。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/WorkflowParamForm.tsx
git commit -m "feat(frontend): workflow 表单提交记录 usage,补齐常用排序数据源"
```

---

## Task 7: WorkflowView 详情页加返回 grid 入口

**Files:**
- Modify: `frontend/src/components/WorkflowView.tsx`

**Interfaces:**
- Consumes:`IconButton` + `ArrowLeft01Icon`(对称 `OutputToolbar` 的返回按钮);`setView` 已在解构中。

- [ ] **Step 1: 改 WorkflowView —— header 加返回 workflows-grid 按钮**

`frontend/src/components/WorkflowView.tsx`:

(a) 顶部 import 加:

```typescript
import { IconButton } from "./IconButton";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
```

(b) header 的 `<div className="flex items-center gap-2">` 内,在 `<SidebarTrigger />` 之后、标题 `<button>` 之前插入返回按钮:

```tsx
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <IconButton
            icon={ArrowLeft01Icon}
            label={t("sidebar.allWorkflows")}
            onClick={() => setView("workflows-grid")}
          />
          {/* 点击标题进入 yaml 编辑态(与 action 一致的交互) */}
          <button
            type="button"
            className="cursor-pointer font-semibold hover:underline"
            title={t("edit.tooltip")}
            onClick={() => currentId && setView("workflow-edit")}
          >
            {currentTitle ?? t("sidebar.workflows")}
          </button>
          {status === "running" && (
            <span className="inline-flex items-center gap-1.5 font-mono text-xs text-primary">
              <span className="size-1.5 rounded-full bg-primary live-pulse" />
              {t("workflow.running")}
            </span>
          )}
        </div>
```

- [ ] **Step 2: 类型检查 + lint**

Run: `cd frontend && npm run lint && npm run typecheck`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/WorkflowView.tsx
git commit -m "feat(frontend): WorkflowView 详情页加返回工作流网格入口"
```

---

## Task 8: 联调与端到端验证

**Files:** 无代码改动,仅构建 + 手动验证。

- [ ] **Step 1: 前端全量三件套**

Run: `cd frontend && npm test && npm run lint && npm run typecheck`
Expected: 全 PASS。

- [ ] **Step 2: 构建 exe(前端 → bindings → 二进制)**

Run: `bash deploy/build.sh`
Expected: 产出 `workflow-tool.exe`,无报错。

- [ ] **Step 3: 手动验证清单(运行 exe)**

- [ ] 侧栏「常用工作流」分区:运行某 workflow 2-3 次后,它排进 top3;长期不用的沉底。
- [ ] 侧栏「全部工作流」入口 → 进入 workflows-grid,展示所有 workflow,按前缀分组。
- [ ] Grid 卡片:点无参 workflow 直接跑(spine 视图);点有参 workflow 进表单。
- [ ] Grid 卡片右上 ✎(仅有参)→ 进 workflow-form。
- [ ] Grid 卡片显示个性图标:把某 workflow YAML 的 `icon` 改成 `🚀` 或 `hi:play`,热重载后卡片图标变化。
- [ ] WorkflowView 详情:标题点击 → workflow-edit(yaml);左上返回箭头 → 回 workflows-grid。
- [ ] 足迹条:高频 workflow 卡片 5 段亮起更多。

- [ ] **Step 4: 最终 commit(若有 lint 修复)**

```bash
git add -A
git commit -m "chore(frontend): workflow 交互统一联调收尾"
```

---

## Self-Review

**1. Spec 覆盖**(用户 4 条诉求 + "包括但不限于"):

- ✅ ① 最多展示 3 个常用 Workflow → Task 5(AppSidebar `top3Wf` + Task 1 提供 `topActions` 复用 + Task 5/6 提供 usage 数据源)。
- ✅ ② 点击 workflow 详情标题进 yaml → **已存在**(`WorkflowView.tsx:84`,Task 7 保留并补返回入口)。计划在"设计方向/交互对称表"显式标注其已实现。
- ✅ ③ 全部按钮进 Grid 查看编辑所有 workflow → Task 5(侧栏入口)+ Task 3(Grid 视图)+ Task 4(分派)。
- ✅ ④ 每个 workflow 单独个性图标 → **管线已通**(`WorkflowDef.Icon`→`WorkflowItem.Icon`→binding→前端),Task 3 的 `WorkflowCard` 用 `ActionIcon` 渲染即落地;Task 8 验证清单覆盖改 icon 生效。
- ➕ 「包括但不限于」:额外补齐了 usage 统计(Task 1/5/6)、详情返回入口(Task 7)、足迹条,使交互真正等价 action。

**2. 占位符扫描**:无 TBD/TODO/"适当处理";每个 step 有完整可运行代码;测试代码含真实断言;命令含预期输出。Task 6 的 usage 记录因是 localStorage 副作用,采用 lint/typecheck + 联调验证(已说明理由),非占位。

**3. 类型一致性**:
- `useActionUsage(storageKey?)` 默认 `"action-usage"` → 既有 4 调用点零改动(已核对:`ActionItem`/`ActionsGridView`/`AppSidebar`/`PresetList` 均无参调用)。
- `topActions<T extends {id:string}>` / `groupByPrefix<T extends {id:string}>` → `ActionItem` 与 `WorkflowItem` 都满足 `{id:string}`(均为其超集),TS 协变接受。
- `RunnerView` 加 `"workflows-grid"` 后,`setView("workflows-grid")` 在 AppSidebar(Task 5)、WorkflowView(Task 7)均为合法调用。
- `WorkflowCard` 的 `workflow.steps`/`workflow.params`/`workflow.icon` 均为 `WorkflowItem` 既有字段(binding 已含,前端已在 `WorkflowItem.tsx`/`WorkflowView.tsx` 使用,git clean 可编译)。

**4. 风险点**:
- WorkflowItem 测试的 250ms 单击/双击延时:Step 5 已给出 `delay: null` + 可选 `await 300ms` 兜底。
- usage 多实例不同步(action 既有架构特性):workflow 照搬,不在本次解决,行为与 action 一致。
- 不改后端/binding/docs:已确认 `WorkflowDef.Icon`(schema.go:23)、`WorkflowItem.Icon`(api.go:416/437)、`docs/workflow.md` 的 icon 字段均已存在,无需同步。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-07-workflow-action-unify.md`. Two execution options:

**1. Subagent-Driven (recommended)** — 我每个 Task 派一个全新 subagent 执行,Task 间做两阶段 review,迭代快、上下文干净。适合这种 7+1 个相对独立任务的前端改造。

**2. Inline Execution** — 在当前会话用 executing-plans 顺序执行,带检查点 review。

Which approach?
