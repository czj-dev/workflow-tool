# Workflow Tool — 设计文档：LLM Action 流式输出

- **日期**: 2026-07-30
- **状态**: 设计已与用户确认，待写实现计划
- **技术栈**: Go（Wails v3 alpha2.119）+ React 19 + TS + shadcn/ui + nexus-ui（`shadcn add` 引入；MessageMarkdown 基于 Streamdown）
- **关联**: Phase 3（配置与参数系统）；Windows shell 已改 PowerShell
- **范围**: 给 `claude -p` 类动作增加**流式输出**与**专用 LLM 输出区**。只支持本地 claude CLI。

---

## 1. 背景与目标

`claude -p` 默认 text 模式**不流式**：实测写一首诗要等 31s 才一次性输出全部内容，点击后长时间空白，体感「很慢」。

根因：`claude -p` 默认把完整响应生成完再输出。要流式必须加 `--output-format=stream-json --verbose`，它逐行输出 JSON 事件（token/块逐步到达）。

目标：让这类 LLM 动作
1. 在 YAML `command` 标记为 LLM action（`stream: llm`）；
2. 后端解析 `claude` 的 stream-json 输出，**只把 assistant 文本增量**实时推给前端；
3. 前端有**专用 LLM 输出区**（新视图），用 Streamdown（npm 包，Vercel 维护）流式渲染 markdown。

---

## 2. 范围边界

| 类别 | 是否改动 |
|------|----------|
| `registry.Command` 加 `Stream` 字段 + 校验 | **扩展** |
| `runner`：`stream=="llm"` 时按 stream-json 解析 stdout | **扩展**（新增 LLM 解析，Shell 执行路径不变） |
| `api`：`ListActions` 带回 `stream`；emit 复用 output 事件（stream="llm"） | **扩展** |
| 前端：Provider 加 `llmText` + `view="llm"`；新 `LlmView`；OutputPanel 加分支 | **扩展** |
| nexus-ui `message` 组件（shadcn CLI 引入） | **新增依赖（copy-paste 源码）** |
| 多轮对话 / reasoning 显示 / 工具调用展示 / 专用停止按钮 | **不做（YAGNI）** |

---

## 3. YAML Schema

`Command` 加一个可选字段 `stream`：

```yaml
id: claude-ask
title: 问 Claude
icon: 🤖
params:
  - id: QUESTION
    label: 问题
    type: text
    required: true
command:
  # 用户自己写全 claude 的流式参数（--output-format=stream-json --verbose）
  shell: claude -p "${QUESTION}" --output-format=stream-json --verbose
  stream: llm        # 新字段：缺省 "" = 现有逐行输出；"llm" = stream-json 解析
  timeout: 5m
```

> ⚠️ `--output-format=stream-json --verbose` 必须在 prompt 引号**外**（是 claude 的选项，不是 prompt 内容）。

校验：`stream` 只允许 `""` 或 `"llm"`，其他值报错。

---

## 4. stream-json 协议取证（claude v2.1.207）

`claude -p "..." --output-format=stream-json --verbose` 每行输出一个 JSON 事件。实测事件类型：

| type | 含义 | 处理 |
|------|------|------|
| `system`（subtype: hook_started/hook_response/init/thinking_tokens/notification） | hooks、初始化、思考 token 计数、通知 | **忽略** |
| `assistant` | LLM 输出：`message.content[]`，块类型有 `{"type":"thinking","thinking":"..."}` 与 `{"type":"text","text":"..."}` | 取 `text` 块的 `text` 推给前端；`thinking` 忽略 |
| `result`（subtype: success/error） | 结束：含 `result`（最终全量文本）、`duration_ms`、`usage`、`total_cost_usd` | 作为结束标志（触发 done） |

**增量 vs 累积**：短输出（"OK"）只 1 个 text 事件；长输出 text 事件内容较大。实现时用长输出（如写诗）验证 text 是「每事件一段增量」还是「累积 snapshot」：
- 若为增量 → 前端 `llmText` **累加** delta。
- 若为累积 → 前端 `llmText` **覆盖**为最新 text（或后端 emit 差值）。

默认按「增量累加」实现，实现时据实测调整；`result.result` 可用作最终校正兜底。

---

## 5. 后端架构

### 5.1 `registry`
- `Command` 加 `Stream string \`yaml:"stream"\``。
- `validate`：`stream` ∈ `{""|"llm"}`，否则报错。
- `ActionItem`（api 层）加 `Stream string \`json:"stream"\``，`ListActions` 带回。

### 5.2 `runner`
- `ShellConfig` 加 `Stream string`（由 api 从 `la.Def.Command.Stream` 透传）。
- `ShellRunner.Run` 的 stdout pump 分两种模式：
  - `Stream==""`（默认）：现有行为不变（逐行 emit `stream:"stdout"/"stderr"`）。
  - `Stream=="llm"`：每行先 `json.Unmarshal` 到一个通用结构，过滤 `type=="assistant"` 且 `content` 含 `{"type":"text"}` 块 → emit `stream:"llm"`, `line=text`；其他事件跳过。**无法解析的行**降级为原样 emit（带 warning），保证鲁棒。
- 新增独立解析函数 `parseLLMLine(line string) (delta string, ok bool)`，便于单测。
- **Shell 执行路径不变**（仍 PowerShell 跑 claude）；只是 stdout 的解读方式不同。

### 5.3 `api`
- `execute` 构造 `ShellConfig` 时带上 `Stream: la.Def.Command.Stream`。
- emit 复用现有 `action:{id}:output` 事件：`{stream, line}`，LLM 文本用 `stream:"llm"`。前端按 `stream` 分流。
- `action:{id}:done` 不变。

### 5.4 运行时数据流

```
前端 runAction(id, params)
  → api.RunAction → execute（ShellConfig.Stream="llm"）
  → ShellRunner.Run（PowerShell 跑 claude -p "..." --output-format=stream-json --verbose）
  → stdout 每行 JSON
  → parseLLMLine：type=assistant 的 text 块 → delta
  → emit action:{id}:output {stream:"llm", line:delta}
  → （result 事件后）claude 退出 → action:{id}:done
前端：stream=="llm" 的 action 运行时 view="llm"，delta 累加到 llmText
  → nexus-ui MessageMarkdown 流式渲染
```

---

## 6. 前端架构

### 6.1 `ActionRunnerProvider` 状态扩展

| 新增状态 | 类型 | 说明 |
|----------|------|------|
| `llmText` | `string` | 当前 LLM action 的累积文本 |

方法/行为扩展：
- `runAction(id, params)`：若该 action `stream==="llm"`，先 `setLlmText("")` + `setView("llm")`（代替 `view="output"`）。
- output 事件处理：`stream==="llm"` → `setLlmText(prev => prev + line)`（不进 `lines`）；其他 stream 走原逻辑。
- done 事件：LLM action 也走 done（status 更新），view 保持 `llm`。
- `view` 类型加 `"llm"`：`"output" | "form" | "global" | "llm"`。

### 6.2 新组件 `LlmView.tsx`
- 用 nexus-ui `Message`（`from="assistant"`）+ `MessageContent` + `MessageMarkdown` 渲染 `llmText`（Streamdown 流式 markdown）。
- 第一版**只显示 assistant 回复**（用户 prompt 的回显留待后续——LLM action 的 prompt 是 params 的某个字段，无约定标记，先不猜）。
- `view==="llm"` 时由 `OutputPanel` 渲染。

### 6.3 `OutputPanel`
- 加 `view==="llm"` 分支 → `<LlmView />`。

### 6.4 `ActionItem` / 触发
- LLM action（有 params）点击仍先进表单（`selectPreset`），提交后 `runAction` 切 `view="llm"`。
- 无 params 的 LLM action 直接运行切 `view="llm"`。

### 6.5 nexus-ui 引入（shadcn add，源码进项目）
- `npx shadcn@latest add @nexus-ui/message` —— 把 message 组件源码（及其依赖 Streamdown 等）copy 进 `frontend/src/components/nexus-ui/`。
- 项目已是 React 19 + Tailwind v4 + shadcn/ui，满足 nexus-ui 前置条件。
- 注意：这是 shadcn「own your code」模式（源码进项目、由本项目维护、升级重新 add），**非 npm 依赖**；`@nexus-ui/*` 不是 npm 包（npm registry 不存在）。

---

## 7. 测试策略

| 层 | 测什么 | 怎么测 |
|----|--------|--------|
| runner | `parseLLMLine`：造 stream-json 行（system/assistant-thinking/assistant-text/result），断言只返回 text 块的 delta；非法行降级 | 纯函数单测，造假 JSON 行 |
| registry | `Command.Stream` 解析 + 校验（非法 stream 报错） | 临时 YAML |
| api | `ListActions` 带回 stream；`execute` 透传 Stream | 现有 api 测试模式 |
| 前端 | Provider 收 `stream:"llm"` 事件累加 `llmText` + 切 `view="llm"`；`LlmView` 渲染 `llmText` | Vitest + Testing Library（mock nexus-ui 或真实渲染） |

---

## 8. 明确不做（YAGNI）

- 多轮对话（单次 prompt → 单次回复，不维护历史）。
- reasoning / thinking / 工具调用 / hook 事件显示（只显示 text）。
- 生成中专用的「停止」按钮（先复用现有 cancel）。
- 接其他 LLM provider（只 claude CLI；未来再抽象 LLMRunner）。
- 后端自动注入 `--output-format=stream-json`（用户自己写）。

---

## 9. 风险

| 项 | 说明 | 缓解 |
|----|------|------|
| stream-json 格式随 claude 版本变 | 解析用宽松通用结构 + 降级（无法解析行原样输出 + warning） | 鲁棒解析 |
| text 增量 vs 累积语义 | 决定前端累加/覆盖 | 实现时长输出实测确认；`result.result` 兜底校正 |
| nexus-ui v1.0 新库 | copy-paste 源码进项目，即使停维也可控；依赖 Streamdown 等 | 源码在内，可自行维护 |
| 前端测试渲染 nexus-ui | nexus-ui 组件依赖较多，测试可能复杂 | 必要时 mock `LlmView` 的 nexus-ui 部分，只测 Provider 累加逻辑 |

---

## 10. 验收标准

- [ ] `claude-ask.yaml` 加 `stream: llm` 后，点击 → 右侧切到 LLM 视图，token 逐步流式出现（不再 31s 空白）
- [ ] LLM 视图用 markdown 渲染（代码块/列表/标题格式化）
- [ ] 思考过程 / hook / token 计数等噪音**不显示**
- [ ] 普通动作（无 stream: llm）行为完全不变（向后兼容）
- [ ] `stream` 非法值在加载时报错
- [ ] 四层单测全绿；`npm run build` + `go build` exe 联调通过
- [ ] 改 `api.go`/`registry` 后 `wails3 generate bindings` 重跑，前端类型同步
