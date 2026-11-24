# AI 体系独立与调度接入设计规格

> 本规格把 ADR-0004 至 ADR-0007 的结论展开为可实现的设计，覆盖四个里程碑：M1 AI 体系独立 → M2 Schedules 接入 → M3 运行记录与日志 → M4 续跑与补跑。术语以 `CONTEXT.md` 为准。
>
> 本规格修订了 `2026-11-12-scheduler-panel-design.md` 中与之相反的非目标：AI 任务成为第三种调度目标，补跑、跨进程运行与完整运行日志都在范围内。

## 目标

- AI 任务成为与动作、工作流并列的第三种可执行物：独立的定义目录与 schema、独立的运行入口与事件。`command.llm` 连同全部相关逻辑删除，不留兼容入口，也不留提示。
- 既有 5 个 LLM 动作静态改写为 AI 任务，id 不变。
- 调度统一承担全部定时行为；AI 任务是第三种调度目标，定义里没有任何时间字段。
- 每次运行不论来源都留下运行记录与运行日志；应用自身有应用日志。
- 无人值守的运行不随应用退出而夭折，重启后可认领、可续跑。

## 数据模型

### AI 任务定义

一任务一文件，位于可执行文件同级的 `ai/<id>.yaml`。

```yaml
id: claude-card-transfrom        # 必填，^[a-z0-9-]+$，ai/ 内唯一
title: iCafe 卡片流转             # 必填
icon: hi:ai                      # 可选
description: 输入卡片与操作要求，自动流转   # 可选
color: violet                    # 可选，四色板 amber/green/blue/violet
params:                          # 可选，结构与动作的 params 相同
  - id: CARD_ID
    label: iCafe 卡片信息
    type: text
    required: true
presets:                         # 可选，结构与动作的 presets 相同
  - name: 关闭
    values: { STATE: 已关闭 }
system: |                        # 可选，模板；只写角色与纪律
  你是一个 sess 平台的专业助手。
prompt: |                        # 必须出现（可为空串），模板
  请根据以下操作要求处理 ${CARD_ID} 卡片
  将卡片流转到 ${STATE}
timeout: 30m                     # 可选，默认 30m
cwd: ${XDZS_SPEECH_DIR}          # 可选，模板；空则为应用目录
env: { KEY: value }              # 可选，值为模板
skills: [icafe-skill]            # 可选，skill id，须存在于 skills/
```

解析是严格的：

- 未知顶层键报错，并列出全部合法键。
- `timeout` 必须是合法的 Go duration，非法直接报错，不回落到默认值。
- `prompt` 键缺失报错。`prompt: ""` 合法，表示提示词由调用方给入；运行时展开后仍为空，则该次运行失败，原因写明「提示词为空」。
- `params[].id` 不得占用保留运行参数。
- `presets[].values` 的键必须是已声明的 param 或保留运行参数，否则报错。
- params 的类型、select 的 options、数组类型默认值的校验与动作一致。

**保留运行参数**：所有 AI 任务无需声明即接受 `prompt`、`system`、`resume` 三个运行参数。

- 传入 `prompt` 或 `system` 即替换定义里的模板。替换进来的值同样是模板，照常展开。
- `resume` 非空时以 `--resume <id>` 续接该会话；否则每次运行新开会话。
- 聊天、预设、工作流步骤、调度四处是同一规则。

**预留字段**：只在 schema 中约定，暂不实现。出现即加载失败，报「字段已预留、暂未实现」。

- `model`：指定模型。
- `effort`：推理投入档位。
- `permission`：权限级别。M1 起所有运行固定 bypass，只读类任务暂不区分。
- `budget`：单次运行的时长或费用上限。
- `add_dir`：额外可访问的目录。
- `cli`：指定本任务使用的 Agent CLI。
- `tools`：允许或禁用的工具集。
- `mcp`：额外的 MCP 服务器。
- `session`：定义级的会话策略。
- `outputs`：基线产出之外要求 Agent 产出的结构化产出。

### 调度目标扩展（M2、M4）

`schedules.yaml` 的每条调度恰好指向一个目标，`action`、`workflow`、`ai` 三选一。新增 `catch_up`，布尔，默认 false。

```yaml
schedules:
  - id: nightly-verify
    name: 夜间协议验证
    enabled: true
    cron: "0 2 * * *"
    ai: xdzs-verify-fix
    catch_up: false
    params:
      CASE_INPUT: |
        {"header": {"namespace": "iov_nlu"}}
```

完成通知、失败重试这类「跑完怎样」的设置属于调度，对三种目标一视同仁。

### 运行记录（M3）

运行记录位于可执行文件同级的 `runs/<run-id>/`，不入仓库。

- `run.json`：运行记录本体。
- `events.ndjson`：运行日志，即该次运行 output 事件的逐行落盘，与前端收到的事件同构；运行详情用它回放。
- `heartbeat`：仅执行器运行的运行才有，见「进程模型」。
- `run-id` 由启动时刻（到秒）与随机后缀组成，目录名即 id。

```json
{
  "id": "r20261124-021500-a1b2c3",
  "target": { "kind": "ai", "id": "xdzs-verify-fix" },
  "origin": "schedule",
  "schedule_id": "nightly-verify",
  "params": {},
  "status": "succeeded",
  "reason": "",
  "started_at": "2026-11-24T02:15:00+08:00",
  "finished_at": "2026-11-24T02:19:12+08:00",
  "exit_code": 0,
  "outputs": { "text": "…", "session_id": "…", "cost_usd": "0.12" },
  "process": { "mode": "executor", "pid": 4321, "started_at": "…", "heartbeat_at": "…" },
  "rules": "…"
}
```

- `origin` 三选一：`schedule`（调度到点）、`run-now`（立即运行）、`manual`（手动运行）。
- `params` 是本次运行的输入原样留存，含保留运行参数。
- `process.mode` 为 `executor` 或 `in-app`。pid 与进程启动时间在此落档。
- `rules` 仅 AI 运行有，是本次注入的守则全文。任务的 YAML 不是发给 Agent 的完整系统提示。
- **终态只写一次**：`run.json` 在启动时写一次（`running`），结束时写一次终态。任何路径不得二次改写终态。
- 保留策略：每个目标最多保留 50 次运行，且超过 30 天的记录一律清理。

### 应用日志（M3）

`logs/app.log` 位于可执行文件同级，NDJSON，单文件 5MB，保留 3 份。记录调度与运行器自身的行迹：到点、跳过、错过、认领、中断。

## 模板与输入

- `prompt`、`system`、`cwd`、`env` 的值都是模板，支持 `${VAR}`。
- 每次运行展开一次，查找顺序：本次输入 → `config.yaml` → 内置变量 → 环境变量。未命中保留原样并记 warning。
- 输入是原样的。调用方传入的参数值不做任何 `${VAR}` 展开，用户在输入框里写 `${X}` 就原样进入提示词。
- 传入未声明的参数名报错，避免拼写错误静默落空。
- 工作流的 AI 步骤：`params` 只做 `${{ }}` 替换，不做 `${VAR}` 展开。要带入工作流参数或配置，写 `${{ params.NAME }}` 或 `${{ config.NAME }}`。

```yaml
steps:
  - id: analyze
    name: 分析缺陷
    ai: claude-bug-analyze
    params:
      BUG_URL: ${{ params.BUG_URL }}
      prompt: |
        只分析崩溃线程，卡片：${{ params.BUG_URL }}
```

AI 步骤的产出写入 `steps.<id>.outputs`，后续步骤用 `${{ steps.analyze.outputs.text }}` 引用。

## 无人值守守则

- 守则全文放在可执行文件同级的 `ai-rules.md`。文件不存在时用内置默认。每次运行前读取，改完即生效。
- 运行器把守则与任务的 `system` 合成一份系统提示，经单个 `--append-system-prompt` 参数传给 Agent：守则在前，`system` 在后。`system` 为空则只有守则。
- 所有 AI 运行以 `--permission-mode bypassPermissions` 启动，不新增审批机制。`schedules.yaml` 的任何改动因此等同于可执行代码的改动。
- 任务的 `system` 只写角色与纪律，环境约束不写进任务。

内置默认：

```markdown
# 无人值守守则

你运行在无人值守的 headless 进程里：没有人回答你的提问，也没有人替你确认操作。下面三条描述的是本次运行的环境，与你承担的角色无关。

1. 无人可问，自行决断。需要澄清或确认时不要提问、不要等待，按最可能的理解继续，并在结论中写明你做了哪些假设。
2. 进程退出即任务结束。你只有这一次调用：禁止使用定时唤醒、循环调度、后台子代理等异步续跑机制，它们会让任务被提前判定完成。所有工作必须在当前进程内同步串行完成。
3. 一律使用绝对路径。脚本与命令用绝对路径调用，不依赖当前工作目录，也不要用切换目录代替绝对路径。
```

## 产出契约

一次 AI 运行的基线产出固定为：

- `text`：最终回复。
- `thinking`：思考过程。
- `session_id`：会话 id。
- `cost_usd`、`input_tokens`、`output_tokens`、`total_tokens`。

失败或超时时 CLI 没有给出的字段缺省。`session_id` 只要拿到就带上：失败与超时的时刻恰恰最需要它来续接。`outputs` 预留字段用于在基线之外声明结构化产出。

## 后端边界

### internal/ai（新增）

AI 任务的 schema、严格解析、校验与加载：`Task`、`Parse`、`Validate`、`Load`。

- 复用 `registry` 的 `ParamSpec`、`Preset`、`FileError`、`ValidAmbColors`、`AddPresetToYAML`。
- 不依赖 Wails、api、runner。
- skills 扫描仍由动作加载完成，`Load` 接收扫描结果做 `skills` 引用校验。

### internal/airun（新增）

把一份任务定义与一次运行的输入构造成 `runner.AIRunner`：模板展开、保留运行参数合并、守则读取、env 合并、skill 路由与同步。skillrouter 与 skillsync 从 `actionrun` 迁到这里。

### internal/runner

- `AIRunner` 与 `AIConfig`，即原 `LLMRunner` 与 `LLMConfig`。
- 构 argv，解析 stream-json，只把 assistant 的 text、thinking 与工具调用对 emit 为 `ai`、`ai-thinking`、`ai-tool`。
- CLI 名取 `config.yaml` 的 `AI_CLI`，缺省 `ducc`。
- `MergeEnv` 导出，供 `airun` 使用。

### internal/actionrun

只剩 shell/script 与 adb 两种形态的构造，以及工作流的 action step 与 inline run step 回调。`Deps.SkillRouter` 删除。

### internal/registry

删除 `LLMCommand` 与 `Command.LLM`。`command` 回到 run/script/adb 三选一。

### internal/workflow

- `Step.AI`，即 `ai: <任务id>`，与 action、run、sleep 互斥。
- 执行器新增 `AIRunFunc` 回调，分发 AI 步骤时只做 `${{ }}` 替换。

### internal/api

- `aiRunning`：AI 任务的运行簿记，手动运行与工作流 AI 步骤共用。
- 方法：`ListAiTasks`、`RunAi`、`CancelAi`、`GetAiYaml`、`SetAiYaml`、`AddAiPreset`。
- `Reload` 同时重载 `ai/`。
- `WorkflowStepInfo.Kind` 增加 `ai`。
- `GetVarReferenceCounts` 统计 AI 任务的 prompt、system、cwd、env。

### internal/cli

- `list` 输出 `kind: ai` 的条目；`describe` 与 `run` 接受 `--kind ai`。
- headless 运行 AI 任务与含 AI 步骤的工作流继续被拒绝（`ai_blocked`），M4 起以显式放行标志开放。

## 运行状态与事件

状态词汇：

- 运行：`running` → `succeeded`、`failed`、`cancelled`、`interrupted`。
- `failed` 的 `reason` 可为「超时」。超时不算取消。
- `cancelled`：人主动终止的运行。
- `interrupted`：因应用退出或崩溃而没能得出结果。
- 调度时刻：`skipped`（目标正在运行）、`missed`（应用未在运行）。

事件：

- `ai:<id>:output`：`{stream, line, seq}`。`stream` 为 `stdout`、`stderr`、`ai`、`ai-thinking`、`ai-tool`。
- `ai:<id>:done`：`{exitCode, err, duration, readout?, seq?}`。`readout` 含 `durationMs`、`sessionId`、`costUsd`、`inputTokens`、`outputTokens`。
- 排序协议与 `action:<id>:*` 相同：output 自带递增 `seq`，done 独占一个号。
- 工作流里的 AI 步骤不发 `ai:<id>:*`，其输出带步骤归属落在 `workflow:<wf-id>:output` 上，`stream` 同上。
- 外部契约里的 LLM 字样一律改为 AI：事件流的种类、本地存储键、`config.yaml` 的 `AI_CLI`。

## 目标锁与冲突

- 互斥按目标：同一目标同一时刻只有一个运行，不论来自手动运行、调度还是工作流步骤。
- 工作流的 AI 步骤与动作步骤同样占目标锁，撞上立即失败，不等待。
- 步骤的 ctx 派生自工作流 ctx：取消工作流会终止该步骤，从 AI 任务上取消同样终止该步骤。
- 调度到点撞上：记为 `skipped` 并注明原因。不排队，不覆盖该目标上一次真实运行的结果。
- 立即运行撞上：返回错误并提示「已在运行，已跳过」。
- 手动运行撞上：返回「正在运行」，前端回到该任务的对话页。
- M1 只做 AI 任务的目标锁，放在应用内存里。M4 换成落盘的跨进程锁，并把动作步骤纳入。

## 进程模型

按发起来源分两条路径：

- **手动运行**留在应用进程内。应用退出时终止，留档为 `interrupted`。
- **调度到点与立即运行**交给执行器（M4）：同一可执行文件的 `run` 子命令，headless 运行，标准输出重定向到该次运行的 `events.ndjson`，不随应用退出。
- 执行器带环境标记 `WORKFLOW_TOOL_EXECUTOR=1`，带标记的进程内不启动调度器，定时任务不会再拉起定时任务。

认领：

- 执行器每 10 秒写一次心跳，并把 pid 与进程启动时间写进运行记录。
- 应用启动时逐条检查 `running` 记录。执行器运行且心跳新鲜则认领：继续显示为运行中，运行详情可回放日志。
- 心跳过期时核对 pid 与启动时间（防 pid 复用），进程仍存活则再等一个心跳周期。确认不在运行的改写为 `interrupted`。
- 应用内的运行在应用启动时一律是 `interrupted`。

停止：

- 停止执行器运行的运行：应用写入 `runs/<run-id>/STOP`，执行器每秒轮询，见到即杀进程组，以 `cancelled` 收尾。不依赖 POSIX 信号，Windows 同样可用。
- CLI 的 SIGINT/SIGTERM 处理保留。

应用仍须在到点时运行。本设计不接管系统级定时。

## 调度行为

- 30 秒 tick 不变。
- 调度器持久化每条调度的上次到点时刻（M4）。应用恢复后算出其间错过的时刻，每个记一条 `missed`。`catch_up: true` 时只为最近一个错过的时刻补跑一次。
- 调度的 `params` 覆盖目标输入：键是目标的 param id 或保留运行参数，保存时按目标校验。
- 立即运行以该调度的参数发起，`origin` 为 `run-now`。

## 迁移

M1 一次性完成，全为静态改写：

- 5 个 LLM 动作从 `actions/` 迁到 `ai/`，id 不变：`claude-ask`、`demo-llm-skill`、`claude-card-transfrom`、`xdzs-verify-fix`、`claude-bug-analyze`。
- `llm.system` 与 `llm.prompt` 指向的 param，其默认文本内联为任务的 `system` 与 `prompt`，该 param 删除。
- `SESSION_ID` param 与 `llm.resume` 删除，改由保留运行参数 `resume` 承担。
- `skills`、`cwd`、`timeout` 提到顶层。
- 预设里指向被删 param 的值改指向 `prompt`。
- 角色文本里与守则重复的环境规则删除；任务专属的句子保留。
- `config.yaml` 的 `LLM_CLI` 改为 `AI_CLI`。
- 本地存储键改名：`ai-usage`、`ai-history:<任务id>`。旧的 `llm-usage`、`llm-history:*` 不迁移，统计从零开始。
- 残留 `command.llm` 的动作文件不会得到专门提示，只会落入通用的必填校验报错。

## 前端接入

### M1

- 侧栏 Workspace 分组为 Actions、Workflows、AI 任务。AI 任务沿用紫色分组。
- AI 任务条目：闲时点击进对话页；运行中点击回到对话页。运行由工作流步骤占用时，点击回到该工作流。
- `RunnerView` 以 `ai-grid`、`ai-chat`、`ai-edit` 取代 `llm-grid`、`llm-chat`。
- AI 卡是双态卡：
  - 叙述区放最近一次运行的摘要。M1 与 M2 取自应用内会话历史，M3 起取自运行记录。
  - 功能行是预设 chips、对话、编辑配置与运行。
  - 运行是单一主控：按该任务表单当前值直接运行，不切视图，卡片与侧栏显示运行徽标。提示词为空时改为进入对话。
  - 对话是次级动作：进对话页改提示词再跑。
  - 编辑配置直达该任务的 YAML 编辑页。
- 表单草稿每个任务一份，按任务隔离，优先级为预设 > 定义默认 > 全局配置。草稿包含声明的 params 与 `prompt`、`system`、`resume` 三个保留运行参数。
- 对话页：
  - 输入框绑定 `prompt`。
  - 角色 chip 编辑 `system`。
  - 续接 chip 编辑 `resume`。查看历史条目即把该条目的 session id 回填到 `resume`。
- 工作流：
  - 步骤图标表增加 `ai`。
  - AI 步骤的回复增量按行落到该步骤的输出桶。工序段渲染在 M3。
- 新建 AI 任务只有 YAML 一条路。

### M2

- 调度编辑器的目标类型从两种变三种。参数区对 AI 目标额外提供 `prompt` 与 `system` 两个保留运行参数字段。
- AI 卡显示其所属调度的投影：cron、启停、最近结果。提供「定时」入口，复用调度编辑器并把目标锁定为该任务。同一任务可建多条调度。

### M3

- 统一的运行记录列表：全部目标，按时间倒序，可按目标、状态、来源筛选。
- 运行详情：结论、产出与可回放的渲染过程。AI 运行用工序段面板回放。全应用只有这一处查看运行过程。
- AI 步骤在 Pipeline Spine 中以工序段渲染。
- 应用内的会话历史由运行记录取代。

### M4

- 运行详情提供「续跑」：以同一份输入加 `resume: <session_id>` 发起新运行。

## 里程碑

- **M1 AI 体系独立**：`internal/ai`、`internal/airun`、`AIRunner`、守则注入、工作流 AI 步骤、API 与事件、应用内目标锁、前端 AI 任务视图、CLI 的 `--kind ai`、5 个任务的静态迁移、文档。
- **M2 Schedules 接入**：AI 任务成为调度目标、调度编辑器、AI 卡的调度投影、冲突记为跳过、立即运行。
- **M3 运行记录与日志**：`runs/` 与运行记录、运行记录列表与运行详情、保留策略、应用日志、AI 步骤的工序段渲染。
- **M4 续跑与补跑**：执行器、跨进程目标锁（含动作步骤）、心跳认领、停止标记、中断留档、`missed` 与 `catch_up`、续跑、CLI 的显式放行标志。

## 测试验收

### Go（M1）

- `internal/ai`：严格解析拒绝未知键与预留字段；`prompt` 缺失报错而空串合法；params 不得占用保留运行参数；预设键校验；`timeout` 非法报错；skills 引用校验。
- `internal/airun`：模板按输入与配置展开；输入原样不展开；未声明的参数报错；`prompt` 与 `system` 覆盖生效；守则文件存在与不存在两种来源。
- `internal/runner`：守则与 `system` 合成单个 `--append-system-prompt`；事件流种类为 `ai`、`ai-thinking`、`ai-tool`。
- `internal/registry`：`command.llm` 不再是合法形态，三选一校验。
- `internal/workflow`：`ai` 与 action、run、sleep 互斥；AI 步骤的 params 只做 `${{ }}` 替换；产出可被后续步骤引用。
- `internal/api`：AI 任务列表、运行、取消、YAML 读写、预设；并发拒绝；工作流 AI 步骤占锁并在冲突时立即失败；取消工作流终止 AI 步骤。
- `internal/cli`：`list` 含 ai；`describe --kind ai`；`run` 对 AI 任务与含 AI 步骤的工作流返回 `ai_blocked`。

### 前端（M1）

- 侧栏显示 AI 任务分组与条目，点击进入对话页。
- AI 卡的运行按钮以后台方式发起运行并显示徽标；对话按钮进入对话页；编辑配置进入 YAML 编辑页。
- 对话页按草稿发送，`prompt`、`system`、`resume` 与声明参数一并下发。
- 运行中的任务由工作流步骤占用时，点击回到该工作流。
- 工作流步骤图标表识别 `ai`。

### 后续里程碑

- M2：调度保存与校验三种目标；冲突记为跳过且不覆盖上次真实结果；AI 卡的调度投影。
- M3：运行记录的写入、终态只写一次、保留策略清理；运行详情回放；日志轮转。
- M4：执行器不随应用退出；心跳认领与过期判定；停止标记；错过留档与补跑开关；跨进程互斥。

## 非目标

- `*/n` 步进的 Cron 与调度级时区。
- 完成通知。
- 跨机器调度。
- 系统级定时；不退役现有 launchd。
- 任务级的权限分级。`permission` 只预留。
