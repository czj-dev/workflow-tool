# Workflow 工作流定义指南

工作流（Workflow）把多个步骤串成一条流水线，按顺序执行。在 `workflows/` 目录下放一个 `.yaml` 文件即可新增一个工作流。

## 完整字段参考

```yaml
id: my-workflow                # 必填，^[a-z0-9-]+$ 全局唯一
title: 我的工作流               # 必填
icon: hi:workflow              # 可选，hugeicons key 或 emoji
description: 简要说明           # 可选

env:                           # 可选，workflow 级默认环境变量，注入所有 step
  KEY: value

params:                        # 可选，工作流级参数（注入所有 step）
  - id: WF_MSG
    label: 消息
    type: text                 # text | bool | select | path
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

  - shell: echo "done"         # 形态 C：内联 shell 命令
    timeout: 30s               # 仅 shell step 有效

  - shell: flaky-command       # 可选修饰符（任意形态可用）
    retry: 2                   # 失败重试次数
    continue_on_error: true    # 失败不中断后续步骤
```

## 三种 Step 形态

每个 step 必须且只能指定 `action`、`sleep`、`shell` 三者之一。

### action：引用已有动作

复用 `actions/` 里已定义的动作，避免重复配置：

```yaml
steps:
  - action: adb-install
  - action: adb-debug-activity
    params:                    # 覆盖该 action 的参数值
      PAGE: main
```

参数解析顺序：step 的 `params` > 工作流的 `params` > 全局配置 > 环境变量。

**引用上游 step 输出**：action step 的 `params` 值支持 `${{ }}` 表达式展开，可直接消费前置 step 的 outputs。例如先用 shell 找到 APK 路径，再传给 install：

```yaml
steps:
  - id: find-apk
    name: 查找 APK
    shell: |
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

`${{ }}` 在该处对 `params` 的每个 value 做求值并替换；求值失败会中断该 step（emit stderr 并返回非 0）。剩余 `${VAR}` 仍按参数解析优先级链由下游 runner 展开。

### sleep：等待

单位为秒，用于等待前一步的副作用生效（如安装完成、服务启动）：

```yaml
steps:
  - action: adb-install
  - sleep: 5                   # 等 5 秒让安装落地
  - action: adb-debug-activity
```

### shell：内联命令

无需单独建 action 的一次性命令：

```yaml
steps:
  - shell: echo "开始处理 ${WF_MSG}"
    timeout: 30s               # 可选，默认 60s
```

## 错误处理

### retry（重试）

step 失败（退出码非 0）时自动重试。每次重试前 emit `retry N/M` 到输出：

```yaml
steps:
  - shell: curl -f https://flaky-api.example.com
    retry: 3                   # 首次失败后最多再试 3 次
```

任意一次成功即继续下一步；全部失败则按 `continue_on_error` 决定是否中断。

### continue_on_error（失败继续）

默认行为：任一 step 失败即中断整条工作流。设为 `true` 则跳过失败继续：

```yaml
steps:
  - shell: optional-cleanup
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

### LLM step（stream: llm）

- `outputs.text` / `outputs.thinking` / `outputs.session_id` / `outputs.cost_usd` / `outputs.total_tokens`

**未写 `id` 的 step 引用注意**：未写 `id` 的 step 用索引兜底（键为 `"0"`/`"1"`…），此时**必须**用 bracket 语法引用：`steps["0"].outputs.exit_code`（expr 的点语法不接受数字开头的键，`steps.0.outputs.exit_code` 无法解析）。推荐给需要被引用的 step 都显式写 `id`，用 `steps.<id>.outputs.<key>` 点语法引用即可。

### 安全提示：${{ }} 直接拼接进 shell

`${{ expr }}` 的求值结果会被**未经转义**地字符串拼接进 shell 命令，再交给 `sh -c` / `powershell -Command` 执行。这与 GitHub Actions 的取向一致——是设计取向，不是 bug，但**使用者必须留意**：

- 值来自 `##[output key=value]` 协议（脚本内部可控）时风险有限
- 值来自 **LLM step 的 `outputs.text`** 时**完全是外来数据**：一次提示词注入即可任意执行本地命令
- 值中包含 `;`、`` ` ``、`$( )`、`&&`、换行等 shell 元字符时，会被 shell 解释而非当成字面量

举例：若某 step output 值为 `x; rm -rf /tmp/pwned`，则
```yaml
- shell: echo ${{ steps.a.outputs.v }}
```
会被展开为 `echo x; rm -rf /tmp/pwned` 并执行。

**展开位置**：`${{ }}` 在三处被展开——`shell` 命令字符串、action step 的 `params` 值、step 的 `env` 值。其中只有 `shell` 命令字符串存在命令注入风险（求值结果被直接拼进 `sh -c` / `powershell -Command`）；`params`/`env` 的值只会成为参数或环境变量本身，风险较低——但若该值随后又被 `${VAR}` 拼进某条 shell 命令，注入风险会随之转移。

针对 `shell` 命令字符串的规避：把占位符包进引号，让展开后的值落进「字面量」区间而非命令解析区间：

```yaml
# sh / bash：单引号内所有元字符（; ` $() 换行 等）都按字面量处理
- id: consume
  shell: echo '${{ steps.llm.outputs.text }}'
```

```yaml
# PowerShell：单引号字符串不做插值/子表达式展开
- id: consume
  shell: Write-Output '${{ steps.llm.outputs.text }}'
```

**残余风险**：单引号只能挡住除单引号以外的元字符——若值本身含 `'`（sh）就仍可能越界。所以当值来源**完全不可控**（尤其是 LLM 的 `outputs.text`）时，最稳妥的是**根本不要把它拼进 shell 命令**，改用一个专门的 `action` 脚本，由脚本自行按 `argv` 或从文件读取处理。**不要用 `${{ }}` 直接拼未经引号包裹的命令行。**

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

workflow 级 `env` 注入所有 step（优先级低于 params、高于 config.yaml）。step 级 `env` 可覆盖同名。

变量引用：`env.KEY`（expr 中）/ `${KEY}`（shell 中，由 runner.Expand 查优先级链）。

`env` 的 value 同样支持 `${{ }}` 展开（如 `TOKEN: "${{ steps.find.outputs.token }}"`），可引用前置 step 的 outputs；求值失败会中断该 step。

## 工作流参数

工作流可自带 `params`，字段格式与 action 的 `params` 完全一致（`text` / `bool` / `select` / `path`）。

**关键区别**：工作流参数不从引用的 action 聚合，需自行声明；运行时作为全局变量注入**所有** step，包括 action step 和 inline shell step。

```yaml
params:
  - id: WF_MODE
    label: 模式
    type: select
    default: fast
    options: [fast, slow]
steps:
  - shell: echo "mode=${WF_MODE}"      # inline shell 可用
  - action: some-action                # action step 也可用
```

## UI 呈现

工作流运行时右侧展示 **Pipeline Spine**（垂直管线视图）：

- 每个 step 一个节点，左侧竖线连接
- 节点状态：`PENDING`（待执行）/ `RUNNING`（执行中，带流光）/ `DONE`（成功）/ `ERROR`（失败）/ `SKIPPED`（条件跳过，灰色虚线）
- step 输出可折叠展开，stdout / stderr 分层着色
- 顶部显示整体运行状态与 Stop 按钮

后端在 step 边界 emit `step-start` / `step-done` 事件驱动前端状态更新。

## 实际示例

### 全功能演示

覆盖 `params` 四类型、`action`/`sleep`/`shell` 三形态、`env`、`if` 条件与 `outputs` 引用、`SKIPPED`、`retry`、`continue_on_error`：

```yaml
id: demo-all-features
title: "演示: 全功能工作流"
icon: hi:workflow
description: "覆盖 workflow 全部能力：params 四类型、action/sleep/shell 三形态、env、if 条件与 outputs 引用、SKIPPED、retry、continue_on_error"

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
    options: [fast, slow]
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
    shell: echo "msg=${WF_MSG} mode=${WF_MODE} verbose=${WF_VERBOSE} out=${WF_OUTDIR}"

  # 2. sleep 形态：等待
  - id: wait
    name: 等待 2s
    sleep: 2

  # 3. action 形态：引用已有动作，step.params 覆盖 action 参数
  - id: call-action
    name: 调用动作
    action: demo-echo
    params: { MSG: "来自 workflow 的问候" }

  # 4. shell 形态：写 outputs 协议行
  - id: produce
    name: 生产数据
    shell: |
      echo "开始执行..."
      echo "##[output build_id=42]"
      echo "完成"

  # 5. if 条件为真 —— outputs 引用 + ${{ }} 拼接 + env 引用
  - id: consume
    name: 消费数据（条件满足）
    if: steps.produce.outputs.exit_code == '0'
    shell: echo "build_id=${{ steps.produce.outputs.build_id }}, greeting=${GREETING}"

  # 6. if 条件为假 —— 验证 SKIPPED 状态
  - id: skip-this
    name: 条件跳过演示
    if: steps.produce.outputs.exit_code == '99'
    shell: echo "这行不会被执行"

  # 7. retry 演示：命令必然失败，验证重试痕迹 + continue_on_error 不中断后续
  - id: retry-demo
    name: 重试演示（必然失败）
    shell: exit 1
    retry: 2
    continue_on_error: true

  # 8. 故意失败（验证 error 态 + stderr 分层），作为整条 workflow 的终止点
  - id: fail-demo
    name: 演示失败
    shell: Write-Error "演示失败：这是一条 stderr 输出"; exit 1
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
command:
  shell: echo "action 回显 ${MSG}"
```

### 真实业务链路

```yaml
id: xdzs-install-broadcast
title: 安装后拉起测试页面
icon: hi:package
description: "安装 APK → 等待 5s → 拉起 DebugActivity"
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

## 校验规则

加载时由 `workflow.Validate` 校验，不合法的文件会被跳过并记录错误：

- `id` 必须匹配 `^[a-z0-9-]+$`
- `title` 必填
- `steps` 不能为空
- 每个 step 必须指定 `action` / `sleep` / `shell` 之一（三者互斥）
- step 的 `id` 若填写必须匹配 `^[a-z0-9-]+$` 且同一 workflow 内唯一
- `params[].id` 必填，且不能是保留字 `steps` / `env` / `params` / `config`
- `params[].type` 只允许 `text` / `bool` / `select` / `path`
- `select` 类型必须提供 `options`
- 同一目录下 id 不可重复

## 与 Action 的关系

| 维度 | Action | Workflow |
|------|--------|----------|
| 目录 | `actions/` | `workflows/` |
| 执行 | 单个命令/脚本 | 多个 step 串行 |
| 参数 | `params` 驱动表单 | `params` 注入所有 step |
| 预设 | 支持 `presets` | 不支持 |
| LLM 流式 | 支持 `stream: llm` | 不支持 |
| 复用 | 可被 workflow 引用 | 不可嵌套 workflow |

设计取向：**动作是原子，工作流是编排**。原子能力（超时、LLM 流式、脚本形态）放在 action，顺序与容错逻辑放在 workflow。

## 生效方式

新增/修改 YAML 后**重启 exe** 生效（启动时扫描 `workflows/*.yaml`）。

## 相关文档

- [Action 动作定义指南](action.md) — step 引用的 action 如何定义
