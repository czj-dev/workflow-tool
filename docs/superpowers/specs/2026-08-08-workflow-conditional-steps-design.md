# workflow 条件步骤（if）+ runner 拆分 — 设计文档

> ⚠️ **存档文档 — 方案已被 main 取代，请勿据此实施**
>
> 本设计基于 `feat/workflow-action-unify` 旧代码（workflow 纯线性、Result 无 stdout）撰写。`main` 其后已用 **expr-lang/expr**（第三方表达式引擎）+ `capture_output` / `##[output k=v]` 协议 + Step `id`/`name`/`if`/`env`/`capture_output` 字段完整实现了 workflow 条件步骤，方案与本设计显著不同（本设计为**手写**表达式引擎 + runner 拆分）。本文件仅作「早期手写方案 vs main expr-lang 方案」的对比存档，**不代表当前实现方向**。

日期: 2026-08-08
状态: 存档（已被 main 的 expr-lang 方案取代）

## 1. 背景与目标

workflow 当前是**纯线性执行**：step 失败要么 `continue_on_error` 跳过、要么整条终止，没有任何"根据前一步结果走不同路径"的能力。这在 adb / Android 开发场景下是硬伤——大量操作依赖前一步的状态或输出：

- 设备 offline → 先 `adb reconnect`，否则跳过
- 处于 fastboot 模式 → `fastboot reboot`；处于 adb 模式 → `adb reboot bootloader`
- 包已安装 → 卸载；未安装 → 跳过
- 让 LLM 判断/分类，再按其回答走不同后续步骤

**目标**：给 workflow step 加 `if` 条件守卫，可引用前序 step 的**成败状态**和**stdout 内容**。

**前置重构**：当前 `runner.Result` 没有 stdout（stdout 是 emit 单向流，executor 拿不到），且 LLM 流式解析寄生在 `ShellRunner` 的 `stream=="llm"` 分支里。要先拆 runner——抽通用进程编排、让 `Result` 带回 stdout、把 LLM 抽成独立 Runner——`if` 才有数据可依。

## 2. 现状与约束（关键事实）

- [runner.go:12-16](internal/runner/runner.go#L12) `Result{ExitCode, Err, Duration}`——**无 stdout**；[shell_runner.go:73-75](internal/runner/shell_runner.go#L73) stdout/stderr 经 `pump`→`emit` 单向推送，执行完不回收。
- [shell_runner.go:70-74](internal/runner/shell_runner.go#L70) LLM 流靠 `if cfg.Stream=="llm"` 分支调 `pumpLLM`；[llm.go](internal/runner/llm.go) 的 `parseLLMLine`/`pumpLLM` 是**纯函数**，无 ShellRunner 耦合。
- [schema.go:30-38](internal/workflow/schema.go#L30) `Step` 只有 `action/shell/sleep` + `retry/continue_on_error`，**无 `id`、无 `if`**；[executor.go:30-47](internal/workflow/executor.go#L30) 纯线性 for 循环，step 间无状态/输出传递。
- `Runner.Run(ctx, params, emit) Result` 接口是 CLAUDE.md 红线——**签名稳定不变**，只扩 `Result` 字段。
- action 两处构造 `ShellRunner`：单动作执行 [api.go:349 `execute`](internal/api/api.go#L349) 与 workflow 内 action step [api.go:571 `makeActionRun`](internal/api/api.go#L571)——两处都要改。
- 参考项目 ADBKit [executor.go](https://github.com/Drenzzz/ADBKit/blob/master/internal/core/executor.go)：`ExecResult` 带 `Stdout/Stderr`，streaming 模式边回调边 buffer，`scanProgressLines` 按 `\n`/`\r` 双切（adb 进度是 `\r` 驱动，单按 `\n` 切会丢进度）。其"全量/stdin/streaming 三执行模式函数"**不照搬**（见 §5）。

## 3. 设计

### 3.1 第 1 层：通用进程编排 `internal/runner/exec.go`（新）

把"起进程 + 切行 + 超时 + 杀进程组"从 ShellRunner 抽出，纯 Go、不依赖 Wails。**只编排进程，不替调用方 buffer stdout**——因为 Shell 与 LLM 对"什么是有用输出"定义不同，buffer 留给各 Runner。

```go
// ExecRequest 进程执行入参。
type ExecRequest struct {
    Cmd     *exec.Cmd
    Timeout time.Duration
}

// ExecOutcome 进程执行产物（不含 stdout——由调用方在 onLine 里累积）。
type ExecOutcome struct {
    ExitCode int
    Err      error
    Duration time.Duration
}

// Run 起进程，stdout/stderr 按 \n/\r 双切逐行回调 onLine；超时杀进程组。
func Run(ctx context.Context, req ExecRequest, onLine func(stream, line string)) ExecOutcome
```

职责：建 `StdoutPipe`/`StderrPipe` → `hideWindow`/`setPgid`/`cmd.Dir`/`cmd.Env`（复用现有） → `Start` → 两 goroutine 用移植自 ADBKit 的 `scanProgressLines` 切行调 `onLine` → `select` 超时（`killGroup`）/`cmd.Wait` → 返回 `ExecOutcome`。

**附带修复**：`scanProgressLines` 双切 `\r`，顺带修掉 adb push/install 的进度丢失（现在 `pump` 只按 `\n`）。

### 3.2 第 2 层：`ShellRunner` 收瘦

只留变量替换 + 跨平台命令构造 + env：

- `Run`：`Expand`(Shell/Script/Cwd/Env) → `buildCommandFromCfg` → `exec.Run(cmd, onLine, timeout)`
- `onLine`：`emit(stream, line)` + 累积进 stdout/stderr buffer（带上限，见 3.9）
- 返回 `Result{ExitCode, Stdout, Stderr, Duration}`
- **删除 `cfg.Stream=="llm"` 分支**——ShellRunner 不再知道 LLM 的存在

### 3.3 第 2 层：`LLMRunner`（新，与 ShellRunner 平级）

实现 `Runner` 接口，复用 `ShellConfig`（去掉 `Stream` 字段）：

- `Run`：`Expand` → `buildCommandFromCfg`（claude CLI 也是 shell 命令） → `exec.Run(cmd, onLine, timeout)`
- `onLine`：
  - **stdout 行** → `parseLLMLine`：`text` → `emit("llm", delta)` 且累积进 `Stdout` buffer；`thinking` → `emit("llm-thinking", delta)`（不进 Result）；不可解析 → 丢弃
  - **stderr 行** → `emit("stderr", line)`（claude 诊断，原样推前端，不进 Result）
- 返回 `Result{ExitCode, Stdout: 累积的 assistant text, Duration}`

**`Stdout` 只放 assistant text**——让 `if` 能引用 LLM 的最终回答（`if: outputs.ask.stdout contains "yes"`），把 LLM 变成工作流里的判断器/分类器。`thinking` 与诊断只 emit 给前端展示。

### 3.4 `Result` 扩字段，`Runner` 接口不动

```go
type Result struct {
    ExitCode int
    Stdout   string   // 新增
    Stderr   string   // 新增
    Err      error
    Duration time.Duration
}
```

`Runner.Run` 签名零改动 → 守住"接口稳定"红线。所有读 `ExitCode` 的旧代码不受影响。

### 3.5 api 层 runner 分发（两处）

`stream` 字段从"ShellRunner 内部分支标记"升级为"**api 层选 runner 的依据**"。`ShellConfig.Stream` 字段删除；`stream` 仍存在于 registry 的 `CommandDef`（YAML 解析层，`stream: "llm"` 向后兼容）。

```go
// execute() 与 makeActionRun() 两处统一：
var r runner.Runner
if la.Def.Command.Stream == "llm" {
    r = &runner.LLMRunner{Cfg: shellCfg}
} else {
    r = &runner.ShellRunner{Cfg: shellCfg}
}
return r.Run(ctx, runParams, emit)
```

### 3.6 workflow `Step` 加 `ID` + `If`

```go
type Step struct {
    ID              string            `yaml:"id"`      // 可选，供后续 if 引用其输出
    Action          string            `yaml:"action"`
    Params          map[string]string `yaml:"params"`
    Sleep           int               `yaml:"sleep"`
    Shell           string            `yaml:"shell"`
    Timeout         string            `yaml:"timeout"`
    Retry           int               `yaml:"retry"`
    ContinueOnError bool              `yaml:"continue_on_error"`
    If              string            `yaml:"if"`      // 可选条件表达式，假则跳过
}
```

守卫模型（不做 if/then/else 嵌套块）：`if` 求值真→执行本步；假→跳过（emit `step-skip`）。表达"二选一"= 两个互补 `if` 的 step。

### 3.7 executor 存 step 输出 + `if` 求值跳过

执行期维护：

```go
type stepOutcome struct {
    ExitCode int
    Stdout   string
    Stderr   string
}
outcomes := map[string]stepOutcome{}   // key = step.ID
lastSuccess := true                     // 紧邻上一个"已执行"step 是否成功；初值 true（首个 step 若写 success() 视为真）
```

每个 step：

1. 若 `step.If != ""`：`evalExpr(step.If, outcomes, lastSuccess)` → `false` 则 `emit("step-skip", i)` + `continue`，`true` 才执行
2. 执行拿 `res`（`res.Stdout` 现成可用，无需 tee hack）
3. 若 `step.ID != ""`：`outcomes[step.ID] = {res.ExitCode, res.Stdout, res.Stderr}`
4. `lastSuccess = (res.ExitCode == 0)`
5. 失败处理（`continue_on_error` / 终止）语义不变

**缺失引用安全默认**：`outputs.<不存在的id>` → stdout/stderr 为空串、exit_code 为 -1；`success("不存在")` → false。组合结果默认偏向"不执行"。

### 3.8 表达式最小集 `internal/workflow/expr.go`（新，手写解析器，零依赖）

| 表达式 | 含义 |
|---|---|
| `success()` / `failure()` | 紧邻上一个已执行 step 的成败 |
| `success("id")` / `failure("id")` | 指定 step 的成败 |
| `outputs.<id>.stdout contains "x"` | stdout 含子串 |
| `outputs.<id>.stdout matches /\d+\.\d+/` | stdout 匹配正则 |
| `outputs.<id>.exit_code == 0` | exit code 数字比较（`==`/`!=`） |
| `A and B` / `A or B` / `not A` | 布尔组合 |
| `( A )` | 分组 |

**操作数约束**：`contains`/`matches`/`==`/`!=` 左操作数为 `outputs.<id>.*` 引用，右操作数为字面字符串（`"..."`）、字面正则（`/.../`）或字面数字；不支持两个 outputs 引用互比（phase 1）。

示例覆盖典型 adb 场景：

```yaml
steps:
  - id: mode
    shell: 'fastboot devices 2>/dev/null | grep -q . && echo fastboot || echo adb'
  - shell: 'fastboot reboot'
    if: 'outputs.mode.stdout contains "fastboot"'
  - shell: 'adb reboot bootloader'
    if: 'outputs.mode.stdout contains "adb"'
  - id: installed
    shell: 'adb shell pm path com.x.y 2>/dev/null | grep -q package'
  - shell: 'adb uninstall com.x.y'
    if: 'success("installed")'
  - shell: 'echo 询问 LLM 中... && claude -p "该报错该重试还是放弃？只答重试或放弃"'
    id: ask
    stream: llm
  - shell: './retry.sh'
    if: 'outputs.ask.stdout contains "重试"'
```

### 3.9 stdout buffer 上限

`Stdout`/`Stderr` 累积各设 **256KB 软上限**（常量可调），超出只保留尾部。防 `adb logcat` 这类无限流撑爆内存；`contains`/`matches` 看尾部足够。ShellRunner 与 LLMRunner 共用此上限逻辑（提到 `exec.go` 或 `util.go` 的 `capBuffer` helper）。

### 3.10 校验（`workflow.Validate`）

- `step.id` 非空时须匹配 `^[a-z][a-z0-9_-]*$`，且 workflow 内**唯一**
- `step.if` 非空时 dry-run 解析一次，语法错则加载报错（不在运行时才崩）

### 3.11 前端 / 事件（最小）

- executor 新增 `emit("step-skip", "<i>")`，前端 step 视图标记"跳过"
- `WorkflowStepInfo` 加 `ID`/`If` 字段（侧栏摘要可选展示）
- `if` 条件的**可视化编辑器不做**（phase 1 只在 YAML 里写、UI 只读展示）

### 3.12 docs 同步（CLAUDE.md 强制）

- [docs/workflow.md](docs/workflow.md)：Step `id`/`if` 字段、表达式语法表、守卫模型说明、adb 示例
- [docs/action.md](docs/action.md)：`stream` 字段语义更新（现在选 runner 类型，而非 ShellRunner 内分支）；LLM action 的 `Result.Stdout` = assistant text 语义

## 4. 改动范围

后端（Go）：
1. `internal/runner/exec.go`（新）、`runner.go`（Result 加字段）、`shell_runner.go`（收瘦+删 stream 分支+累积 stdout）、`llm_runner.go`（新）、`shell_runner.go`/`llm_runner.go` 的 `ShellConfig` 去 `Stream`
2. `internal/workflow/schema.go`（Step 加 ID/If + Validate）、`executor.go`（outcomes + if 求值 + step-skip）、`expr.go`（新）
3. `internal/api/api.go`（`execute` + `makeActionRun` 两处分发）

前端：step-skip 事件处理 + `WorkflowStepInfo` 加字段（最小）。

文档：`docs/workflow.md`、`docs/action.md`。

**不动**：`Runner` 接口签名、`registry`/`expand.go`/`sleep_runner.go`/`llm.go`（纯函数保留）、现有 action/workflow YAML（向后兼容）。

## 5. 不做（YAGNI）

- **PTY 优先**（adb 进度条可见）——phase 2；本轮只搬 `\r\n` 双切修进度丢失
- **stdin 执行模式**（ADBKit `RunCommandWithStdin`）——无场景；将来需要给 `ExecRequest` 加 `Stdin` 字段即可
- **全量 buffer 独立执行模式**（ADBKit `RunCommand`）——onLine 累积已覆盖"拿全量 stdout"
- **if/then/else 嵌套块、switch/case、循环 loop、并行 step**——守卫模型 + 布尔组合已够；保持 steps 线性
- **第三方表达式引擎**（expr-lang 等）——手写最小集够 adb 用，零新依赖
- **stdout 无上限 buffer**——256KB 上限防爆
- **前端 if 可视化编辑器**——phase 1 只读展示

## 6. 分阶段实现顺序

1. `exec.go` 抽离（含 `scanProgressLines`）+ 单测（进程编排/超时/`\r` 切行/kill 进程组）
2. `Result` 加 `Stdout`/`Stderr`
3. `ShellRunner` 改用 `exec.go` + `capBuffer` 累积 + 删 stream 分支 + 更新测试
4. `LLMRunner` 新建 + 单测（mock stream-json 进程，验 `emit("llm")` 与 `Stdout`=累积 text）
5. api 两处分发 + `ShellConfig` 删 `Stream` + 回归现有 llm action
6. `expr.go` 表达式 + 单测（各操作符 / 缺失引用默认 false）
7. `Step` 加 `ID`/`If` + `Validate`（含 dry-run） + executor outcomes + if 求值跳过 + `step-skip` 事件 + executor 测试
8. 前端 step-skip 展示 + `WorkflowStepInfo` 字段
9. docs 同步

## 7. 验证

| 项 | 方式 |
|----|------|
| 单测全绿 | `go test ./internal/runner ./internal/workflow ./internal/registry ./internal/api` |
| exec 编排 | 超时触发 kill 进程组、`\r` 进度行被切成独立 token |
| ShellRunner | stdout/stderr 累积进 `Result`、超 256KB 截尾 |
| LLMRunner | stream-json 解析为 `emit("llm")`、`Result.Stdout`=assistant text、非 JSON 行不崩 |
| 表达式 | `contains`/`matches`/`==`/`success`/`failure`/`and`/`or`/`not` 全覆盖；缺失 id → false |
| executor | `if` 真/假分支、`step-skip` 事件、outcomes 跨 step 引用、缺失引用安全跳过 |
| 回归 | 现有 `stream: llm` action 行为不变；现有无 `if` workflow 行为不变 |
| 端到端 | 写 `mode` 检测分支测试 workflow，确认按设备状态走对分支 |
