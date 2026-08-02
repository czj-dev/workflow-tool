# adb-logcat 过滤增强 设计

> 日期：2026-08-02
> 类型：动作增强（修改现有 `adb-logcat` + 新增跨平台脚本）

## 背景与目标

现有 [`actions/adb-logcat.yaml`](../../../actions/adb-logcat.yaml) 用一行 inline shell 把 adb logcat 全量输出抓到本地文件：

```yaml
command:
  shell: adb logcat -v time > "${LOGS_DIR}/logcat_$(date +%Y%m%d_%H%M%S).log"
  timeout: 10m
```

存在两个问题：

1. **跨平台时间戳失效**：`$(date +%Y%m%d_%H%M%S)` 是 bash 语法。Windows 下 ShellRunner 走 PowerShell（见 [`shell_runner.go:110-116`](../../../internal/runner/shell_runner.go#L110-L116)），PowerShell 的 `date`（`Get-Date`）不接受 `+%Y...` 参数，文件名生成会出错。
2. **无过滤能力**：车载语音助手日志量极大，全量抓取后定位问题困难，需要按**包名 / Tag / 消息关键字**过滤后再落盘。

**目标**：增强 `adb-logcat`，改用跨平台脚本实现，新增 4 个**可选**过滤参数，过滤参数不填时行为与原全量抓取等价（向后兼容）。

## 需求

- 落盘到 `LOGS_DIR`（主要目的，不变）。
- 新增可选过滤维度：**包名（PACKAGE）**、**Tag（TAG）**、**消息包含（INCLUDE，正则）**、**消息排除（EXCLUDE，正则）**。
- 持续抓取，由用户手动点「停止」按钮收尾（`timeout` 仅作兜底）。
- 过滤参数全部可选，不填 = 原全量抓取。
- 跨 macOS / Windows 一致工作。

## 设计

### 1. 动作定义 `actions/adb-logcat.yaml`（修改）

```yaml
id: adb-logcat
title: 抓取日志
icon: hi:file
description: adb logcat 抓取到本地文件（可选按 包名/Tag/消息关键字 过滤）
params:
  - id: LOGS_DIR
    label: 日志目录
    type: path
    required: true
  - id: PACKAGE
    label: 包名过滤（可空，如 com.baidu.che.codriver）
    type: text
  - id: TAG
    label: Tag 过滤（多个空格分隔，可空）
    type: text
  - id: INCLUDE
    label: 消息包含（正则，可空）
    type: text
  - id: EXCLUDE
    label: 消息排除（正则，可空）
    type: text
command:
  script: ./scripts/adb-logcat
  timeout: 24h
```

变更点：
- `command.shell` → `command.script`（交由跨平台脚本处理时间戳与过滤管道）。
- 新增 4 个可选 text 参数（`PACKAGE` / `TAG` / `INCLUDE` / `EXCLUDE`）。
- `timeout: 10m` → `24h`：持续抓取，靠停止按钮收尾（见下「停止机制」）。
- `description` 更新为反映过滤能力。

### 2. 脚本 `scripts/adb-logcat.sh` 与 `scripts/adb-logcat.ps1`（新增）

`script: ./scripts/adb-logcat` 由 ShellRunner 按 OS 解析为 `.sh`（macOS/Linux）或 `.ps1`（Windows），见 [`shell_runner.go:118-134`](../../../internal/runner/shell_runner.go#L118-L134)。两份脚本职责相同：

**职责**：按参数有无，逐段拼接过滤管道，最终重定向到 `${LOGS_DIR}/logcat_<时间戳>.log`。

**管道阶段**（每段仅在对应参数非空时启用）：

| 阶段 | 条件 | 实现 |
|------|------|------|
| ① logcat 源 | 恒有 | `adb logcat -v threadtime` |
| ①a Tag | `TAG` 非空 | 附加 `-s TAG1:* TAG2:*`（多个 Tag 拆空格） |
| ①b 包名 | `PACKAGE` 非空 | 解析 `PID=$(adb shell pidof -s $PACKAGE)`，附加 `--pid=$PID` |
| ② 消息包含 | `INCLUDE` 非空 | `grep -E --line-buffered "$INCLUDE"`（.ps1：`Where-Object { $_ -match }`） |
| ③ 消息排除 | `EXCLUDE` 非空 | `grep -v -E --line-buffered "$EXCLUDE"`（.ps1：`Where-Object { -notmatch }`） |
| ④ 重定向 | 恒有 | `> "$LOGS_DIR/logcat_${TS}.log"` |

**时间戳**：`.sh` 用 `date +%Y%m%d_%H%M%S`；`.ps1` 用 `Get-Date -Format yyyyMMdd_HHmmss`。

**行缓冲**：流式管道中 `grep` 必须加 `--line-buffered`，否则块缓冲会导致文件迟迟无输出；PowerShell 管道天然逐行，无需额外处理。

#### `.sh` 伪代码

```sh
#!/bin/sh
TS=$(date +%Y%m%d_%H%M%S)
OUT="${LOGS_DIR}/logcat_${TS}.log"

# 收集 logcat 参数
set -- -v threadtime
if [ -n "$TAG" ]; then
  for t in $TAG; do set -- "$@" "${t}:*"; done
fi
if [ -n "$PACKAGE" ]; then
  PID=$(adb shell pidof -s "$PACKAGE" | tr -d '\r\n')
  if [ -n "$PID" ]; then set -- "$@" --pid="$PID"; fi
fi

# 可选过滤阶段：参数空时 cat 透传，非空时 grep（行缓冲保证流式）。
# 用 if 分支而非 `grep ... || cat`，避免 grep 无匹配返回非 0 时误走 cat 分支。
stage_include() { if [ -n "$INCLUDE" ]; then grep -E --line-buffered "$INCLUDE"; else cat; fi; }
stage_exclude() { if [ -n "$EXCLUDE" ]; then grep -v -E --line-buffered "$EXCLUDE"; else cat; fi; }

adb logcat "$@" | stage_include | stage_exclude > "$OUT"
```

#### `.ps1` 伪代码

```powershell
# params 经环境变量注入（shell_runner.buildEnv），PowerShell 须用 $env: 读取后映射到本地变量
$LOGS_DIR = $env:LOGS_DIR
$TAG      = $env:TAG
$PACKAGE  = $env:PACKAGE
$INCLUDE  = $env:INCLUDE
$EXCLUDE  = $env:EXCLUDE

$ts = Get-Date -Format yyyyMMdd_HHmmss
$out = Join-Path $LOGS_DIR "logcat_$ts.log"

$logcatArgs = @('-v','threadtime')
if ($TAG) { ($TAG -split '\s+') | ForEach-Object { $logcatArgs += "$_:*" } }
# 注意：$PID 是 PowerShell 自动变量（当前进程 PID），不可复用，改用 $procId。
if ($PACKAGE) { $procId = (adb shell pidof -s $PACKAGE).Trim(); if ($procId) { $logcatArgs += '--pid', $procId } }

# 关键：必须用单条管道流式落盘——PowerShell 逐行读取 adb 的 stdout 并写文件。
# 严禁 $lines = & adb logcat 再过滤（会阻塞至 logcat 结束，违背流式）。
# Where-Object 条件：参数空时透传，非空时 INCLUDE 保留匹配、EXCLUDE 丢弃匹配。
adb logcat @logcatArgs |
    Where-Object { -not $INCLUDE -or $_ -match $INCLUDE } |
    Where-Object { -not $EXCLUDE -or $_ -notmatch $EXCLUDE } |
    Out-File -FilePath $out -Encoding utf8
```

> 注：PowerShell 用 `Where-Object` 而非 `Select-String`（后者输出 `MatchInfo` 对象，落盘需取 `.Line`，徒增复杂）。`Out-File -Encoding utf8` 保证中文不乱码。

### 3. 包名过滤策略

`adb logcat --pid=<PID>` 需要 Android 8.0+（API 26+）的 logcat 支持。车载 Android（百度车载语音平台）版本通常满足。

- **首选**：`--pid`（简洁、精确）。
- **降级**：若运行时 `logcat` 不识别 `--pid`（退出码非 0 且报错），改为 `-v threadtime` 输出后用 `awk` 按列匹配 PID 字段（threadtime 第 3 列为 PID）。
- 降级判定在脚本内完成，对用户透明；具体探测方式见实现计划。

### 4. 停止机制

`timeout: 24h` 仅作兜底（避免 [`context.WithTimeout(ctx, 0)`](../../../internal/runner/shell_runner.go#L33) 立即超时）。实际停止流程：

用户点「停止」按钮（[`OutputToolbar.tsx:64`](../../../frontend/src/components/OutputToolbar.tsx#L64)）→ `cancel()` → [`CancelAction`](../../../internal/api/api.go#L180) → `ctx.Done()` → [`killGroup`](../../../internal/runner/shell_runner.go#L86) 杀整个进程组（含 `adb logcat` 子进程，不会残留）。文件已写入部分保留。

### 5. 向后兼容

4 个过滤参数全部可选。全不填时，脚本等价于：

```sh
adb logcat -v threadtime > "$LOGS_DIR/logcat_<TS>.log"
```

与原行为基本一致，仅两点细微变化：
- 时间戳跨平台正确（修掉了 Windows 下失效的 bug）。
- 输出格式由 `-v time` 改为 `-v threadtime`（含 PID/TID 列，信息更全，也是包名降级过滤所必需）。这是有意为之的改进。

## 不在范围（YAGNI）

- **前端高亮 / 级别着色**：本动作专注落盘，不涉及前端；如需「实时盯 + 高亮」属另一动作（曾讨论的方案 B），未来再议。
- **日志级别过滤**（`*:W` 等）：本次未纳入参数。
- **抓取后自动打开 / 预览文件**。
- **脚本自动化测试**：项目现有脚本（如 `adb-install`）无测试惯例，本次保持一致，靠手动验证。

## 测试策略

- **Go 后端**：无改动，不新增单测。
- **前端**：无改动，不新增测试。
- **脚本手动验证矩阵**（实现后人工跑一遍）：

| 用例 | 参数 | 期望 |
|------|------|------|
| 全量（兼容） | 全空 | 抓取全量到文件，行为同原动作 |
| 仅包名 | `PACKAGE=com.baidu.che.codriver` | 只含该进程日志 |
| 仅 Tag | `TAG=VoiceAssistant` | 只含该 Tag |
| 包含+排除 | `INCLUDE=QUERY`、`EXCLUDE=Garbage` | 同时满足 |
| 全组合 | 四参数齐 | 管道全启用 |
| Windows 时间戳 | 任意 | 文件名时间戳正确（回归原 bug） |
| 停止 | 抓取中点停止 | 进程组被杀，无 adb 残留，文件保留已抓部分 |

## 涉及文件

- 修改：`actions/adb-logcat.yaml`
- 新增：`scripts/adb-logcat.sh`、`scripts/adb-logcat.ps1`
- 不改动：`internal/`（runner / api / registry）、`frontend/`
