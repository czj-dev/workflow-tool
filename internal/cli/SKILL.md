---
name: agent-cli
description: 用本项目构建出的 workflow-tool 二进制从 shell 发现、描述、运行它的 action / workflow 并拿到输出。当你要列出有哪些 action/workflow、查某个的参数、执行它、或读它的流式/结构化输出时用。
---

# Agent CLI — 从命令行运行本项目的 action / workflow

`workflow-tool` 二进制既是 GUI，也是 CLI：`workflow-tool <子命令>` 走命令行，无子命令起 GUI。三个子命令：`list` / `describe` / `run`。下文 `workflow-tool` 指构建产物二进制（见 `deploy/`）。

## 三步用法

1. **发现** —— 列出全部 action 与 workflow：
   ```bash
   workflow-tool list
   # [{"id":"pkg-install","title":"安装 APK","kind":"action"}, ...]
   ```

2. **描述** —— 拿某个 id 的参数契约（**这是拼 `--params` 的来源真相**）：
   ```bash
   workflow-tool describe pkg-install
   # {"id":...,"kind":"action","params":[{"id":"apk","type":"path","required":true,...}],"presets":[...]}
   ```

3. **运行** —— 执行并拿输出：
   ```bash
   workflow-tool run pkg-install --params '{"apk":"/tmp/x.apk","reinstall":true}'
   ```

## 拼 `--params`

`--params` **只收 JSON 对象** `{paramId: value}`，不支持 `KEY=VALUE`。大 payload 用 `--params @file` 或 `--params @-`（stdin）。

- 每个 key 是 `describe` 返回的 `params[].id`；值按其 `type` 给：`bool` 给 JSON 布尔，其余（`text`/`select`/`path`/`file`/`textarea`）给字符串；`select` 的值须是 `options` 之一。
- 只拼 `required:true` 的即可跑；其余用默认值。字段语义与各形态细节见 `docs/action.md`（action）、`docs/workflow.md`（workflow）。

## 读输出

- **默认**：stdout/stderr 原样透传、退出码透传——当成直接跑了那条命令。
- **`--json`**：NDJSON，每行一个对象，`type ∈ output|result|error`：
  ```jsonc
  {"type":"output","stream":"stdout","line":"..."}   // stream: stdout|stderr|progress|tree|logcat|logcat-replace
  {"type":"result","exit_code":0,"success":true,"duration_ms":1234,"outputs":{"myKey":"..."}}
  {"type":"error","kind":"...","message":"..."}
  ```
  - `result` 是**末行恰好一条**。action 的 `outputs` 含脚本 `##[output key=value]` 捕获 + `exit_code`/`stdout`/`stderr`/`success`；workflow 的 `outputs` 为 `null`。
  - **workflow 结构从流里重建**：`{"stream":"step-start","line":"0"}`、`{"stream":"step-done","line":"0:0"}`（`line = "索引:退出码"`）、`step-skip` 同理；每步的 stdout 与 `##[output]` 行都在流中，按 step marker 顺序归属。
  - 完整 schema 见 `specs/agent-cli.md`。

## Flags（`run`）

| flag | 作用 |
|------|------|
| `--json` | 切 NDJSON 流式输出 |
| `--params <json>\|@file\|@-` | 参数（JSON） |
| `--device <serial>` | adb 动作指定设备；单设备时可省 |
| `--kind action\|workflow` | id 在 action/workflow 间撞名时消歧 |
| `--base-dir <path>` | actions/workflows/config.yaml 所在目录（默认二进制同级或 `WORKFLOW_TOOL_HOME`） |
| `--timeout <dur>` | 整次运行封顶，如 `30s`/`5m`，默认不限 |

## 退出码与错误

- 命令跑完：**透传**其退出码。`exit_code≠0` 是**命令失败**（可据输出重试），不是调用错误。
- 退出码 `2` + `{"type":"error","kind":...}`：**调用错误**（改调用方式）。`kind`：`unknown_id`、`ambiguous_id`（加 `--kind`）、`bad_params`（JSON 坏）、`validation`（值不合契约）、`no_device`（多设备未指定）、`llm_blocked`。
- 取消/超时：`exit_code=-1`，`error` 为 `context canceled` / `context deadline exceeded`。

## 跑不了的

- **LLM 动作（`command.llm`）禁跑** → `llm_blocked`：直接 run 和作为 workflow step 都拒。用 GUI 跑这类动作。
- adb 动作需设备：无任何 ready 设备时 → `no_device`；多设备时自动选激活/第一个，要精确控制就传 `--device <serial>`。
