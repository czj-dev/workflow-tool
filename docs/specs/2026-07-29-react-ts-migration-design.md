# Workflow Tool — 前端迁移 React + TypeScript 设计文档

- **日期**: 2026-07-29
- **状态**: 设计已确认，待实现
- **技术栈**: React 18 + TypeScript + Vite + shadcn/ui (Tailwind v4) + react-i18next
- **关联**: Phase 1 前端（Vanilla JS）迁移；Go 后端不变
- **项目路径**: `C:/Users/ASUS/Documents/workflow-tool/`

---

## 1. 背景与目标

Phase 1（MVP）已完成，前端是**纯 Vanilla JS**（`index.html` + `main.js` + `style.css`，裸 Vite、无框架）。本设计把它迁移到 **React + TypeScript + shadcn/ui**。

### 1.1 动机

- 为 **Phase 3（参数输入表单）** 和 Phase 2（多步骤）铺路：动态表单、复杂运行状态用 React 组件化 + 受控状态更可控。
- 提升前端可维护性：组件拆分、类型安全、shadcn 组件库。

### 1.2 范围边界（关键）

| 类别 | 是否改动 |
|------|----------|
| Go 后端（`api.go` / `main.go` / `internal/*`） | **不动** |
| Wails 服务注册、事件 emit 机制 | **不动** |
| `frontend/bindings/` 生成机制（`wails3 generate bindings`） | **不动** |
| `main.go` 的 `//go:embed all:frontend/dist` 路径 | **不动**（产物仍落 `frontend/dist`） |
| 前端代码（`index.html` / `main.js` / `style.css` / `package.json`） | **替换** |

这是一次**前端等价迁移 + UI 库引入**，不改变任何后端契约。

---

## 2. 技术栈与初始化

### 2.1 技术选型

| 层 | 选型 |
|----|------|
| 框架 | React 18 + TypeScript |
| 构建 | Vite（`@vitejs/plugin-react`） |
| 样式 | Tailwind v4（CSS-first：`@import "tailwindcss"` + `@tailwindcss/vite`） |
| 组件库 | shadcn/ui（组件源码内嵌到 `src/components/ui/`） |
| 运行时 | `@wailsio/runtime`（保留） |
| i18n | react-i18next + i18next（中英文切换） |

### 2.2 初始化命令

清掉旧前端文件后，在 `frontend/` 内执行：

```bash
npx shadcn@latest init --preset b1YofLADC --template vite
```

- **`--preset b1YofLADC`**：携带用户预期的主题（天蓝主题色 + 薄雾蓝基础色），init 时自动应用，无需手写色值。
- **`--template vite`**：用 Vite 模板。
- **不用 `--monorepo`**：保持 `frontend/` 单项目结构（详见 §10 YAGNI）。

### 2.3 结构决策

单项目（非 monorepo）。后果：构建产物仍落 `frontend/dist/`，于是 `main.go` 的 embed 路径、`wails3 generate bindings` 的输出位置、npm 构建流程**全部不变**，Go 侧零改动。

---

## 3. 主题与配色

主题完全由 **preset `b1YofLADC`** 提供：

- **主题色（primary）= 天蓝**：主按钮、运行中 Badge、选中态、焦点环。
- **基础色（base / 中性色阶）= 薄雾蓝**：背景、卡片、边框、文字等，整组中性色偏蓝雾、低饱和。
- 暗色模式变量随 preset 一并预留（本设计不实现切换，见 §10）。

> 精确 OKLCH/HEX 值由 preset 在 init 时写入 `src/index.css` 的 CSS 变量，**本设计不手写色值**；实现阶段 init 完成后核对实际渲染效果。

**状态灯（Badge）**按运行语义着色，独立于主题色：

| 运行状态 | 颜色 |
|----------|------|
| `running` | 主题蓝 + 脉冲动画 |
| `done`（退出码 0） | 绿 |
| `error`（退出码 ≠ 0 或出错） | 红（destructive） |
| `idle` | 中性灰 |

---

## 4. 组件结构

```
frontend/
├── index.html                  Vite 入口
├── package.json                react / react-dom / @wailsio/runtime + shadcn 依赖
├── components.json             shadcn 配置（alias @/*）
├── vite.config.ts              @vitejs/plugin-react + path alias @/*
├── tsconfig.json (+ app/node)  allowJs: true（import bindings/*.js）
├── src/
│   ├── main.tsx                createRoot(<App/>)
│   ├── App.tsx                 双栏骨架，包 <ActionRunnerProvider>
│   ├── index.css               Tailwind 入口 + preset 主题变量
│   ├── lib/utils.ts            shadcn 的 cn()
│   ├── context/
│   │   └── ActionRunnerProvider.tsx   Context + 全部运行状态
│   ├── hooks/
│   │   └── useActionRunner.ts         消费 Context 的 hook
│   ├── i18n/
│   │   ├── index.ts                   i18next 初始化（默认 zh + localStorage 记忆）
│   │   └── locales/{zh,en}.json       中/英文界面文案
│   ├── types/
│   │   └── events.ts                  OutputEventData / DoneEventData
│   └── components/
│       ├── ui/                        shadcn 组件（button/card/scroll-area/badge/tooltip/separator）
│       ├── ActionSidebar.tsx          左栏动作列表
│       ├── ActionItem.tsx             单个动作按钮 + 状态灯
│       ├── OutputPanel.tsx            右栏主区
│       ├── OutputToolbar.tsx          标题 + 停止 + 清空 + 复制 + 语言切换
│       ├── OutputConsole.tsx          滚动终端区
│       └── LangSwitch.tsx             中/EN 语言切换按钮
├── bindings/                          wails3 generate 产物（不变）
└── dist/                              Vite 构建产物（embed 目标，不变）
```

### 4.1 组件职责

| 组件 | 职责 |
|------|------|
| `App` | 双栏布局骨架（`ActionSidebar` + `OutputPanel`），在最外层包 `ActionRunnerProvider` |
| `ActionSidebar` | 渲染 `actions` 列表 + 加载 `errors`；逐个渲染 `ActionItem` |
| `ActionItem` | 动作按钮（`icon` + `title`）+ `Tooltip`(`description`) + 运行状态灯；点击调 `runAction(id)` |
| `OutputPanel` | 右栏容器，组合 `OutputToolbar` + `OutputConsole` |
| `OutputToolbar` | 当前动作标题 + 停止 + 清空 + 复制 + `LangSwitch` |
| `LangSwitch` | 中/EN 切换按钮，调 `i18next.changeLanguage` + 写 `localStorage` |
| `OutputConsole` | `ScrollArea` + monospace 暗底，渲染 `lines`，新行自动滚到底 |

---

## 5. 状态管理与数据流（Context + 自定义 hook）

### 5.1 Provider 状态

`ActionRunnerProvider` 持有：

| 状态 | 类型 | 说明 |
|------|------|------|
| `actions` | `ActionItem[]` | 启动时 `ListActions()` 一次性拉取 |
| `errors` | `string[]` | 加载错误（坏 YAML 等） |
| `currentId` | `string \| null` | 当前选中/运行的动作 id |
| `lines` | `string[]` | 输出行，事件流追加（stderr 行加 `[stderr] ` 前缀） |
| `status` | `'idle' \| 'running' \| 'done' \| 'error'` | 运行状态，驱动状态灯 |
| `exitInfo` | `{ exitCode, err, duration } \| null` | `done` 事件结果 |

暴露方法：`runAction(id)` / `cancel()` / `clearOutput()` / `copyOutput()`。

### 5.2 数据流

```
App 挂载 → Provider 初始化 → ListActions() → setActions / setErrors
用户点 ActionItem → runAction(id):
    清空 lines, set currentId, status='running'
    useEffect 订阅 action:{id}:output / action:{id}:done
    调 RunAction(id)
后端 emit action:{id}:output → 追加 lines（stderr 加前缀）
后端 emit action:{id}:done   → status='done'/'error' + setExitInfo
点停止 → CancelAction(id)          ｜  点清空 → clearOutput()  ｜  点复制 → 写剪贴板
切换/重选动作 → useEffect cleanup 取消旧订阅 → 重新订阅新 id
```

### 5.3 事件订阅（React 等价物）

现有 `main.js` 用 `unsubs[]` 数组管理订阅。迁移后等价物：`useEffect`（依赖 `currentId`），在 effect 内 `Events.On(...)` 订阅两个事件，**cleanup 调用其返回的取消订阅函数**。语义与现状一致，仅是 React 生命周期化。

### 5.4 扩展点

`useActionRunner` hook 是 **Phase 2（多步骤）/ Phase 3（参数表单）** 的扩展位置：未来多步骤状态、参数收集都在这一层增强，组件层无感。

### 5.5 语言状态（i18next 独立管理）

界面语言由 i18next 单例管理，**不放进 `ActionRunnerProvider`**。组件用 `useTranslation()` 的 `t()` 取文案，语言切换时自动重渲染。默认 `zh`，用户选择写入 `localStorage('lang')`，下次启动读取恢复。

---

## 6. TypeScript 类型策略

| 来源 | 处理 |
|------|------|
| `bindings/*.js` | `tsconfig` 开 `allowJs: true`，可直接 import |
| `ActionItem` / `ListResult` | bindings 的 `models.js` 是真实 class + 完整 JSDoc，当类型用 |
| service 方法 | `ListActions()` 返回 `CancellablePromise<ListResult>`，类型自动推断 |
| 事件 payload | 后端 emit 的裸 map 无绑定类型，在 `src/types/events.ts` 自定义 |

自定义事件类型：

```ts
// src/types/events.ts
export interface OutputEventData {
  stream: 'stdout' | 'stderr';
  line: string;
}
export interface DoneEventData {
  exitCode: number;
  err: string;
  duration: string;
}
```

`Events.On` 回调的 `e.data` 为 `unknown`，消费时做类型断言为上述接口。

---

## 7. 构建链与开发流程

### 7.1 不变

| 环节 | 说明 |
|------|------|
| `//go:embed all:frontend/dist` | 仍 embed Vite 产物（`main.go` 不改） |
| `wails3 generate bindings` | 仍输出 `frontend/bindings/`；改 `api.go` 后才需重跑 |
| 服务注册 / 事件 emit / `go build` | 一字不改 |

### 7.2 调整

- 前端构建仍 `cd frontend && npm run build`（Vite 产物落 `dist/`）。
- **dev 联调约束**：单独 `npm run dev` 跑 Vite dev server 可调样式，但**联调后端必须 `go build` 跑 exe**——`Call.ByID` 只在 Wails 运行时可用，纯前端 dev 调不到后端。这点写入 README。
- path alias `@/*` 在 `tsconfig.json` 与 `vite.config.ts` 双侧配置。

### 7.3 完整构建顺序（不变）

```
cd frontend && npm install && npm run build      # 产出 frontend/dist/
cd .. && wails3 generate bindings                # 仅改了 api.go 才需要
go build -o workflow-tool.exe .
```

---

## 8. 适度增强与 i18n（相对 Phase 1 新增）

均为 UI 层增强，**不改后端契约**：

1. **运行状态灯**：`ActionItem` 上的 `Badge`，随 `status` 变化（见 §3 表），让侧边栏直观看到哪个动作在跑 / 成功 / 失败。
2. **输出工具栏**：标题（当前动作 `icon + title`）+ 停止按钮（已有）+ **清空**（清 `lines`）+ **复制**（`lines` 写入剪贴板）+ 语言切换。
3. **i18n（中英文切换）**：详见 §8.1。

### 8.1 i18n 设计

| 项 | 方案 |
|----|------|
| 库 | react-i18next + i18next |
| 默认语言 | `zh`（中文），fallbackLng `zh` |
| 记忆 | `localStorage('lang')`：启动读取，切换时写入 |
| 切换 UI | `OutputToolbar` 右端 `LangSwitch`（中/EN） |
| 资源文件 | `src/i18n/locales/{zh,en}.json` |

**文案 key 规划**（前端静态文本，举例）：

```json
// zh.json
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

`en.json` 为对应英文。组件用 `const { t } = useTranslation();` 取 `t('main.stop')` 等，支持 `{{exitCode}}` 插值。

**边界（重要）**：i18n 只覆盖**前端静态界面文案**。以下**不翻译**——动作 `title`/`description`/`icon`（用户 YAML 自定义）、后端 emit 的报错与 stdout/stderr 输出（后端 `api.go` 不动）。详见 §10。

---

## 9. 验收标准（可验证的完成）

- [ ] `tsc --noEmit` 通过（含 bindings 类型）
- [ ] `cd frontend && npm run build` 成功，产出 `frontend/dist/`
- [ ] `go build -o workflow-tool.exe .` 成功，exe 启动
- [ ] 启动显示 3 个示例动作列表
- [ ] 点「👋 打个招呼」→ 输出 `hello`，done 退出码 0
- [ ] 点「🚀 部署」→ 流式输出，停止按钮可中断
- [ ] cwd 未设环境变量的动作显示友好提示（Phase 1 行为保留）
- [ ] 状态灯随运行状态正确变化
- [ ] 清空 / 复制工具栏可用
- [ ] 外观：shadcn 天蓝 + 薄雾蓝双栏
- [ ] 中/EN 切换生效：所有前端静态文案随之切换
- [ ] 语言选择写入 localStorage，重启 exe 后记住
- [ ] 前端无硬编码界面文案（全部走 i18n key）

---

## 10. 明确不做（YAGNI）

- **monorepo / `packages/ui` 共享**：单 Wails 桌面端用不上，徒增 embed/bindings/pnpm 适配成本。
- **暗色模式切换**：preset 预留变量，但不实现切换 UI。
- **状态管理库**（zustand / redux）：Context + hook 对当前规模足够。
- **动作历史持久化、YAML 热重载**：仍属后续阶段。
- **Phase 2/3 实际功能**（多步骤、参数表单）：本设计仅铺 React 基座 + 扩展点，不实现这些功能本身。
- **后端文本 / 动作内容的 i18n**：只翻译前端静态界面文案；后端报错、用户 YAML 内容、命令输出保持原样。

---

## 11. 风险与约束

| 风险 / 约束 | 应对 |
|-------------|------|
| Wails 版本锁死 `v3.0.0-alpha2.119` | 一律不动 Wails 相关；不用 alpha.3（绑定机制坏） |
| preset `b1YofLADC` 来自中文站 `shadcn.com.cn` | init 后核对主题渲染；若 CLI 不认该码，回退为 init 后手动应用 preset / 按主题描述配色 |
| 旧前端文件清理 | 删 `index.html` / `main.js` / `style.css` / 旧 `package.json`，由 Vite 模板取代 |
| shadcn / Tailwind 具体版本 | 按 init 时最新稳定版定（预期 Tailwind v4 + 最新 shadcn CLI） |
| i18n 新增依赖（i18next + react-i18next） | 轻量、成熟；文案 key 集中在 `locales/*.json`，新增文案只改 JSON |
