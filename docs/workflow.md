# Workflow 工作流定义指南

工作流（Workflow）把多个步骤串成一条流水线，按顺序执行。在 `workflows/` 目录下放一个 `.yaml` 文件即可新增一个工作流。

## 完整字段参考

```yaml
id: my-workflow                # 必填，^[a-z0-9-]+$ 全局唯一
title: 我的工作流               # 必填
icon: hi:workflow              # 可选，hugeicons key 或 emoji
color: violet                  # 可选，卡片氛围色：amber | green | blue | violet（不写按组序循环）
description: 简要说明           # 可选

env:                           # 可选，workflow 级默认环境变量，注入所有 step
  KEY: value

params:                        # 可选，工作流级参数（注入所有 step）
  - id: WF_MSG
    label: 消息
    type: text                 # text | bool | select | path | file | textarea | list | arguments
    required: true
    default: hello
    options: []                # select 必填

steps:                         # 必填，至少一步
  - id: install                # 可选，步骤标识（供 outputs/if 引用），未写用索引兜底
    name: 安装 APK              # 可选，Pipeline Spine 显示文案，未写用 label 兜底
    if: steps.prev.outputs.success == 'true'  # 可选，expr 表达式，false → SKIPPED
    action: adb-install        # 形态 A：引用已有 action
    params: { KEY: value }     # 可选，覆盖该 action 的参数
    env:                       # 可选，step 级 env，覆盖 workflow.env 同名 key
      KEY: override
    capture_output: true       # 可选，默认 true；false 关闭全量 stdout/stderr 捕获

  - sleep: 5                   # 形态 B：等待 N 秒

  - run: echo "done"           # 形态 C：内联命令（写入临时脚本执行，默认 bash）
    shell: bash                # 可选修饰：解释器（bash/sh/pwsh/powershell/python/node/cmd 或自定义模板），只搭配 run
    timeout: 30s               # 仅 run step 有效

  - ai: ai-bug-analyze         # 形态 D：调用 ai/ 下的 AI 任务
    params: { BUG_URL: "${{ params.BUG_URL }}" }   # 可选，本次运行的输入（只做 ${{ }} 替换）

  - run: flaky-command         # 可选修饰符（任意形态可用）
    retry: 2                   # 失败重试次数
    continue_on_error: true    # 失败不中断后续步骤
```

## 四种 Step 形态

每个 step 必须且只能指定 `action`、`sleep`、`run`、`ai` 四者之一。

### action：引用已有动作

复用 `actions/` 里已定义的动作，避免重复配置：

```yaml
steps:
  - action: adb-install
  - action: adb-debug-activity
    params:                    # 覆盖该 action 的参数值
      ACTIVITY: com.baidu.che.codriver.ui.MainActivity
      ARGS: '[]'
```

action 的命令、脚本路径、`cwd` 里 `${VAR}` 的解析顺序（同名时靠前的胜出）：step 的 `env` > workflow 的 `env` > 该动作的 `command.env` > step 的 `params` > 工作流的 `params` > 全局配置 > 内置变量（`CURRENT_DATE` / `CURRENT_TIME` / `ADB_SERIAL`）> 环境变量。adb 形态的 action 没有 env 这三层；完整说明见 [action.md 的「workflow 中的变量优先级扩展」](action.md#workflow-中的变量优先级扩展)。

**引用上游 step 输出**：action step 的 `params` 值支持 `${{ }}` 表达式展开，可直接消费前置 step 的 outputs。例如先用 run 找到 APK 路径，再传给 install：

```yaml
steps:
  - id: find-apk
    name: 查找 APK
    run: |
      APK=$(find "${VOICE_DEBUG_OUTPUT}" -maxdepth 1 -name "*.apk" | head -1)
      [ -n "$APK" ] || { echo "未找到 apk" >&2; exit 1; }
      echo "##[output apk_path=$APK]"

  - id: install
    name: 安装
    action: adb-install
    params:
      APK_PATH: "${{ steps.find-apk.outputs.apk_path }}"
      ALLOW_TEST: "true"
      ALLOW_DOWNGRADE: "true"
```

`${{ }}` 在该处对 `params` 的每个 value 做求值并替换；求值失败会中断该 step（emit stderr 并返回非 0）。剩余 `${VAR}` 由下游 runner 按上面的解析顺序展开。

### sleep：等待

单位为秒，用于等待前一步的副作用生效（如安装完成、服务启动）：

```yaml
steps:
  - action: adb-install
  - sleep: 5                   # 等 5 秒让安装落地
  - action: adb-debug-activity
```

### run：内联命令

无需单独建 action 的一次性命令，写入临时脚本后由解释器执行（默认 bash，Windows 上自动探测 Git Bash，见 [action.md Windows bash 探测级联](action.md)）。可用 `shell` 修饰字段换解释器：

```yaml
steps:
  - run: echo "开始处理 ${WF_MSG}"
    timeout: 30s               # 可选，默认 60s
  - run: Write-Output "pwsh here"
    shell: pwsh                # 指定解释器，可选值同 action 的 command.shell
```

### ai：调用 AI 任务

运行 `ai/` 下的一个 AI 任务（定义方式见 [ai.md](ai.md)），是把多个 AI 任务彼此组合的途径：

```yaml
steps:
  - id: analyze
    name: 分析卡片
    ai: ai-bug-analyze
    params:
      BUG_URL: ${{ params.BUG_URL }}

  - id: summarize
    name: 压缩成三行结论
    if: steps.analyze.outputs.success == 'true'
    ai: demo-ask
    params:
      prompt: |
        把下面的报告压缩成三行结论：
        ${{ steps.analyze.outputs.text }}
```

- `params`（可选）是这一次运行的输入：键必须是该任务已声明的参数或保留运行参数 `prompt` / `system` / `resume`，否则该步骤失败（「未知参数」）
- 与 action step 不同，`params` 的值只做 `${{ }}` 替换，不做 `${VAR}` 预展开：已声明参数的值原样交给任务（里面写 `${VAR}` 就是字面量）；`prompt` / `system` 的值是模板，运行时按 AI 任务自己的查找顺序展开。引用工作流参数或上游产出一律写 `${{ ... }}`
- 工作流级 `params` 不会自动传给 AI 步骤，需要什么就在步骤 `params` 里显式写出；工作流的 `env` 与 step 的 `env` 会进入 Agent 子进程，覆盖任务 `env` 的同名键
- `if` / `retry` / `continue_on_error` 同样适用；step 的 `timeout` 与 `capture_output` 对它不生效，超时用任务自己的 `timeout`
- `ai` 的值是任务 id，加载时只校验格式；任务不存在时，执行到该步骤才失败（「未知 AI 任务」）
- 同一任务同一时刻只能有一个运行：撞上正在运行的任务时该步骤立即失败，不等待（目标锁跨进程成立，动作步骤同样如此）。这一步的输出落在所属工作流那一次运行的日志里，不单独留运行记录

产出见「step outputs」的「AI 步骤」。回复正文逐行显示在该步骤的输出区；含 AI 步骤的工作流只能在界面上运行，CLI 拒绝（`ai_blocked`）。

## 错误处理

### retry（重试）

step 失败（退出码非 0）时自动重试。每次重试前 emit `retry N/M` 到输出：

```yaml
steps:
  - run: curl -f https://flaky-api.example.com
    retry: 3                   # 首次失败后最多再试 3 次
```

任意一次成功即继续下一步；全部失败则按 `continue_on_error` 决定是否中断。

### continue_on_error（失败继续）

默认行为：任一 step 失败即中断整条工作流。设为 `true` 则跳过失败继续：

```yaml
steps:
  - run: optional-cleanup
    continue_on_error: true    # 清理失败不影响主流程
  - action: main-task
```

失败时 emit `continue_on_error: 跳过失败继续` 到 stderr。

## step outputs（步骤间数据传递）

每个 step 执行完毕后自动生成 outputs，供后续 step 的 `if` 表达式与 `${{ }}` 引用：

### Layer 1（通用，capture_output=true 时自动填充）

- `steps.<id>.outputs.exit_code`
- `steps.<id>.outputs.stdout`
- `steps.<id>.outputs.stderr`
- `steps.<id>.outputs.success`

### Layer 2（协议，脚本主动写）

stdout 中 `##[output key=value]` 行会被解析为 `steps.<id>.outputs.key`。

另有 `##[progress 文本]` 协议行：不产出 outputs，而是让该文本在 Pipeline Spine 的 step 输出里原地覆盖上一条进度行（长任务的单行滚动读数）。`##[tree <json>]` 使用 [action.md 的树帧协议](action.md#树帧tree)：引用的 action 声明 `hmi.tree` 时渲染为树，叶子可按该 action 的 `click` 声明启动独立 action 输出页；未声明以及内联 `run` step 的 tree 流按普通文本显示。帧级 `defaultExpandAll: true` 表示初始展开全部节点，缺省仍为两层。这些协议行均不进入 stdout 捕获。

### AI 步骤（ai）

- `outputs.text`（回复正文）/ `outputs.thinking`（思考过程，非空才有）
- `outputs.session_id` / `outputs.cost_usd` / `outputs.input_tokens` / `outputs.output_tokens` / `outputs.total_tokens`：CLI 报出时才有
- 通用的 `exit_code` / `success` / `stdout` / `stderr` 照常生成（`stdout` 即 `text`，`stderr` 恒为空串）；构造阶段失败时只有 `exit_code` 与 `success`，退出码为 `-1`

**未写 `id` 的 step 引用注意**：未写 `id` 的 step 用索引兜底（键为 `"0"`/`"1"`…），此时**必须**用 bracket 语法引用：`steps["0"].outputs.exit_code`（expr 的点语法不接受数字开头的键，`steps.0.outputs.exit_code` 无法解析）。推荐给需要被引用的 step 都显式写 `id`，用 `steps.<id>.outputs.<key>` 点语法引用即可。

### 安全提示：${{ }} 直接拼接进 run 命令

`${{ expr }}` 的求值结果会被**未经转义**地字符串拼接进 `run` 命令，写入临时脚本后交给 bash（默认）执行。这与 GitHub Actions 的取向一致——是设计取向，不是 bug，但**使用者必须留意**：

- 值来自 `##[output key=value]` 协议（脚本内部可控）时风险有限
- 值来自 **AI 步骤的 `outputs.text`** 时**完全是外来数据**：一次提示词注入即可任意执行本地命令
- 值中包含 `;`、`` ` ``、`$( )`、`&&`、换行等 shell 元字符时，会被解释器解释而非当成字面量

举例：若某 step output 值为 `x; rm -rf /tmp/pwned`，则
```yaml
- run: echo ${{ steps.a.outputs.v }}
```
会被展开为 `echo x; rm -rf /tmp/pwned` 并执行。

**展开位置**：`${{ }}` 在三处被展开——`run` 命令字符串、action step 与 ai step 的 `params` 值、step 的 `env` 值。其中只有 `run` 命令字符串存在命令注入风险（求值结果被直接写进脚本）；`params`/`env` 的值只会成为参数或环境变量本身，风险较低——但若该值随后又被 `${VAR}` 拼进某条 run 命令，注入风险会随之转移。

针对 `run` 命令字符串的规避：把占位符包进引号，让展开后的值落进「字面量」区间而非命令解析区间：

```yaml
# bash：单引号内所有元字符（; ` $() 换行 等）都按字面量处理
- id: consume
  run: echo '${{ steps.analyze.outputs.text }}'
```

```yaml
# pwsh（PowerShell）：单引号字符串不做插值/子表达式展开
- id: consume
  shell: pwsh
  run: Write-Output '${{ steps.analyze.outputs.text }}'
```

**残余风险**：单引号只能挡住除单引号以外的元字符——若值本身含 `'`（bash）就仍可能越界。所以当值来源**完全不可控**（尤其是 AI 步骤的 `outputs.text`）时，最稳妥的是**根本不要把它拼进 run 命令**，改用一个专门的 `action` 脚本，由脚本自行按 `argv` 或从文件读取处理。**不要用 `${{ }}` 直接拼未经引号包裹的命令行。**

## 条件执行（if）

`if` 字段为 expr 表达式（[expr-lang/expr](https://github.com/expr-lang/expr)），支持 `==`/`!=`/`&&`/`||`/`!` 及引擎原生的所有运算符。变量通过点路径引用：

- `steps.<id>.outputs.<key>`（未写 `id` 的 step 需用 `steps["0"].outputs.<key>` bracket 语法，见上节）
- `env.<KEY>`
- `params.<ID>`
- `config.<KEY>`

`if` 求值为 false → 该 step 状态为 SKIPPED，不执行，不计入 retry/continue_on_error。

`if` 表达式若引用了不存在的 step id，或引用了排在当前 step **后面**才声明的 step id（前向引用），会在 workflow 加载时报错（而非等到运行时才失败）。只能引用当前 step 之前已声明并即将/已经执行过的 step id。

**保留字**：`params[].id` 不能是 `steps` / `env` / `params` / `config`。

## workflow.env

workflow 级 `env` 注入所有 step。它不只是子进程环境变量：内联 `run` 与 run / script 形态的 action 里，命令中的 `${KEY}` 也会被它解析到，同名时排在 params 与 config.yaml 之前（完整顺序见 [action.md](action.md#workflow-中的变量优先级扩展)）。step 级 `env` 可覆盖同名。adb 形态的 action 与 `ai` 步骤不参与这条查找。

变量引用：`env.KEY`（expr 中）/ `${KEY}`（shell 中，由 runner.Expand 查优先级链）。

`env` 的 value 同样支持 `${{ }}` 展开（如 `TOKEN: "${{ steps.find.outputs.token }}"`），可引用前置 step 的 outputs；求值失败会中断该 step。

## 工作流参数

工作流可自带 `params`，字段格式与 action 的 `params` 一致（`text` / `bool` / `select` / `path` / `file` / `textarea` / `list` / `arguments`，均支持可选 `description` 说明文案）。`list` 与 `arguments` 的默认值及 step `params` 覆盖值使用 JSON 字符串：`TAG: '["DVR_A","DVR_B"]'`、`ARGS: '[{"flag":"--es","values":["exec_button","展示语音链路悬框"]}]'`；可重复 flag 并保留行顺序。

**关键区别**：工作流参数不从引用的 action 聚合，需自行声明；运行时作为全局变量注入**所有** step，包括 action step 和 inline run step。AI 步骤例外：不会自动拿到它们，要在步骤 `params` 里用 `${{ params.<ID> }}` 显式传入。

```yaml
params:
  - id: WF_MODE
    label: 模式
    type: select
    default: fast
    options: [fast, slow]
steps:
  - run: echo "mode=${WF_MODE}"        # inline run 可用
  - action: some-action                # action step 也可用
```

## UI 呈现

工作流运行时右侧展示 **Pipeline Spine**（垂直管线视图）：

- 每个 step 一个节点，左侧竖线连接
- 节点状态：`PENDING`（待执行）/ `RUNNING`（执行中，带流光）/ `DONE`（成功）/ `ERROR`（失败）/ `SKIPPED`（条件跳过，灰色虚线）
- step 输出可折叠展开，stdout / stderr 分层着色
- AI 步骤的卡片内容是工序段面板（思考 / 工具调用 / 回答），与会话页同一套渲染；诊断输出另起一块
- 顶部显示整体运行状态与 Stop 按钮

后端在 step 边界 emit `step-start` / `step-done` 事件驱动前端状态更新；每条输出事件带 `step` 归属与递增的 `seq`——实时视图按 `step` 落桶，运行日志的回放与运行中的详情跟踪按 `seq` 排序、去重。卡片默认展开的时机：执行中、出错，或 AI 步骤（工序段就是它的输出）；顺利完成的普通步骤默认折叠，点开才看输出。用户点过的卡片以其选择为准。

工作流每次运行都留一条运行记录与运行日志（各步骤的输出带步骤归属），事后在「运行详情」里按同样的 spine 回放，见 [runs.md](runs.md)。工作流也可以被调度定时运行（`schedules.yaml` 的 `workflow:`）。

## 实际示例

### 全功能演示

与仓库里的 `workflows/demo-all-features.yaml` 内容一致，演示四种常用参数类型、`action`/`sleep`/`run` 三形态、`env`、`${{ }}` 在 shell / params / env 三处展开、`if` 条件与 `outputs` 引用、`SKIPPED`、`retry`、`continue_on_error`：

```yaml
id: demo-all-features
title: "演示: 全功能工作流"
icon: hi:workflow
description: "覆盖 workflow 全部能力：params 四类型、action/sleep/shell 三形态、env、${{ }} 在 shell/params/env 三处展开、if 条件、outputs 引用、SKIPPED、retry、continue_on_error"

env:
  GREETING: hello

params:
  - id: WF_MSG
    label: 消息
    type: text
    default: hello
    required: true
  - id: WF_MODE
    label: 模式
    type: select
    default: fast
    options:
      - fast
      - slow
  - id: WF_VERBOSE
    label: 详细日志
    type: bool
    default: "true"
  - id: WF_OUTDIR
    label: 输出目录
    type: path
    default: ""

steps:
  # 1. shell 形态：回显参数 —— 验证 params 四类型注入 + 普通 stdout
  - id: echo-params
    name: 回显参数
    run: echo "msg=${WF_MSG} mode=${WF_MODE} verbose=${WF_VERBOSE} out=${WF_OUTDIR}"

  # 2. sleep 形态：等待 —— 验证等待态展示
  - id: wait
    name: 等待 2s
    sleep: 2

  # 3. action 形态：引用已有动作 —— 验证 step.params 覆盖 action 参数
  - id: call-action
    name: 调用动作
    action: demo-echo
    params: { MSG: "来自 workflow 的问候" }

  # 4. shell 形态：写 outputs 协议行 —— 验证 ##[output] 自定义 key（供后续三步以 ${{ }} 引用）
  - id: produce
    name: 生产数据
    run: |
      echo "开始执行..."
      echo "##[output build_id=42]"
      echo "##[output artifact=demo-app.apk]"
      echo "完成"

  # 5. action 形态 + ${{ }} 展开 params —— step.params 的 value 经 ${{ }} 求值后传给 action
  - id: consume-params
    name: "${{ }} 注入 action params"
    action: demo-echo
    params:
      MSG: "build_id=${{ steps.produce.outputs.build_id }}"

  # 6. shell 形态 + ${{ }} 展开 env —— step.env 的 value 经 ${{ }} 求值，再以 ${VAR} 注入命令
  - id: consume-env
    name: "${{ }} 注入 env"
    env:
      ARTIFACT: "${{ steps.produce.outputs.artifact }}"
    run: echo "env 注入 artifact=${ARTIFACT}"

  # 7. shell 形态 + ${{ }} 拼进命令串 —— 验证 outputs 引用 + ${{ }} 拼接 shell + env 引用
  - id: consume
    name: 消费数据（条件满足）
    if: steps.produce.outputs.exit_code == '0'
    run: echo "build_id=${{ steps.produce.outputs.build_id }}, greeting=${GREETING}"

  # 8. if 条件为假 —— 验证 SKIPPED 状态
  - id: skip-this
    name: 条件跳过演示
    if: steps.produce.outputs.exit_code == '99'
    run: echo "这行不会被执行"

  # 9. retry 演示：命令必然失败，验证重试痕迹（retry 1/2、retry 2/2）+ continue_on_error 不中断后续
  - id: retry-demo
    name: 重试演示（必然失败）
    run: exit 1
    retry: 2
    continue_on_error: true

  # 10. 故意失败（stderr + 非零退出，且不 continue_on_error）—— 验证 error 态 + stderr 分层，作为整条 workflow 的终止点
  - id: fail-demo
    name: 演示失败
    run: |
      echo "演示失败：这是一条 stderr 输出" >&2
      exit 1
```

对应的演示 action（`actions/demo-echo.yaml`，纯 echo 无外部依赖）：

```yaml
id: demo-echo
title: 演示回显
icon: hi:test
description: "纯 echo，无外部依赖；用于 workflow action step 引用形态的演示"
params:
  - id: MSG
    label: 消息
    type: text
    required: true
    default: hello
presets:
  - name: 默认问候
    values: { MSG: "hello from action" }
command:
  run: echo "action 回显 ${MSG}"
```

### 真实业务链路

```yaml
id: xdzs-install-broadcast
title: 安装后拉起测试页面
icon: hi:package
description: "安装 APK → 等待 5s → 拉起 DebugActivity"
env:
  ARGS: '[{"flag":"--es","values":["exec_button","展示语音链路悬框"]}]'
steps:
  - id: install
    name: 安装 APK
    action: adb-install
  - id: wait
    name: 等待安装落地
    sleep: 5
  - id: launch
    name: 拉起 DebugActivity
    action: adb-debug-activity
```

```yaml
id: xdzs-debug-chain
title: 调试一键链
icon: hi:flash
description: "设备初始化 → 编译 Debug → 安装 APK → 拉起测试页面"
env:
  ARGS: '[{"flag":"--es","values":["exec_button","展示语音链路悬框"]}]'
steps:
  - id: device-init
    name: 设备初始化
    action: xdzs-device-init
  - id: build
    name: 编译 Debug
    action: xdzs-build-app
    params: { VARIANT: Debug }
  - id: install
    name: 安装 APK
    action: adb-install
  - id: launch
    name: 拉起测试页面
    action: adb-debug-activity
```

## 作为调度目标

工作流可以被 `schedules.yaml` 定时运行（目标键 `workflow`）。调度的 `params` 是这次运行的输入，保存与加载时按目标校验：

- 值必须是标量或 JSON 字符串（不支持动作的 `$literal`）
- 已声明参数的取值按声明类型校验：`select` 须在 `options` 内，`bool` 须是布尔或 `true` / `false`，`list` / `arguments` 须是合法的 JSON 字符串
- 未声明的键是允许的（额外变量源）；没给的必填参数不在保存时报错，值可以来自 `config.yaml` 的同名键

到点时目标正在运行则跳过（不排队、不算失败）。工作流里的 AI 步骤在该次运行中照常执行（调度运行没有交互通道，AI 运行固定 bypass 权限）。每次运行都留运行记录，各步骤的输出带步骤归属落在同一条运行日志里，见 [运行记录与应用日志](runs.md)。

调度到点与「立即运行」不跑在应用进程里，而是交给独立执行器：应用退出后它照常跑完，重启后应用按心跳认领它，运行详情里也能停它。

调度另有可选的 `catch_up`（默认 `false`）：应用没在运行时溜走的到点留一条 `missed` 记录；开了补跑，应用恢复后为最近一个错过的时刻补跑一次。

## 校验规则

加载时由 `workflow.Validate` 校验，不合法的文件会被跳过并记录错误：

- `id` 必须匹配 `^[a-z0-9-]+$`
- `title` 必填
- `color` 若填写只能是 `amber` / `green` / `blue` / `violet`
- `steps` 不能为空
- 每个 step 必须指定 `action` / `sleep` / `run` / `ai` 之一（四者互斥）
- step 的 `shell` 修饰字段只能搭配 `run` 形态；值必须是内置名（`bash`/`sh`/`pwsh`/`powershell`/`python`/`node`/`cmd`）或含 `{0}` 的自定义模板
- `ai` 的值必须匹配 `^[a-z0-9-]+$`；对应的 AI 任务是否存在不在加载时校验，执行到该步骤时才失败
- step 的 `id` 若填写必须匹配 `^[a-z0-9-]+$` 且同一 workflow 内唯一
- `params[].id` 必填，且不能是保留字 `steps` / `env` / `params` / `config`
- `params[].type` 只允许 `text` / `bool` / `select` / `path` / `file` / `textarea` / `list` / `arguments`
- `select` 类型必须提供 `options`
- `list` / `arguments` 类型参数的 `default` 必须是合法的 JSON 字符串数组（`list` 的元素为字符串；`arguments` 每行含 `flag` 字符串与 `values` 字符串数组）
- `if` 引用的 step id 必须已在本 step 之前声明：引用不存在的 id 或前向引用都报错
- 同一目录下 id 不可重复

## 与 Action 的关系

| 维度 | Action | Workflow |
|------|--------|----------|
| 目录 | `actions/` | `workflows/` |
| 执行 | 单个命令/脚本 | 多个 step 串行 |
| 参数 | `params` 驱动表单 | `params` 注入所有 step |
| 预设 | 支持 `presets` | 不支持 |
| AI 调用 | 不属于动作（AI 任务单独定义在 `ai/`） | 以 `ai` 步骤引用 AI 任务 |
| 复用 | 可被 workflow 引用 | 不可嵌套 workflow |

设计取向：**动作是原子，工作流是编排**。原子能力（超时、脚本形态）放在 action，AI 调用放在 `ai/` 的 AI 任务，顺序与容错逻辑放在 workflow。

## 生效方式

新增 YAML 文件，或在外部编辑器里改完后，需要**重启 exe** 生效（启动时扫描 `workflows/*.yaml`）。在内置 YAML 编辑器里保存已有的工作流会立即重载，不用重启。

## 相关文档

- [Action 动作定义指南](action.md) — step 引用的 action 如何定义
- [AI 任务定义指南](ai.md) — `ai` 步骤引用的 AI 任务如何定义
- [运行记录与应用日志](runs.md) — 工作流运行留下的记录与日志、在运行详情里回放
