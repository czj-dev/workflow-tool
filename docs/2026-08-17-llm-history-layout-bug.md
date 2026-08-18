# 排查记录：LLM 历史查看「完成 · 时长」读数行不可见（Thread 布局溢出）

- **日期**: 2026-08-17
- **状态**: 已修复（`LlmChatView.tsx`，含回归测试）
- **影响面**: LlmChatView 聊天页（`viewing` 历史查看态与实时态共用同一布局）
- **验证**: Chromium + WebKit（WKWebView 同引擎）双端 playwright 实测

---

## 1. 现象

点击历史条目进入只读查看态后，轨迹正文正常渲染、「生成中」动效已消失（前序修复生效），但末尾的「完成 · 时长」读数行始终看不见，手动也不确定能否滚到；底部 composer 表现正常。

## 2. 排查路径

1. **先怀疑数据/状态**：上一阶段已修过 `liveIndex` 三态误判（`== null` 把 `durationMs: undefined` 的历史段当成 `null`=实时）。本轮确认 `panelFromHistory` 对真实历史条目产出 `readout {durationMs: 182605, isError: false}` 且 `streaming: false`，数据层无问题。
2. **浏览器复现 + 布局实测**（临时 repro 页 + `?mockup=hist` 入口，验证后已删）：
   - 读数行 `getBoundingClientRect()` 为 `[681, 697]`，viewport 高度 640——**渲染了但在视口外**；
   - `use-stick-to-bottom` 的真实滚动容器 `scrollTop` 已到最大值——**滚动逻辑没坏，是滚动容器本身太长**；
   - `[data-slot=thread]` 元素盒高 720px（= 整个 main 高度），而 main 里还有 banner(30) + header(44) + composer(87)，Thread 应只占剩余 ~560px。composer 实际也被推到 [792, 879] 视口外（用户「能看到 composer」是因为空态时内容矮，主干溢出不明显）。

## 3. 根因

`Thread` 组件（`frontend/src/components/nexus-ui/thread.tsx`）基类带 `h-full`（`height: 100%`）：

```tsx
className={cn("relative w-full h-full", className)}
```

LlmChatView 中它是 `main`（flex 列）的 flex 子项：

```tsx
<Thread className="flex min-w-0 flex-1">   /* 修复前 */
```

flex 子项默认 `min-height: auto`，而 `height: 100%` 参与最小内容计算后成了**高度托底**：`flex-1` 的收缩被这个 100% 底线挡住，Thread 不缩反撑，高度 = main 全高。结果整个滚动容器底部 ~72px 被裁出视口，恰好是读数行的位置。

> 关键认知：**`h-full`（height:100%）写进 flex 子项时不是「铺满剩余空间」，而是「至少父容器全高」。** 铺剩余空间是 `flex-1 + min-h-0` 的职责。Chromium 与 WebKit 行为一致，非引擎差异。

## 4. 修复（`frontend/src/components/LlmChatView.tsx`）

双保险：

1. **布局修复**：`<Thread className="flex min-h-0 min-w-0 flex-1">` —— `min-h-0` 解除托底，Thread 正常收缩到 flex 剩余空间，读数行与 composer 回到视口内。
2. **滚动兜底**：新增 `ThreadViewingScroll` 组件（挂在 `<Thread>` 内部，依赖 `useStickToBottomContext`），`viewing?.id` 变化（进入/切换/退出历史查看）时显式 `scrollToBottom()`——ThreadContent 整段替换的瞬间贴底状态可能失效，显式滚底保证读数行可见。

## 5. 回归测试（`frontend/src/components/LlmChatView.test.tsx`）

jsdom 无真实布局，无法直接断言可见性，改用两点守护：

- mock `use-stick-to-bottom` 的 `useStickToBottomContext`（保留 StickToBottom/Content 真实实现），断言点选历史条目后 `scrollToBottom` 被调用；
- 断言 `[data-slot="thread"]` 元素带 `min-h-0` 类——防止后续重构/升级 nexus-ui thread 组件时把布局修复悄悄抹掉。

## 6. 经验

| 陷阱 | 说明 |
|------|------|
| `scrollTop` 已到底 ≠ 内容可见 | 滚动容器自身溢出视口时，`scrollTop === scrollHeight - clientHeight` 照样成立。排查「看不见」必须量 `getBoundingClientRect()` 对比 viewport |
| 查滚动指标要找对元素 | `use-stick-to-bottom` 的 `[data-slot=thread]` 本身不滚动，真实滚动容器是它内部渲染的子 div |
| flex 子项带 `h-full` | 视为最小高度托底，`flex-1` 失效；要么去掉 `h-full`，要么配 `min-h-0` |
| 复现页要还原布局链 | 一开始 repro 用 `h-screen` 代替真实链条（`SidebarProvider h-svh → SidebarInset flex-1 → main flex-1`），百分比高度解析不同会误导结论；复现布局问题必须逐层还原 |
| 引擎选择 | WKWebView 是 WebKit，macOS 上可用 `playwright-cli open --browser webkit`（需 `install-browser webkit`）直接验证，Chromium 通过不代表 WebKit 通过（本例两者恰好一致） |
