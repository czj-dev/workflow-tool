# LLM 卡片独立入口 + 聊天式单页设计

> 日期：2026-08-13
> 状态：待用户审批

## 概述

将 `command.llm` 形态的 action 从通用动作列表中分离，新增独立的侧边栏分组「AI 对话」和专属 grid 页 `LlmGridView`。点卡片直接进入聊天式单页 `LlmChatView`（取代现有 LlmForm→LlmView 两步），底部固定输入框、上方流式展示回答、右上角抽屉浏览历史记录。

## 目标

1. LLM 卡片有独立的发现入口（侧边栏分组 + grid），不再与 shell/adb 动作混杂
2. 交互路径从「表单页 → 点运行 → 输出页」缩短为**一页敲 ⌘↵ 即跑**
3. 保留单轮替换语义（每次发送清空上一轮）；历史记录持久化到 localStorage 按需翻阅

## 不做

- 多轮会话 / 上下文续接（后端仍是独立 headless 请求）
- 后端改动 / bindings 重生成（纯前端）
- YAML schema 新字段

---

## 架构：新增文件

| 文件 | 职责 |
|------|------|
| `components/LlmGridView.tsx` | LLM 卡片专属 grid 页（复用 `ActionsGridView` 的卡片视觉） |
| `components/LlmChatView.tsx` | 聊天式单页：composer + thread + 历史抽屉 |
| `hooks/useLlmHistory.ts` | localStorage 读写 hook，按 actionId 分桶 |

## 架构：改动文件

| 文件 | 变更 |
|------|------|
| `components/AppSidebar.tsx` | 新增「AI 对话」分组（top3 + 全部 AI 卡片入口）；过滤 `actions.filter(a => !a.llm)` |
| `components/ActionsGridView.tsx` | 过滤掉 `a.llm` 卡片（不再展示 LLM 动作） |
| `components/OutputPanel.tsx` | 新增 `view === "llm-grid"` 和 `view === "llm-chat"` 分支 |
| `context/ActionRunnerProvider.tsx` | `RunnerView` 类型新增 `"llm-grid" \| "llm-chat"`；`runAction` 中 `action.llm` 路径改为 `setView("llm-chat")` |
| `i18n/locales/{zh,en}.json` | 新增 sidebar.aiChat / llmGrid.* / llmChat.* 条目 |

---

## 组件设计

### LlmGridView

复用 `ActionsGridView` 的 grid 布局和 `ActionCard` 视觉：
- 数据源：`actions.filter(a => a.llm)`
- 分组：复用 `useActionUsage.groupByPrefix`
- 卡片 CTA：`▸ 对话`（点击 → `setView("llm-chat")` + `setCurrentId(action.id)`）
- Preset chip：点击直接 `runAction(id, presetValues)`，进入 llm-chat 页并流式输出

### LlmChatView

三区结构：`header` + `thread`（flex:1 滚动） + `composer`（固定底部）

#### Header
- 返回按钮（→ `setView("llm-grid")`）
- 卡片图标 + title
- 运行状态（live-pulse / done / error）
- 右侧：`⏱ 历史 N` 按钮（toggle 抽屉）+ 运行中显示 `■ 停止`

#### Thread
- **空态**：卡片图标 + description + 快捷键提示（居中）
- **运行中/完成**：单条一问一答
  - 用户消息气泡（右对齐，primary 底色）
  - 助手消息：`Reasoning` 折叠块（流式时展开，完成后收起）+ `MessageMarkdown` 渲染正文
- 复用 `nexus-ui/thread`、`nexus-ui/message`、`nexus-ui/reasoning` 原子

#### Composer
- **Context row**（输入框上方）：角色设定 chip（虚线，点开展开 `systemParam` 编辑）+ 其余 param chip（实线，点开 inline 输入）
  - chip 状态：`filled`（有值，成功描边）/ `empty`（灰斜体「未填」）
  - 点 chip → Popover（shadcn `Popover`）弹出对应 param 的 input/textarea，blur 或 Enter 收起；type=textarea 的 param 用 textarea，其余用 input
- **Input area**：绑 `formValues[promptParam]`；预填 `param.default`
  - `⌘↵` 发送（`onRun`）
  - `⇧↵` 换行
  - 发送时：校验 `missingRequired`，通过 → `runAction(id, params)` → thread 切为运行态
  - 运行中：发送按钮变 `■ 停止`

#### 发送流程（复用现有 Provider）
```
1. 收集 formValues（chips + 输入框）
2. runAction(currentId, params)  -- 已有实现
3. Provider 内部：setView("llm-chat"), setLlmText(""), setThinkingText("")
4. 事件流入：llm → setLlmText, llm-thinking → setThinkingText
5. done → setStatus("done"), 写入 localStorage 历史
```

改动点仅是 Provider 中 `if (action?.llm)` 分支从 `setView("llm")` 改成 `setView("llm-chat")`。

### 历史抽屉

- 从 `LlmChatView` 右侧滑出（position absolute，宽 316px）
- 数据来源：`useLlmHistory(actionId)` → `HistoryEntry[]`
- 点某条：thread 载入该条的 prompt + response（只读模式）
  - 顶部 banner：「正在查看历史 · 返回当前」
  - 输入框 disabled
- 底部：「最多保留 50 条 · 清空历史」

---

## 数据模型：useLlmHistory

```typescript
interface LlmHistoryEntry {
  id: string;         // nanoid(8) 或 timestamp
  timestamp: number;  // Date.now()
  actionId: string;
  prompt: string;     // 发送时的完整 prompt 值
  params: Record<string, string>; // 当时的 context params 快照
  response: string;   // assistant text（截断到 10KB）
  thinking?: string;  // thinking（截断到 5KB）
  exitCode: number;
  duration: string;   // "12.4s"
}
```

**存储**：
- key：`llm-history:<actionId>`
- 值：`LlmHistoryEntry[]`（倒序，最新在前）
- 封顶：50 条/卡片
- 写入时机：`action:<id>:done` 事件触发时
- response 截断：>10KB 截断 + `…（已截断）`后缀

**hook API**：
```typescript
function useLlmHistory(actionId: string): {
  entries: LlmHistoryEntry[];
  append: (entry: Omit<LlmHistoryEntry, 'id'>) => void;
  clear: () => void;
}
```

---

## 侧边栏改动

`AppSidebar.tsx` 新增第三个 `SidebarGroup`：

```
AI 对话 ──────────
  ◆ iCafe 卡片流转          ← topActions(llmActions, 3)
  ◆ 日志归因分析
  ⊞ 全部 AI 卡片             ← setView("llm-grid")
```

- 数据：`const llmActions = actions.filter(a => a.llm)`
- 现有「常用动作」改为：`actions.filter(a => !a.llm)`
- 使用频率独立 key：`useActionUsage("llm-usage")`

---

## RunnerView 扩展

```typescript
export type RunnerView =
  | "output" | "form" | "global" | "llm-chat" | "logcat"
  | "fragments" | "edit" | "workflow" | "workflow-form"
  | "workflow-edit" | "settings" | "actions-grid"
  | "workflows-grid" | "llm-grid";
```

旧 `"llm"` 值废弃（直接删除，无外部消费者）。

---

## 交互规则

| 场景 | 行为 |
|------|------|
| 列表页点卡片 | → llm-chat 空态 |
| 列表页点 preset chip | → runAction → llm-chat 流式中 |
| 侧边栏点 LLM 卡片 | → llm-chat（运行中则 focusRunning） |
| llm-chat 发送 | 清空上一轮 → 运行 → 流式填充 thread |
| 运行完成 | 自动写入 localStorage 历史 |
| 点历史条目 | thread 载入只读视图，banner 提示 |
| 点「返回当前」 | thread 恢复当前轮（或空态） |
| 切走再回来 | 如仍在运行 → 显示运行态（单缓冲，内容可能不全） |

---

## 不涉及

- 后端 `api.go` / `runner/` / `registry/` 无改动
- bindings 无需重生成
- YAML schema 不变
- 老 `LlmForm.tsx` 和 `LlmView.tsx` 可在本次删除或保留（建议删除，全部语义被 `LlmChatView` 覆盖）

---

## Mockup

`.design/llm-chat-mockup.html`（已生成，浏览器打开查看完整 4 屏静态 mockup）
