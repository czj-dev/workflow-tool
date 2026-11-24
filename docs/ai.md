# AI 任务定义指南

AI 任务（AI Task）是与动作、工作流并列的第三种可执行物。动作是「给定输入得到确定结果」，AI 任务是「说明意图，由 Agent 自行决定路径」：YAML 里不写命令，只写角色、任务正文、输入与运行约束，具体怎么做交给本机的 Agent CLI。在 `ai/` 目录下放一个 `.yaml` 文件即可新增一个 AI 任务，无需写代码。

AI 任务有两个入口：在界面上手动运行，或作为工作流的一步（AI 步骤）。定义里没有任何时间字段——定时由调度承担，而调度目前只能直接指向动作和工作流，直接指向 AI 任务是后续里程碑（M2）的内容。CLI 能列出、描述 AI 任务，但不能运行它。

设计结论见 [ADR-0004](adr/0004-ai-task-independent.md)（AI 任务独立于动作）与 [ADR-0007](adr/0007-unattended-ai-runs.md)（无人值守运行与守则），术语见 [CONTEXT.md](../CONTEXT.md)。

## 完整字段参考

```yaml
id: claude-bug-analyze          # 必填，^[a-z0-9-]+$，ai/ 内唯一
title: 分析 bug 卡片             # 必填，侧栏/卡片/会话页显示文字
icon: hi:ai                     # 可选，hugeicons 图标 key 或 emoji，默认 hi:ai
color: violet                   # 可选，卡片氛围色：amber | green | blue | violet（不写按组序循环）
description: 简要说明            # 可选，UI 悬停提示

params:                         # 可选，输入参数（结构同动作的 params）
  - id: BUG_URL                 # 参数 ID，用于 ${BUG_URL} 引用；不能叫 prompt/system/resume
    label: iCafe 卡片链接        # 会话页里该参数 chip 的标签
    type: text                  # text | bool | select | path | file | textarea | list | arguments
    required: true
    default: ""                 # 可选，默认值本身是模板
    options: []                 # select 类型必填
    description: 可选说明

presets:                        # 可选，预设输入
  - name: 示例卡片
    description: 可选描述
    values: { BUG_URL: "https://example.com/card/1" }   # 键必须是已声明的参数或保留运行参数

system: |                       # 可选，模板：只写角色与纪律
  你是 bug 分析师，只基于取到的证据下结论。
prompt: |                       # 必须出现的键，模板；提示词由调用方给入时写 prompt: ""
  根据卡片 ${BUG_URL} 给出根因假设与验证命令。
timeout: 30m                    # 可选，Go duration，默认 30m
cwd: ${PROJ_DIR}                # 可选，模板，默认应用目录（可执行文件同级）
env:                            # 可选，值为模板
  KEY: value
skills: [demo-skill]            # 可选，skill id，须存在于 skills/
```

## 字段详解

### id

- 格式：`^[a-z0-9-]+$`（小写字母、数字、连字符）
- `ai/` 内唯一，重复 id 的文件加载时报错
- 加载时扫描 `ai/*.yaml`，以文件内的 `id` 为准，文件名建议与之相同
- 与动作、工作流各自独立命名，重名时界面上互不影响，CLI 用 `--kind ai` 消歧。建议不要重名
- 同时用作手动运行的事件通道名：`ai:<id>:output` / `ai:<id>:done`

### title、icon、color、description

与动作相同：

- `title` 必填
- `icon` 可选，`hi:<key>`（key 见 `frontend/src/components/ActionIcon.tsx`）或 emoji / 文本；不写默认 `hi:ai`
- `color` 可选，卡片氛围色：`amber` / `green` / `blue` / `violet`；不写按分组显示序循环，非法值加载失败。见 [ADR-0003](adr/0003-ambient-color.md)
- `description` 可选：卡片悬停提示；没有历史记录时也用作卡片叙述区和会话页空态的说明文字

### params（输入参数）

结构、类型与校验与动作的 `params` 完全相同（类型说明见 [action.md](action.md) 的「params（参数表单）」），区别只在用法：

- 驱动的不是表单抽屉，而是会话页输入框上方的参数 chip
- `id` 必填、唯一，且不能是保留运行参数 `prompt` / `system` / `resume`
- `default` 本身是模板，可以引用其他参数（规则见「输入与模板」）
- `list` / `arguments` 的 `default` 与预设值同样须写成 JSON 字符串

参数值在模板里用 `${ID}` 引用，并作为同名环境变量进入 Agent 子进程。

### presets（预设）

结构与动作相同（`name`、可选 `description`、`values`）。多一条校验：`values` 的键必须是已声明的参数或保留运行参数，否则加载失败——预设里给出 `prompt` 就等于预设了一段提示词。

UI 行为与动作不同：AI 任务的预设只把值填进草稿，不直接起跑（见「界面」）。

### system

可选，模板。只写这个任务的角色与纪律；「无人可问、绝对路径、禁止异步续跑」这类环境约束由守则统一给出（见「无人值守守则」），不写在这里。运行时守则在前、`system` 在后，合成一份系统提示。

### prompt

必须出现的键，模板：

- 缺少 `prompt` 键 → 加载失败
- `prompt: ""`（或 `prompt:` 后留空）合法，表示提示词由调用方给入——会话页的输入框、预设或工作流步骤
- 运行时展开后为空 → 该次运行失败（「提示词为空（展开后无内容）」）

提示词完全由调用方给入的最小任务：

```yaml
id: claude-ask
title: 问 LLM
icon: hi:ai
description: 输入问题，LLM 流式回答；CLI 由 config.yaml AI_CLI 决定，默认 ducc
presets:
  - name: 打招呼
    values: { prompt: 用一句话介绍你自己 }
prompt: ""          # 提示词由调用方给入（会话页输入框 / 预设）
timeout: 5m
```

### timeout

Go duration（`30s` / `5m` / `1h`），必须带单位，默认 `30m`。非法或非正值直接加载失败，不回落到默认值。超时后进程被终止、运行失败，提示可用 `resume` 续接该会话重跑。

### cwd

Agent 进程的工作目录，模板。不写或展开后为空 = 应用目录（可执行文件同级）；展开后必须存在且是目录，否则运行失败（「工作目录不存在或不是目录」）。它同时是 project 级 skill 的同步目标根（`<cwd>/.claude/skills/`）。

### env

键值对，值为模板。注入 Agent 子进程的环境变量，在任务自身的三层里优先级最高（见「运行机制」）。作为工作流步骤运行时，被 workflow / step `env` 的同名键覆盖。

### skills

绑定的 skill id 列表，须存在于 `skills/`，否则任务加载失败。运行前把源目录整目录同步到 Agent 目录，由 CLI 自行发现——**不在 `prompt` / `system` 里拼接任何内容**。

- **源目录**在应用目录下的 `skills/`，位置即作用域：`skills/<id>/` = project 级 → 同步到 `<cwd>/.claude/skills/<id>/`；`skills/user/<id>/` = user 级 → 同步到 `~/.claude/skills/<id>/`。子目录含 `SKILL.md` 才算一个 skill；id 须匹配 `^[a-z0-9-]+$`，两级合并为单一命名空间，跨级同名加载时报冲突
- **目标目录按 CLI 路由**（`config.yaml` 的 `AI_CLI`）：`claude` / `ducc` → `.claude/skills`；`codex` → `.codex/skills` 与 `.agents/skills` 双根；其他 CLI 回退 `.claude/skills` 并输出警告
- **源为准**：逐文件比对内容，不一致覆盖，目标里多出的文件删除，一致跳过
- 同步报告以 `[skill-sync]` 行出现在输出开头（如 `[skill-sync] demo-skill(project) → /proj/.claude/skills/demo-skill`、`[skill-sync] demo-skill(project) 已是最新，跳过`）
- 同步写失败 = 运行失败（skill 是声明的依赖）；同步足迹记在应用目录的 `skills.synced.json`

## 保留运行参数

所有 AI 任务无需声明即接受三个运行参数：

| 参数 | 作用 | 在界面上 |
|------|------|----------|
| `prompt` | 替换定义里的 `prompt` 模板 | 会话页底部的输入框 |
| `system` | 替换定义里的 `system` 模板 | 会话页的「系统提示词」chip |
| `resume` | 会话 id。非空时以 `--resume <id>` 续接该会话，空则新开会话 | 会话页的「续接会话」chip |

- 不能在 `params` 里声明同名参数（加载失败）
- `prompt` / `system`：键出现即整体替换定义里的模板，传空串也算替换；替换进来的值同样是模板，照常展开
- `resume`：首尾空白忽略，非空才生效
- 三者都不是「输入」：不参与参数查找，也不进入子进程的环境变量
- 预设与工作流步骤同样可以给出这三个键

## 预留字段

下面十个字段只在 schema 中约定了名字，暂未实现。写进 YAML 即加载失败：`字段 %q 已预留、暂未实现，请从任务定义中删除`。

| 字段 | 用途（规划中） |
|------|----------------|
| `model` | 指定模型 |
| `effort` | 推理投入档位 |
| `permission` | 权限级别（M1 起固定 bypass） |
| `budget` | 单次运行时长或费用上限 |
| `add_dir` | 额外可访问目录 |
| `cli` | 指定本任务 CLI |
| `tools` | 允许或禁用的工具集 |
| `mcp` | 额外 MCP 服务器 |
| `session` | 定义级会话策略 |
| `outputs` | 基线之外的结构化产出 |

## 输入与模板

模板语法与动作相同：`${VAR}`，由 `runner.Expand` 在运行时展开，每个模板只展开一遍。

| 位置 | 是否模板 |
|------|----------|
| 定义里的 `prompt` / `system` / `cwd` / `env` 的值 / `params[].default` | 是 |
| 传入的 `prompt` / `system`（会话页输入框、预设、工作流步骤） | 是，照常展开 |
| 传入的已声明参数值 | 否，原样使用 |

所以提示词输入框里写的 `${VAR}` 会被展开（如 `${CURRENT_DATE}` 变成当天日期，没有转义写法）；而在某个参数的 chip 里填 `${HOME}`，进到提示词里的就是字面量 `${HOME}`。

查找顺序（先命中先用）：

1. **本次输入**（已声明参数的终值）
2. **全局配置**（`config.yaml` 中的键值对）
3. **内置变量**（`CURRENT_DATE` / `CURRENT_TIME` / `ADB_SERIAL`，见 [action.md](action.md) 的「内置变量」）
4. **环境变量**（应用进程自己的环境）

都没命中则保留 `${VAR}` 原样并记一条 warning。保留运行参数不在查找源里。

已声明参数的取值，优先级从高到低：

1. **本次传入**——键出现即算传入，空值也保留，不回落默认值
2. **定义里的 `default`**
3. **`config.yaml` 同名值**

- **默认值按声明顺序展开**：靠后的默认值引用靠前的参数时，拿到的是靠前的终值。

  ```yaml
  params:
    - id: ROOT
      default: ${HOME_DIR}/proj
    - id: OUT
      default: ${ROOT}/out      # → <HOME_DIR>/proj/out
  ```

  不要反向引用：靠前的默认值引用靠后的参数时，拿到的是对方未展开的模板原文。
- **必填检查在默认值展开之后**：`required` 参数的终值为空（或全是空白）→ 运行失败「缺少必填参数」
- **未声明的参数名直接报错**：传入 `params` 里没有的键 → 运行失败「未知参数」
- **提示词不能为空**：展开后为空 → 运行失败

以上都在进程启动前完成（`airun.Build`），失败时退出码为 -1，原因同时出现在输出区与会话页的失败提示里。手动运行与工作流 AI 步骤走的是同一份构造逻辑。

## 无人值守守则

AI 任务运行时没有人盯着，所以每次运行都带一份运行环境说明：应用目录下的 `ai-rules.md`。文件不存在或内容全是空白时用下面的内置默认；其他读取失败（如无权限）记一条 warning 后同样回落。每次运行前读取，改完即生效。

```markdown
# 无人值守守则

你运行在无人值守的 headless 进程里：没有人回答你的提问，也没有人替你确认操作。下面三条描述的是本次运行的环境，与你承担的角色无关。

1. 无人可问，自行决断。需要澄清或确认时不要提问、不要等待，按最可能的理解继续，并在结论中写明你做了哪些假设。
2. 进程退出即任务结束。你只有这一次调用：禁止使用定时唤醒、循环调度、后台子代理等异步续跑机制，它们会让任务被提前判定完成。所有工作必须在当前进程内同步串行完成。
3. 一律使用绝对路径。脚本与命令用绝对路径调用，不依赖当前工作目录，也不要用切换目录代替绝对路径。
```

- 守则只描述运行环境，与任务承担的角色无关；角色与纪律写在任务的 `system` 里，不要各抄一份
- 运行时守则在前、`system` 在后，合成一份系统提示，经单个 `--append-system-prompt` 传给 CLI
- 配套的固定 flag `--permission-mode bypassPermissions`：无人值守没有交互通道，所有 AI 运行一律 bypass，不新增审批机制（[ADR-0007](adr/0007-unattended-ai-runs.md)）。任务因此拥有与当前用户相同的权限，`cwd` 指向哪里要自己把关

## 运行机制

1. **构造**（`airun.Build`，进程启动前）：合并输入 → 展开 `prompt` / `system` / `cwd` / `env` → 校验 `cwd` → 读取守则 → 同步 skills。
2. **CLI**：`config.yaml` 的 `AI_CLI`（默认 `ducc`），每次运行时取当前配置（生效方式见文末）。本机须已安装对应 CLI 并在 `PATH` 中。
3. **argv**：固定 flag 在前，之后依次是 `--resume <会话 id>`（`resume` 非空时）和 `--append-system-prompt <守则 + system>`（非空时）。任务 YAML 里不写任何 CLI flag。

   ```
   <AI_CLI> -p --output-format=stream-json --verbose --thinking enabled --permission-mode bypassPermissions [--resume <id>] [--append-system-prompt <text>]
   ```

4. **不经 shell**：系统提示是独立 argv，提示词写入子进程 stdin——多行、引号、`$` 零转义风险。
5. **子进程环境变量**，同名时靠后的覆盖靠前的：继承的应用进程环境 < `config.yaml` 全部键 + 已声明参数 < 任务 `env`（作为工作流步骤时再叠 workflow `env` < step `env`）。保留运行参数不进入环境变量。
6. **超时**：任务自己的 `timeout`。超时终止进程，运行失败：「AI 运行超时（上限 …），进程已终止；可用 resume 续接该会话重跑」。
7. **退出码**：即 CLI 的退出码；构造阶段失败为 -1。

### 输出流

| stream | 内容 | 进入产出 |
|--------|------|----------|
| `ai` | 回复正文增量 | `text` |
| `ai-thinking` | 思考过程增量 | `thinking`（非空才有） |
| `ai-tool` | 工具调用对，JSON：`tool_use` 为 `{"id","name","input"}`，`tool_result` 为 `{"id","content","isError"}` | 否 |
| `stderr` | CLI 的诊断输出与 skill 同步警告，原样转发不解析 | 否 |
| `stdout` | 只有运行开头的 `[skill-sync]` 报告行 | 否 |

### 产出

| key | 含义 | 出现条件 |
|-----|------|----------|
| `text` | 回复正文全文 | 有回复时 |
| `thinking` | 思考过程全文 | 非空时 |
| `session_id` | 会话 id，可填回 `resume` 续接 | CLI 报出过会话 id 时（失败、超时也会保留） |
| `cost_usd` | 本次费用 | 收到 CLI 的 `result` 事件时 |
| `input_tokens` / `output_tokens` / `total_tokens` | token 用量 | 收到 CLI 的 `result` 事件时 |
| `exit_code` / `success` / `stdout` / `stderr` | 通用产出，同动作；`stdout` = `text`，`stderr` 恒为空串 | 总是（构造阶段失败时只有 `exit_code` 与 `success`） |

## 界面

**侧栏「AI 任务」分组**：紫色，仅在有任务或加载错误时出现，列出最常用的 3 个任务和「全部 AI 任务」入口；加载失败的文件以告警形式列在分组里。单击任务进入它的会话页——这一轮正在运行或刚跑完时回到这一轮，否则是空会话页。

**AI 任务网格**（「全部 AI 任务」）：卡片是双态卡，与动作卡同一套交互。

- 紧凑态：图标、标题、一行描述和「运行」（运行中显示「运行中 ▸」，点击回到会话页）
- 展开态：叙述区（最近一次会话的时间戳与提示词摘要，没有历史时是描述；运行中显示实时读数）+ 功能行（预设 chip、编辑配置、对话、运行）
- **运行**：按草稿当前的值在后台直接起跑，不切换视图。输入未就绪（提示词为空、必填参数未填、`list` / `arguments` 格式非法）时改为打开会话页；任务已在运行则不动；任务正被某个工作流的 AI 步骤占用时改为跳到那个工作流
- **预设 chip**：把预设的值并入草稿后打开会话页，不直接起跑——AI 任务的提示词多半还要改，这点与动作不同
- 任务运行中时单击卡身回到会话页

**会话页**：

- 底部输入框绑定保留运行参数 `prompt`。⌘/Ctrl+Enter 发送，Shift+Enter 换行；输入未就绪（提示词为空、必填参数未填、`list` / `arguments` 格式非法）时「发送」置灰
- 输入框上方是参数 chip：「续接会话」（`resume`）、「系统提示词」（`system`），以及每个已声明的参数一个。点开修改；「续接会话」有值时可用右侧的 × 清除回新会话
- 预设把值填进输入框与 chip，不直接运行
- 右上角「历史」是按任务保存的历史抽屉（本机 localStorage，每个任务最多 50 条）。查看一条历史时，它的会话 id 回填到「续接会话」（退出查看也不撤），下一次发送就接着那个会话
- 运行失败或有诊断输出时，回答下方显示诊断块（失败原因与 stderr）
- 单击标题进入该任务的 YAML 编辑器；运行中可「停止」

**草稿**：输入框与 chip 里的当前值叫草稿，只在内存里，重启应用后回到初始值。已声明参数的初值取定义里的 `default`，没有则取 `config.yaml` 同名值；`prompt` / `system` 的初值是定义里的模板原文。预设与本次修改叠加在初值上面，改回初值即视为未修改。发送时 `prompt` 与 `system` 总是发送，`resume` 仅非空时发送，已声明参数只有改过的才发送——没改的交给后端取定义默认值并展开其中的模板。

使用留痕与动作同一套，独立记在 `ai-usage`。新增任务只能新建 YAML 文件（生效方式见文末）；界面上可以编辑已有任务的 YAML，暂无「存为预设」入口，预设直接写在 YAML 里。

## 工作流 AI 步骤

工作流用 `ai:` 调用一个 AI 任务，这是把多个 AI 任务彼此组合的途径：

```yaml
id: analyze-and-summarize
title: 分析并汇总 bug 卡片
params:
  - id: BUG_URL
    label: 卡片链接
    type: text
    required: true
steps:
  - id: analyze
    name: 分析卡片
    ai: claude-bug-analyze
    params:
      BUG_URL: ${{ params.BUG_URL }}

  - id: summarize
    name: 压缩成三行结论
    if: steps.analyze.outputs.success == 'true'
    ai: claude-ask
    params:
      prompt: |
        把下面的报告压缩成三行结论：
        ${{ steps.analyze.outputs.text }}
```

- `ai` 与 `action` / `run` / `sleep` **四选一互斥**，值是 `ai/` 里的任务 id
- `params`（可选）是这一次运行的输入：键必须是任务已声明的参数或保留运行参数，值只做 `${{ }}` 替换。引用工作流参数或上游产出一律写 `${{ ... }}`——`${VAR}` 在这里不展开，会原样成为输入值
- 工作流级 `params` 不会自动传给 AI 步骤，需要什么就在步骤 `params` 里显式写出
- `if` / `retry` / `continue_on_error` 同样适用；超时用任务自己的 `timeout`（step 的 `timeout` 只对 `run` 步骤有效）
- workflow 与 step 的 `env` 进入 Agent 子进程，覆盖任务 `env` 的同名键
- 引用了不存在的任务 id：加载时不报错，执行到该步骤时失败

产出见上表，写在 `steps.<id>.outputs` 下，供后续步骤用 `${{ steps.<id>.outputs.<key> }}` 或 `if` 引用；构造阶段失败的退出码是 `-1`。回复正文逐行显示在工作流视图该步骤的输出区——AI 步骤不发 `ai:<id>:*` 事件，输出带步骤归属走 `workflow:<wf-id>:output`。

含 AI 步骤的工作流不能在 CLI 里运行（见下文）。

## 目标锁与冲突

同一任务同一时刻只允许一个运行，不论来自手动运行还是工作流步骤（[ADR-0006](adr/0006-process-and-mutex-model.md)）。撞上不等待：

| 场景 | 结果 |
|------|------|
| 任务已在运行，界面上再点运行 | 拒绝：「AI 任务 "…" 正在运行」 |
| 工作流的 AI 步骤撞上正在运行的任务 | 步骤立即失败：「AI 任务 "…" 正在运行，步骤不等待」，工作流随之中断，除非该步骤设了 `continue_on_error` |
| 工作流被取消，或对该任务点「停止」 | 该 AI 步骤的进程被终止 |

## CLI

CLI（`workflow-tool list` / `describe` / `run`）能看不能跑：

- `list`：AI 任务以 `kind: "ai"` 列出
- `describe <id> --kind ai`：输出 `id`、`kind`、`params`、`presets`（为空时省略）、`prompt`（总是输出）、`system`（为空时省略）和 `reservedRunParams`
- `run <id>`：拒绝运行 AI 任务，结果 `ai_blocked`，退出码 2——「AI 任务 "…" 不能在 CLI 里运行（用 GUI 跑）」
- `run <workflow>`：工作流含 AI 步骤时同样 `ai_blocked`——「workflow 含 AI 步骤（任务 "…"），CLI 不支持运行（用 GUI 跑）」

id 与动作、工作流重名时加 `--kind ai`。完整用法见 [internal/cli/SKILL.md](../internal/cli/SKILL.md)。

## 事件

手动运行（会话页、网格卡片）发出的事件，形状与排序协议和动作的 `action:<id>:*` 完全相同：

| 事件 | payload |
|------|---------|
| `ai:<id>:output` | `{stream, line, seq}` |
| `ai:<id>:done` | `{exitCode, err, duration, seq, readout?}` |

- `stream` 取值见「输出流」
- `readout` 是终点读数，有才带：`{durationMs, sessionId?, costUsd?, inputTokens?, outputTokens?}`
- `seq` 每次运行从 1 递增且唯一；Wails 事件到达顺序无保证，前端按递增 `seq` 还原输出顺序。`done` 独占一个 `seq`，在 output 号段里是一个永久的洞，消费侧要跨过它
- 工作流 AI 步骤不发 `ai:<id>:*`，输出走 `workflow:<wf-id>:output`（带 `step` 归属）

契约定义在 `internal/api/events.go`。

## 校验规则

加载时由 `ai.Parse` → `ai.Validate` 校验（严格解析），不合法的文件被跳过并记录错误，错误显示在侧栏 AI 任务分组与网格的告警里：

- 根节点必须是 mapping；内容为空报错
- 顶层键只允许上面 13 个字段：未知键报「未知字段」（提示里列出全部合法键），预留字段报「已预留、暂未实现」。`params` / `presets` 条目内的未知键同样报错
- `id` 必须匹配 `^[a-z0-9-]+$`，`ai/` 内不可重复
- `title` 必填
- `color` 只允许 `amber` / `green` / `blue` / `violet`
- `prompt` 键必须出现
- `timeout` 必须是大于 0 的 Go duration
- `params[].id` 必填、唯一，不能是 `prompt` / `system` / `resume`
- `params[].type` 只允许 `text` / `bool` / `select` / `path` / `file` / `textarea` / `list` / `arguments`；`select` 必须提供 `options`；`list` / `arguments` 的 `default` 须是 JSON 字符串
- `presets[].values` 的键必须是已声明的参数或保留运行参数；`list` / `arguments` 的预设值须是 JSON 字符串
- `skills` 里的 id 必须匹配 `^[a-z0-9-]+$` 且存在于 `skills/`
- `ai/` 目录不存在时视为没有任务，不算错误

## 从 command.llm 迁移

AI 任务曾是动作的第四种执行形态 `command.llm`，现已整体独立到 `ai/`，`command.llm` 不再被识别：

| 旧（`actions/*.yaml` 的 `command.llm`） | 新（`ai/*.yaml`） |
|---|---|
| `command.llm.system: ROLE`，模板放在 `params[ROLE].default` 里 | 模板直接写在顶层 `system` |
| `command.llm.prompt: TASK`，模板放在 `params[TASK].default` 里 | 模板直接写在顶层 `prompt`；提示词由调用方给入时写 `prompt: ""` |
| 续接会话靠自定义参数与手写 flag | 保留运行参数 `resume`，运行时转成 `--resume` |
| `command.cwd` / `command.timeout` / `command.env` / `command.llm.skills` | 顶层 `cwd` / `timeout` / `env` / `skills` |
| `timeout` 默认 `60s` | 默认 `30m` |
| `config.yaml` 的 `LLM_CLI` | `AI_CLI` |
| 视图 `llm-grid` / `llm-chat` | `ai-grid` / `ai-chat`（另有 `ai-edit`） |
| 输出流 `llm` / `llm-thinking` / `llm-tool` | `ai` / `ai-thinking` / `ai-tool` |
| 本地存储 `llm-usage` / `llm-history:<id>` | `ai-usage` / `ai-history:<id>`（旧数据不迁移） |
| CLI 结果 `llm_blocked` | `ai_blocked` |

- 旧 `system` 里与守则重复的环境约束（无人可问、绝对路径、禁止异步续跑）可以删掉，守则统一提供
- `prompt` 不再要求是已声明的参数：没有动态输入的任务可以不写 `params`
- 留在 `actions/` 里的 `command.llm` 文件加载时报通用的「command 必须指定 run/script/adb 之一」——按上表搬到 `ai/`

## 生效方式

- 新增任务：在 `ai/` 新建 YAML 后**重启 exe** 生效（启动时扫描 `ai/*.yaml`）；之后在编辑器里保存任意动作或 AI 任务的 YAML 也会触发重扫
- 修改任务：用内置 YAML 编辑器保存即重载（校验失败不写盘，`id` 不可改）；直接改文件则等重扫或重启生效
- `config.yaml`（含 `AI_CLI`）：在侧栏「配置」分组的「全局配置」页里保存即生效；直接改文件需重启
- `ai-rules.md` 每次运行前读取，改完即生效

## 相关文档

- [Action 动作定义指南](action.md) — `params` / `presets` 的完整规则、`${VAR}` 与内置变量
- [Workflow 工作流定义指南](workflow.md) — AI 步骤所在的编排层
- [ADR-0004 AI 任务脱离动作体系](adr/0004-ai-task-independent.md)
- [ADR-0007 无人值守的 AI 运行](adr/0007-unattended-ai-runs.md)
