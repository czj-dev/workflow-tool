# 借鉴 GitHub Actions 与 Claude Code Headless 的 Workflow/Action 增强设计

> 日期：2026-08-07
> 范围：workflow 编排层为主，action 层最小侵入（仅新增 `capture_output`）

## 背景与目标

当前 workflow 只能靠环境副作用/文件在 step 间传数据，缺少条件执行、步骤标识、输出捕获。
借鉴 GitHub Actions（step id / outputs / if）与 Claude Code headless（stream-json 已解析但未沉淀），
让 **step 成为一等公民**：有 id、有 name、有 output，条件判断才有东西可判，多步 LLM 流水线才能成立。

**设计取向不变**：动作是原子，工作流是编排。原子能力（超时、流式、是否捕获输出）落在 action；
顺序、条件、数据传递落在 workflow。

## 范围

纳入本轮：

1. `steps[].id` —— 步骤标识（可选，未写用索引兜底），供 outputs 引用与 UI 展示
2. `steps[].name` —— 人类可读标签，Pipeline Spine 显示
3. `steps[].if` —— expr 表达式条件，false 则 SKIPPED
4. step outputs —— 通用字段（exit_code/stdout/stderr/success）+ `##[output key=value]` 协议
5. `command.capture_output` —— action/step 级开关，默认 true
6. workflow 级 `env` 分层 —— `params > workflow.env > config.yaml > 系统环境变量`
7. LLM step 结构化 outputs —— `stream: llm` 时捕获 text/thinking/session_id/cost/tokens
8. Session chaining —— 依赖 #7 的 session_id，实现多步 LLM 续对话

不纳入（YAGNI，有需求再加）：

- `matrix` 参数矩阵展开
- 数值比较 / 函数（`contains` 等，expr 原生支持，暂不在文档"解锁"）
- 非流式 `--output-format=json`（#3 候选，等具体场景）
- `--append-system-prompt` / `--allowed-tools` 抽字段（用户写在 shell 里即可）
- workflow 级 cost/token 预算护栏

## 技术选型

**表达式引擎：`github.com/expr-lang/expr`**（纯 Go，无 CGO，`go get` 即用）。
未来要 `contains()`/数值比较/三元表达式都已原生支持，不需自己维护引擎，只需在文档"解锁"。

**关键决策：不做文本替换后再交给 expr**，而是把变量作为 env context 传给 `expr.Eval`，
让引擎自己按点路径取值。避免值里的引号/换行破坏表达式语法（注入类 bug）。

`shell` 的 `${VAR}` 与 `if` 的 expr 变量**共用同一个 context map，两个消费者各用适合自己的机制**：

```
构造 context map（steps / env / params / config）
       ├──→ runner.Expand(shell 字符串, ctx)   # 现有路径，纯文本替换，扁平 ${VAR}
       └──→ expr.Eval(if 表达式, ctx)          # 新路径，语法层求值，扁平变量名
```

`if` 采用**扁平写法**（`steps.build.outputs.exit_code == '0'`、`env.LOG_LEVEL == 'debug'`），
不加 `${{ }}` 外壳（`if` 字段语义上就是表达式，外壳冗余）。代价是新增保留字校验（见下）。

## Schema 变更

### workflow（`internal/workflow/schema.go`）

```yaml
id: my-workflow
env:                              # 新增：workflow 级默认环境变量
  LOG_LEVEL: debug

steps:
  - id: build                     # 新增：可选标识，未写用索引 i 兜底（向后兼容）
    name: 构建 APK                 # 新增：Pipeline Spine 显示；无则回退 action id / shell 前缀
    action: adb-install
    capture_output: true          # 新增：step 级开关，默认 true
    env:                          # 新增：step 级 env，覆盖 workflow.env 同名 key
      LOG_LEVEL: verbose

  - id: notify
    if: steps.build.outputs.exit_code == '0'   # 新增：expr 表达式
    shell: echo "成功"
```

`Step` 新增字段：`ID string`、`Name string`、`If string`、`CaptureOutput *bool`（指针以区分"未写=默认 true"与"显式 false"）、`Env map[string]string`。

`WorkflowDef` 新增：`Env map[string]string`。

### action（`internal/registry/registry.go`）

`Command` 新增 `CaptureOutput *bool`（默认 true）。scrcpy/logcat 这类长跑/持续输出 action 显式设 `false`。

## Outputs 契约

### runner.Result 扩展（`internal/runner/runner.go`）

```go
type Result struct {
    ExitCode int
    Err      error
    Duration time.Duration
    Stdout   string            // 新增：capture_output=true 时填充
    Stderr   string            // 新增：同上
    Outputs  map[string]string // 新增：##[output key=value] 协议解析结果
}
```

### 两层 outputs

**Layer 1（免费，capture_output=true 时所有 step 自动获得）：**

- `outputs.exit_code`
- `outputs.stdout` / `outputs.stderr`（捕获的全部输出）
- `outputs.success`（`"true"` / `"false"`）

**Layer 2（可选协议，脚本主动写才有）：**

- stdout 中 `##[output key=value]` → 解析成 `outputs.key`
- 与 Layer 1 共存；reserved key（exit_code/stdout/stderr/success）冲突时协议值覆盖 + warning

**不设容量上限**（已确认）。长跑/大输出 action 由作者显式 `capture_output: false` 控制。

### ShellRunner 捕获逻辑（`internal/runner/shell_runner.go`）

`pump` 时若 `capture_output=true`：一边 emit 流式行给前端（不变），一边 append 进 buffer；
同时对每行匹配 `##[output key=value]` 协议，命中塞进 `Outputs`。

## LLM step 结构化 outputs（`stream: llm`）

`stream: llm` 时 stdout 是 stream-json 原始行，直接捕获会得到几十 KB 无用 JSON。
因此 **`stream: llm` 时用结构化捕获替换原始 stdout 捕获**（`pumpLLM` 已解析，只需同步 append 到 buffer 字段）：

```
outputs.text          # 拼接的 assistant text
outputs.thinking      # 拼接的 thinking 块
outputs.session_id    # 从 init 事件取
outputs.cost_usd      # 从 result 事件取
outputs.total_tokens  # 从 result 事件取
outputs.exit_code / outputs.success   # 通用字段仍在
```

### Session chaining（多步 LLM 续对话）

```yaml
steps:
  - id: analyze
    action: claude-ask
    params: { QUESTION: "分析当前目录的代码结构" }

  - id: test
    if: steps.analyze.outputs.success == 'true'
    shell: claude -p --resume ${{ steps.analyze.outputs.session_id }} "根据分析写单测"
    stream: llm
```

> 注：shell 内变量仍走 `runner.Expand`（`${...}` 语法），上例 `--resume` 后需按 shell 侧
> 变量引用规则展开 session_id（实现时确认 `steps.x.outputs.y` 能否进 shell 的扁平 vars，
> 或提供别名）。此为实现细节，spec 阶段标记为待实现确认点。

## Executor 表达式求值（`internal/workflow/executor.go`）

```go
type stepContext struct {
    steps  map[string]stepOutput   // key = step id（或索引兜底），累积已跑 step
    env    map[string]string       // workflow.env 展开后的值
    params map[string]any          // 运行时表单参数
}
type stepOutput struct {
    Outputs map[string]string   // exit_code/stdout/stderr/success + 协议自定义 key
}
```

- 每个 step 跑完，把 `Result` 写入 `steps[id]`，供后续 step 的 `if` / 变量引用
- `if` 求值：`expr.Eval(step.If, flatten(ctx))`，`steps`/`env`/`params` 作为顶层 key 暴露
- `if` 为 false → **SKIPPED**：不执行 dispatch，emit `step-skip`，不计入 retry/continue_on_error，直接进入下一 step

## 变量优先级更新

```
现状：params > config.yaml(全局) > 系统环境变量
新增：params > workflow.env > step.env > config.yaml(全局) > 系统环境变量
```

- `workflow.env` / `step.env` 在 Executor 执行前用 `runner.Expand` 展开（支持自引用其他层），
  合并进传给每个 step 的 vars map，插在 config.yaml 之上、params 之下
- `step.env` 覆盖 `workflow.env` 同名 key

## 校验变更

### workflow.Validate（`internal/workflow/schema.go`）

- `steps[].id` 可选；写了则必须匹配 `^[a-z0-9-]+$` 且同一 workflow 内唯一
- **新增保留字校验**：`params[].id` 不能是 `steps` / `env` / `params` / `config`（扁平写法冲突）
- `if` 字段为空时跳过（无条件执行，等同现状）

## UI 变更（Pipeline Spine，前端）

- 节点标签：`step.name` 优先，无则回退现状（action id / shell 命令前缀）
- 新增 `SKIPPED` 状态样式：灰色/虚线，区别于 `PENDING`（待执行）
- LLM step 的 outputs（text/cost/tokens）可选在节点展开区展示

## 依赖

- Go 新增：`github.com/expr-lang/expr`（纯 Go，无 CGO）

## 文档同步（schema 改动必须跟）

- `docs/action.md`：新增 `command.capture_output`、变量优先级更新
- `docs/workflow.md`：新增 `steps[].id/name/if`、outputs 契约、workflow.env 分层、SKIPPED 状态、LLM outputs

## 测试要点

- `internal/runner`：capture_output 开关、`##[output]` 协议解析、reserved key 覆盖 + warning、LLM 结构化 outputs 提取
- `internal/workflow`：expr 求值（==/!=/&&/||/!）、SKIPPED 语义（不计 retry/continue_on_error）、id 兜底与唯一性、保留字校验、env 分层优先级
- 表驱动 + `-race`

