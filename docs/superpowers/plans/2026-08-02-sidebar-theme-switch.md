# 侧边栏主题切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在侧边栏 footer 增加三态循环主题按钮（light→dark→system），复用现有 `ThemeProvider`，纯前端改动。

**Architecture:** 不新建组件、不动 `ThemeProvider` 内部、不动后端。在 `AppSidebar` footer 内联一个 `SidebarMenuButton`（与现有语言切换对称），`onClick` 调 `useTheme().setTheme` 计算下一态；图标按当前 `theme` 取映射；文案走 i18n 扁平 key。持久化由 `ThemeProvider` 写 `localStorage["theme"]` 已有逻辑负责。

**Tech Stack:** React 19 + TypeScript、vitest + @testing-library/react、i18next、@hugeicons/core-free-icons、base-ui sidebar。

## Global Constraints

- 锁定 Wails `v3.0.0-alpha2.119`，不升 alpha.3（本计划不碰 Wails，仅作上下文）。
- 纯前端改动，**无** `internal/api/api.go` 变更，**无需** `wails3 generate bindings`。
- 新增前端静态文案只改 `frontend/src/i18n/locales/{zh,en}.json`（扁平 key，与现有 `"sidebar.language"` 一致）。
- 测试遵循项目「查中文文案」模式（vitest + testing-library，断言中文文案）。
- 图标来自 `@hugeicons/core-free-icons`，已确认 `Sun03Icon`/`Moon02Icon`/`ContrastIcon` 存在。
- 不抽独立组件（与现有语言切换内联风格对称）。

---

## File Structure

| 文件 | 责任 | 改动 |
|---|---|---|
| `frontend/src/i18n/locales/zh.json` | 中文文案（扁平 key） | 加 `sidebar.theme` + `theme.{light,dark,system}` |
| `frontend/src/i18n/locales/en.json` | 英文文案 | 同上英文 |
| `frontend/src/components/AppSidebar.tsx` | 左侧栏（含 footer 入口） | footer 内联主题按钮；import `useTheme` + 三图标 |
| `frontend/src/components/AppSidebar.test.tsx` | 侧栏单测 | `wrap()` 包 `ThemeProvider`；mock `matchMedia`；加循环用例 |

---

### Task 1: i18n 文案

**Files:**
- Modify: `frontend/src/i18n/locales/zh.json`
- Modify: `frontend/src/i18n/locales/en.json`

**Interfaces:**
- Produces: i18n key `sidebar.theme`、`theme.light`、`theme.dark`、`theme.system`（Task 2 的 `t(...)` 调用依赖这些 key 存在）。

- [ ] **Step 1: zh.json 加 4 个 key**

在 `"sidebar.language": "语言",` 之后插入 `"sidebar.theme": "主题",`；在文件末尾 `"edit.exit": "退出编辑"` 之后追加 `theme.*` 三行。改动后相关片段：

```json
  "sidebar.language": "语言",
  "sidebar.theme": "主题",
```

与文件末尾：

```json
  "edit.exit": "退出编辑",
  "theme.light": "浅色",
  "theme.dark": "深色",
  "theme.system": "跟随系统"
}
```

（注意原文件末尾 `"edit.exit": "退出编辑"` 无尾逗号，追加新行时需为它补尾逗号；最终最后一个 key `theme.system` 无尾逗号。）

- [ ] **Step 2: en.json 加 4 个 key（英文）**

同样位置插入 `sidebar.theme`，末尾追加 `theme.*`：

```json
  "sidebar.language": "Language",
  "sidebar.theme": "Theme",
```

```json
  "edit.exit": "Exit edit",
  "theme.light": "Light",
  "theme.dark": "Dark",
  "theme.system": "System"
}
```

- [ ] **Step 3: 验证 JSON 合法**

Run: `cd frontend && node -e "JSON.parse(require('fs').readFileSync('src/i18n/locales/zh.json','utf8'));JSON.parse(require('fs').readFileSync('src/i18n/locales/en.json','utf8'));console.log('ok')"`
Expected: 输出 `ok`，无异常。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/i18n/locales/zh.json frontend/src/i18n/locales/en.json
git commit -m "$(cat <<'EOF'
feat(i18n): 增加主题切换文案 key

sidebar.theme + theme.{light,dark,system}，中英文。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: AppSidebar 主题按钮（TDD）

**Files:**
- Modify: `frontend/src/components/AppSidebar.tsx`
- Test: `frontend/src/components/AppSidebar.test.tsx`

**Interfaces:**
- Consumes: `useTheme()` from `@/components/theme-provider`（返回 `{ theme: "light"|"dark"|"system"; setTheme: (t) => void }`，已存在，签名不变）。
- Consumes: i18n key `sidebar.theme`、`theme.{light,dark,system}`（Task 1 产出）。
- Consumes: `SidebarMenuButton` 的 `tooltip` prop（string，已用于语言切换）。
- Produces: footer 内一个点击循环主题的 `SidebarMenuButton`，无新 export。

- [ ] **Step 1: 改测试 wrapper，包裹真实 ThemeProvider 并 mock matchMedia**

修改 `frontend/src/components/AppSidebar.test.tsx`：

顶部 import 区追加（在现有 `import { SidebarProvider }...` 附近）：

```tsx
import { ThemeProvider } from "@/components/theme-provider";
```

将 `wrap()` 改为包裹 `ThemeProvider`（`defaultTheme="light"` 让初始态确定；`storageKey="theme-test"` 避免污染真实 storage）：

```tsx
function wrap() {
  return (
    <ThemeProvider defaultTheme="light" storageKey="theme-test">
      <ActionRunnerProvider>
        <SidebarProvider>
          <AppSidebar />
        </SidebarProvider>
      </ActionRunnerProvider>
    </ThemeProvider>
  );
}
```

在 `beforeEach` 内追加 `matchMedia` mock 与 localStorage 清理（`theme="system"` 时 `ThemeProvider` 会调 `window.matchMedia`，jsdom 默认无，必须 mock）：

```tsx
beforeEach(() => {
  Object.keys(listeners).forEach((k) => delete listeners[k]);
  mockListActions.mockReset();
  mockRunAction.mockReset().mockResolvedValue(undefined);
  mockOn.mockClear();
  // 主题测试需要：jsdom 无 matchMedia，mock 之；清 localStorage 保证初始态
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  localStorage.clear();
});
```

- [ ] **Step 2: 写失败测试——三态循环**

在 `describe("AppSidebar", () => { ... })` 内追加用例：

```tsx
it("主题按钮循环 light→dark→system→light", async () => {
  const user = userEvent.setup();
  mockListActions.mockResolvedValue({ actions: [], errors: [] });
  render(wrap());
  // defaultTheme="light" + localStorage 空 → 初始「浅色」
  const themeBtn = await screen.findByText("浅色");
  await user.click(themeBtn);
  expect(screen.getByText("深色")).toBeInTheDocument();
  await user.click(screen.getByText("深色"));
  expect(screen.getByText("跟随系统")).toBeInTheDocument();
  await user.click(screen.getByText("跟随系统"));
  expect(screen.getByText("浅色")).toBeInTheDocument();
});
```

- [ ] **Step 3: 跑测试，确认失败**

Run: `cd frontend && npx vitest run src/components/AppSidebar.test.tsx`
Expected: 新用例 FAIL（按钮尚不存在，`screen.findByText("浅色")` 超时找不到）。

- [ ] **Step 4: 实现——import useTheme 与三图标**

修改 `frontend/src/components/AppSidebar.tsx`。

在文件顶部 `@hugeicons/core-free-icons` 的 import 块追加三个图标（保持字母序）。原块：

```tsx
import {
  Alert02Icon,
  FlashIcon,
  Globe02Icon,
  NoteIcon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
```

改为：

```tsx
import {
  Alert02Icon,
  ContrastIcon,
  FlashIcon,
  Globe02Icon,
  Moon02Icon,
  NoteIcon,
  Settings02Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
```

在 `import { useActionRunner } from "../hooks/useActionRunner";` 之后追加：

```tsx
import { useTheme } from "@/components/theme-provider";
```

- [ ] **Step 5: 实现——组件内取 theme 与循环逻辑**

在 `AppSidebar` 函数体内，`const { actions, errors, setView, openActionsDir } = useActionRunner();` 之后追加：

```tsx
const { theme, setTheme } = useTheme();

const THEME_ICON = {
  light: Sun03Icon,
  dark: Moon02Icon,
  system: ContrastIcon,
} as const;

const cycleTheme = () =>
  setTheme(
    theme === "light" ? "dark" : theme === "dark" ? "system" : "light",
  );
```

- [ ] **Step 6: 实现——footer 插入主题按钮 JSX**

在 footer 的 `SidebarMenu` 内，「全局配置」`SidebarMenuItem`（含 `Settings02Icon`）与「语言切换」`SidebarMenuItem`（含 `Globe02Icon`）之间，插入新 `SidebarMenuItem`：

```tsx
<SidebarMenuItem>
  <SidebarMenuButton onClick={cycleTheme} tooltip={t("sidebar.theme")}>
    <HugeiconsIcon
      icon={THEME_ICON[theme]}
      strokeWidth={1.75}
      className="size-4 shrink-0"
    />
    <span>{t(`theme.${theme}`)}</span>
  </SidebarMenuButton>
</SidebarMenuItem>
```

- [ ] **Step 7: 跑测试，确认通过**

Run: `cd frontend && npx vitest run src/components/AppSidebar.test.tsx`
Expected: PASS（含新循环用例与原有 3 个用例全绿）。

- [ ] **Step 8: lint + typecheck**

Run: `cd frontend && npm run lint && npm run typecheck`
Expected: 无新增错误（pre-existing debt 忽略）。

- [ ] **Step 9: 构建验证（前端 + Go）**

Run: `cd frontend && npm run build && cd .. && go build -ldflags "-H windowsgui" -o workflow-tool.exe .`
Expected: 前端 `✓ built`，Go 编译通过，产出 `workflow-tool.exe`。

手动验证（运行 exe）：footer 出现主题按钮，点击在「浅色 / 深色 / 跟随系统」间循环且界面立即换色；折叠为 icon 模式时 hover 显 tooltip「主题」。

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/AppSidebar.tsx frontend/src/components/AppSidebar.test.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): 侧边栏 footer 增加主题切换按钮

点击在 light→dark→system 间循环，复用 ThemeProvider，localStorage 持久化。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 非目标 / 不做的事

- 不抽 `ThemeToggle` 组件（与语言切换内联风格对称）。
- 不动 `ThemeProvider` 内部、不动快捷键 `d`、不动后端与 `config.yaml`。
- 不加 `DropdownMenu` / `Select`。
- `system` 态不显示当前 resolve 成亮 / 暗（只显「跟随系统」）。

## 测试说明

- 循环用例覆盖核心行为（三态切换 + 文案 + 图标映射隐式由 `theme` 驱动）。
- tooltip（折叠态「主题」）不单测（触发折叠 + hover 成本高、YAGNI），由 Step 9 构建后手动验证。
- 现有 3 个用例因 `wrap()` 加了 `ThemeProvider` 仍应通过（`ThemeProvider` 仅提供 context 与 html class 副作用，不影响列表渲染）。
