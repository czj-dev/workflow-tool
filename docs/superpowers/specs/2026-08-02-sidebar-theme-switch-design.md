# 侧边栏主题切换设计

日期：2026-08-02
状态：已确认，待实现

## 目标

在侧边栏 footer 增加一个主题切换按钮，点击在 `light → dark → system` 间循环，让用户能在界面上切换浅色 / 深色 / 跟随系统。直接复用现有 `ThemeProvider`，纯前端改动，不动后端与 `config.yaml`。

## 现状

- `ThemeProvider`（`frontend/src/components/theme-provider.tsx`）已完整实现：`Theme = "dark" | "light" | "system"`，`localStorage` 持久化（key=`"theme"`），默认 `system`（跟随 `prefers-color-scheme`），快捷键 `d` 切换，跨 tab storage 事件同步。`main.tsx` 已包裹。**唯一缺口：没有 UI 入口**，普通用户无法在界面上切换。
- `AppSidebar` footer 已有「片段 / 全局配置 / 语言切换」三个入口，语言切换是内联的「点一下 zh↔en，存 localStorage」轻量模式。
- 后端 `config.yaml` 是简单 key-value（`map[string]string`），经 `GlobalConfigEditor` 编辑。本次不动。

## 非目标（YAGNI）

- 不动后端 / `config.yaml` / `ThemeProvider` 内部逻辑。
- 不引入 `DropdownMenu` / `Select` 三选一（用循环按钮，与语言切换对称）。
- 不暴露 `system` 当前实际 resolve 成亮 / 暗（`system` 态只显示「跟随系统」）。
- 不改快捷键 `d`（`ThemeProvider` 已有，与新按钮互不干扰）。
- 不做主题色定制（仅复用既有 light/dark 两套 token）。

## 交互入口

- `AppSidebar` footer 新增一个 `SidebarMenuButton`，样式与语言切换同款（图标 + 文字；`collapsible="icon"` 折叠时显 tooltip）。
- 位置：footer 内「全局配置」与「语言切换」之间（偏好类入口聚拢）。
- 点击循环：`light → dark → system → light`。

## 行为

1. `const { theme, setTheme } = useTheme()`。
2. 点击：
   ```ts
   const next = theme === "light" ? "dark" : theme === "dark" ? "system" : "light"
   setTheme(next)
   ```
3. 图标映射（均来自 `@hugeicons/core-free-icons`，已确认存在）：
   - `light → Sun03Icon`
   - `dark → Moon02Icon`
   - `system → ContrastIcon`
4. 显示：
   - 展开态：图标 + 当前态名（`t(\`theme.${theme}\`)`，如「深色」）。
   - 折叠态：图标 + tooltip=`t("sidebar.theme")`，与语言切换 tooltip=`t("sidebar.language")` 对称。
5. 持久化由 `ThemeProvider.setTheme` 负责（写 `localStorage["theme"]`），新代码不重复处理。

## 前端改动

1. **`frontend/src/components/AppSidebar.tsx`**（内联实现，方案 A，与语言切换对称）：
   - `import { useTheme } from "@/components/theme-provider"`
   - `import { ContrastIcon, Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons"`
   - 在 footer「全局配置」与「语言切换」之间新增 `SidebarMenuItem` + `SidebarMenuButton`：
     - `onClick`：按上式计算 `next` 并 `setTheme(next)`。
     - 图标按 `theme` 取映射。
     - 文字 / tooltip 走 i18n。
   - 用一个小的本地映射对象（如 `const THEME_ICON = { light: Sun03Icon, dark: Moon02Icon, system: ContrastIcon }`）集中图标选择，避免散落三元。
2. **`frontend/src/i18n/locales/zh.json` / `en.json`**：新增 key（见下表），合并进现有结构。

## 数据流

```
点击 footer 主题按钮
  → useTheme().setTheme(next)
  → localStorage["theme"] = next
  → ThemeProvider useEffect 给 <html> 加/去 light|dark class（system 态按媒体查询 resolve）
  → 界面立即换色
```

## 文案（i18n）

| key | zh | en |
|---|---|---|
| `theme.light` | 浅色 | Light |
| `theme.dark` | 深色 | Dark |
| `theme.system` | 跟随系统 | System |
| `sidebar.theme` | 主题 | Theme |

新增静态文案只改 `locales/{zh,en}.json`（遵循项目约定：动作 title/description 与后端 stdout/stderr 不参与 i18n）。

## 错误处理与边界

| 场景 | 行为 |
|---|---|
| `theme` 初值为 `system`（默认 / 无 localStorage） | 按钮显示 ContrastIcon +「跟随系统」 |
| 用户切到 `system` 后系统主题变化 | `ThemeProvider` 已监听媒体查询，自动 resolve，按钮态不变（仍显「跟随系统」） |
| 快捷键 `d` 与按钮并存 | 各自独立：`d` 在 light/dark 间切（现有逻辑），按钮三态循环；两者都写同一 localStorage key，状态始终一致 |
| 折叠为 icon 模式 | 显当前态图标 + tooltip「主题」 |

## 测试（前端 vitest）

`AppSidebar.test.tsx` 新增用例（遵循项目「查中文文案」模式，参考现有 `AppSidebar.test.tsx`）：

- 渲染时按钮显示当前 `theme` 对应文案（测试需包裹 `ThemeProvider` 或 mock `useTheme`，设定初始 theme）。
- 连续点击按钮：`light → dark → system → light` 循环成立（断言按钮文字依次变化，或断言 `setTheme` 调用序列）。
- 折叠态 tooltip 为「主题」。

## 构建链

纯前端改动，无 `internal/api/api.go` 变更，**无需** `wails3 generate bindings`：

```bash
cd frontend && npm run build && cd ..
go build -ldflags "-H windowsgui" -o workflow-tool.exe .
```
