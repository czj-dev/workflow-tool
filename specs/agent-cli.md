# Agent CLI 实现 Spec

给外部 Agent 一个 **shell 可调的 CLI**，暴露本项目的 action / workflow，让 Agent 能**发现、描述、调用并拿到输出**。本文件是实现的唯一来源真相（single source of truth），驱动 `cli/` 包与 `main.go` 的改动。

> 面向使用者的用法见 `internal/cli/SKILL.md`；字段级契约见 `docs/action.md`、`docs/workflow.md`；Windows 支持见 `specs/agent-cli-windows.md`（实现完成后补）。

## 设计决策总览

| 维度 | 决策 |
|------|------|
| 消费者 | 外部 Agent，经 shell 调用 |
| 范围 | action + workflow 都暴露 |
| 复用 | 薄层复用 `runner`/`actionrun`/`registry`/`workflow`（均 Wails 无关），只替换 `internal/api` 的 Wails 事件层 |
| 二进制 | 同一二进制 + 子命令；`main()` 按 `os.Args` 分流 |
| 命令 | `list` / `describe <id>` / `run <id>` |
| 输出 | 默认原样透传；`--json` 切 NDJSON 流 |
| 传参 | `--params` 只收 JSON（+ `@file` / `@-` stdin） |
| baseDir | `--base-dir` + 环境变量，默认回退 `exeDir()` |
| 可跑形态 | shell / adb / workflow；LLM 动作 v1 禁跑 |
| 退出码 | 透传命令退出码；CLI 级错误保留码 `2` |
| 取消 | SIGINT/SIGTERM → ctx cancel；可选 `--timeout` |
| schema | A1 纯镜像：CLI 逐字镜像 emit，零解码、零状态 |
| 平台 | mac/Linux 先行，Windows 延后 |

## 形态与复用边界

`main()` 先看 `os.Args[1]`：命中保留词（`list`/`describe`/`run`）走 CLI 分支并在结束时 `os.Exit`；否则照旧创建并运行 Wails GUI。

执行核心**不改**（唯一例外见「可跑形态」里 LLM guard，它在 `cli/` 层拦截，不动核心）。CLI 层自己提供原本 `api.Service` 做的事：

- 落 stdout 的 `runner.EmitFunc`（替代 `internal/api/events.go` 的 Wails Emit）
- params 合并（config.yaml 全局 + 传入）+ `runner.ExpandParams` + cwd `runner.Expand` 校验
- `binary.NewService()` + `binPaths()`，`device.NewService` + `builtinvars.New`
- `actionrun.Deps` 组装后调 `actionrun.Build`
- 信号处理 → ctx cancel（子进程清理复用 runner 现成 pgid 逻辑）

## 命令面

### `list`
枚举全部 action 与 workflow，输出**一次性 JSON 数组**：
```json
[{"id":"pkg-install","title":"安装 APK","kind":"action"},
 {"id":"xdzs-package-and-verify-res","title":"打包并验收","kind":"workflow"}]
```
数据源：`registry.Load(baseDir/actions, baseDir).Actions` + `workflow.Load(baseDir/workflows).Workflows`。

### `describe <id>`
输出单个 id 的**一次性 JSON 对象**：params 契约 + presets + kind。
```json
{"id":"pkg-install","kind":"action",
 "params":[{"id":"apk","label":"APK 路径","type":"path","required":true,
            "default":"","options":null,"description":"要安装的 APK"}],
 "presets":[{"name":"重装","values":{"reinstall":"true"}}]}
```
字段取自 `registry.ParamSpec`（id/label/type/required/default/options/description）。`type ∈ text|bool|select|path|file|textarea`。

### `run <id>`
执行 action 或 workflow。靠 registry 查类型分发；action 与 workflow **撞名** → `error kind=ambiguous_id`，要求加 `--kind action|workflow`。
Flags：`--json`、`--params <json>|@file|@-`、`--base-dir <path>`、`--device <serial>`、`--timeout <dur>`、`--kind action|workflow`。
> id 必须紧跟 `run`（`run <id> [flags]`）——flag 一律放在 id 之后（Go `flag` 在首个非 flag 实参处停止解析）。

## Input：params

`--params` **只收 JSON**（对象 `{paramId: value}`），另支持 `--params @file` 与 `--params @-`（stdin）喂大 payload。单一 JSON 路径，不提供 `K=V`——减少类型强转分支。

按 `ParamSpec.Type` 校验与归一：`text|select|path|file|textarea → string`，`bool → bool`，`select` 值须 ∈ `options`。校验失败 → `error kind=validation`；JSON 解析失败 → `error kind=bad_params`。

合并优先级沿用现有链路：传入 params > config.yaml 全局 > 环境变量；再经 `runner.Expand` 展开 `${VAR}`。

## Output：schema（A1 纯镜像）

**铁律**：CLI 是 policy-free 的透传序列化器——逐字镜像 `emit(stream, line)`，**零解码、零状态、不替任何 action 裁剪输出**。裁剪归 action 自己（`capture_output` 开关 + 脚本本身）。新增 stream 取值时 CLI 一行不用改。

### 默认：原样透传
stdout/stderr 原样打到 CLI 的 stdout/stderr，透传命令退出码。等同于直接跑了那条命令。

### `--json`：NDJSON 流
每行一个 JSON 对象，`type` 判别。三分类 **output / result / error**：

```jsonc
// 过程行：stream 原样透传（stdout|stderr|progress|tree|logcat|logcat-replace；LLM 禁故无 llm*）
{"type":"output","stream":"stdout","line":"building..."}

// workflow step 边界也原样镜像、不解码，agent 自行重建结构
{"type":"output","stream":"step-start","line":"0"}        // line = 步骤索引
{"type":"output","stream":"step-skip","line":"1"}         // line = 步骤索引
{"type":"output","stream":"step-done","line":"0:0"}       // line = "索引:退出码"

// 末行恰好一条 result —— action 带 outputs
{"type":"result","exit_code":0,"success":true,"duration_ms":1234,"error":null,
 "outputs":{"exit_code":"0","success":"true","stdout":"...","stderr":"...","myKey":"..."}}
// workflow 只给聚合，无 steps 字段（per-step 信息在镜像流里，agent 重建）
{"type":"result","exit_code":0,"success":true,"duration_ms":5678,"error":null,"outputs":null}

// CLI 级错误（非命令失败）；进程同时退出码 2
{"type":"error","kind":"unknown_id|ambiguous_id|bad_params|validation|llm_blocked|no_device","message":"..."}
```

关键语义：
- **命令失败 ≠ error**。action 自己非零退出是 `result` 里 `exit_code≠0`；`error` 只给 CLI 级调用错误。
- `outputs` 源自 `runner.Result.Outputs`（`map[string]string`，含 `##[output]` 捕获 + 保留键 `exit_code`/`stdout`/`stderr`/`success`）。workflow 的聚合 `Result.Outputs` 为 nil → `outputs:null`。
- workflow per-step 自定义 `##[output]` 行**照常打进 stdout 流**（镜像出去），每步退出码在 `step-done` 的 line（`"i:exit"`），step 归属靠 `step-start`/`step-skip` 的 marker——agent 顺序扫一遍重建，executor **零改动**。

## 退出码

- 命令跑完：**透传** action/workflow 的退出码（`runner.Result.ExitCode`）。
- CLI 级错误（未知 id / 撞名 / params 坏 / 校验失败 / LLM 禁跑 / 无设备）：保留码 **`2`** + stderr 人读消息；`--json` 下同时发 `{"type":"error",...}`。
- 取消/超时：`exit_code = -1`，`error = "context canceled"` / `"context deadline exceeded"`（对应 `runner.Result.Err` 的 `context.Canceled` / `context.DeadlineExceeded`）。

Agent 据此分辨「命令失败了」（据输出可重试）与「我调错了」（改调用方式）。

## 取消 / 超时

- 捕获 SIGINT/SIGTERM → cancel 传给 `Runner.Run` 的 ctx；子进程组清理复用 runner 现成 pgid 逻辑。
- 可选 `--timeout <dur>`（如 `30s`/`5m`），封顶整次运行，默认不限。workflow 的 per-step timeout 仍由 YAML 管。

## baseDir 解析

优先级：`--base-dir <path>` > 环境变量 `WORKFLOW_TOOL_HOME` > 现有 `exeDir()` 约定。显式优于 `exeDir()` 的 cwd 回退——Agent 常在任意 cwd 下调用。

## 可跑形态 / 设备 / LLM 禁跑

- **shell/script、adb、workflow** 可跑。
- **adb** 动作需 `ADB_SERIAL`：走 `--device <serial>` 显式指定；未给时由 `device.ResolveActive` 自动解析（激活设备，或第一个 ready 的 adb 设备）；**仅在无任何 ready 设备时** → `error kind=no_device`。多设备下不强制指定（自动选激活/第一个），要精确控制就传 `--device`——不在 CLI 复制设备列表逻辑。
- **LLM 动作 v1 禁跑**：`command.llm` 动作直接 `run`、以及作为 workflow step 被引用，都拦截 → `error kind=llm_blocked`。
  - 原因：`command.llm` 拉起的 ducc 带 `--permission-mode bypassPermissions` 且无防递归；Agent 经 CLI 触发会 fork 出无人值守 bypass 子进程、可成环。
  - guard 落在 `cli/` 层（执行前检查 `LoadedAction.Def.Command.LLM`），不动核心。日后要解禁再加 `--allow-llm`。

## id 撞名

action 命名空间与 workflow 命名空间各自全局唯一，但二者间可能撞名。`run <id>` 撞名 → `error kind=ambiguous_id`，提示加 `--kind`。`describe <id>` 同理。

## 实现落点与构建顺序

代码集中在 **`internal/cli/` 目录**（含 `internal/cli/SKILL.md`，后续 CLI 代码在此维护）：

1. `main.go`：`os.Args[1]` 命中保留词 → `cli.Run(os.Args[1:])` 后 `os.Exit(code)`；否则起 GUI。保留 blank-import（adb operation 自登记）。
2. `internal/cli/` 包：
   - `args.go`：子命令 + flag 解析（`--json`/`--params`/`--base-dir`/`--device`/`--timeout`/`--kind`）。
   - `resolve.go`：baseDir 解析；`binary`/`device`/`builtinvars` 组装（照搬 `api.go:69-78`）。
   - `discover.go`：`list`/`describe`（遍历 registry/workflow）。
   - `run.go`：params 合并校验 + LLM guard + `actionrun.Build` + ctx/signal/timeout + emit。
   - `emit.go`：序列化器——原样透传 与 `--json` NDJSON 两种 `runner.EmitFunc`；`result`/`error` 组装。
3. 改 `api.Service` 签名无关，不需 `wails3 generate bindings`（CLI 不经 binding）。

## 测试（self-check）

非平凡逻辑各留一个可跑检查（`internal/cli/*_test.go`，Go test，无框架）：
- params JSON 解析 + 按 ParamSpec 类型归一（bool/select 校验）。
- NDJSON 序列化器：给定一串 `emit(stream,line)` + Result，断言逐行 JSON 与末行 result 形状。
- LLM guard：`command.llm` 动作被拒、workflow 引用 llm step 被拒。
- id 撞名 → ambiguous_id。

## Windows（延后）

发布版 `-H windowsgui` 无控制台，stdout 会丢。但 **Agent 走管道捕获本就不需要控制台**（windowsgui 不影响继承句柄），故 mac/Linux 先行。交互式控制台场景的 `AttachConsole` 实现方案见 `specs/agent-cli-windows.md`（本 CLI 实现完成后编写）。

