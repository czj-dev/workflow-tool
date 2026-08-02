# adb-logcat 过滤增强 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增强 `adb-logcat` 动作，改为跨平台脚本实现，新增 包名/Tag/消息包含/消息排除 四个可选过滤参数，过滤后流式落盘到 `LOGS_DIR`。

**Architecture:** 修改 `actions/adb-logcat.yaml`（inline shell → `script`），新增 `scripts/adb-logcat.{sh,ps1}`。参数经环境变量注入子进程（[`runner.buildEnv`](../../internal/runner/shell_runner.go)），脚本按参数有无逐段拼过滤管道（包名 → `--pid` 优先 / 降级 threadtime 按列匹配；Tag → `-s`；消息 → `grep -Ei` / `Where-Object -match`），单条管道 + 行缓冲保证流式落盘。零 Go / 前端改动。

**Tech Stack:** POSIX sh、PowerShell、YAML、adb logcat。

## Global Constraints

（逐条摘自 CLAUDE.md 与设计文档，所有任务隐含遵守）

- 锁定 Wails `v3.0.0-alpha2.119`，不升 alpha.3。
- 本计划**不改** `internal/api/api.go`，**无需** `wails3 generate bindings`；**不改**前端，**无需** `npm run build`（复用现有 `frontend/dist`）。
- 动作约束：`id` 匹配 `^[a-z0-9-]+$`、`title` 必填、`command.shell` 与 `command.script` 互斥必选其一。
- `params[].type` 仅 `text|bool|select|path`；`stream` 仅 `""` 或 `"llm"`（本动作为空）。
- `script` 路径**不含扩展名**，ShellRunner 按 OS 自动补 `.sh`（macOS/Linux）或 `.ps1`（Windows），相对路径基于 exe 目录（[`shell_runner.go:118-134`](../../internal/runner/shell_runner.go)）。
- **参数经环境变量注入子进程**：sh 用 `${VAR}`，PowerShell 用 `$env:VAR`（[`shell_runner.go:139-148`](../../internal/runner/shell_runner.go)）。
- `timeout` 用 `time.ParseDuration` 解析，空字符串默认 `60s`（本动作设 `24h`，[`registry.go:157-166`](../../internal/registry/registry.go)）。
- 持续运行的 logcat 靠现有 `CancelAction`（[`api.go:180`](../../internal/api/api.go)）+ 前端停止按钮收尾，`timeout` 仅兜底。
- **脚本测试策略**：项目脚本（如 `adb-install`）无自动化测试框架，遵循惯例——采用「过滤原语验证」（喂构造数据、断言输出）+ 端到端手动验证，**不**强加 shell 测试框架（YAGNI）。

## File Structure

| 文件 | 责任 | 动作 |
|------|------|------|
| `scripts/adb-logcat.sh` | macOS/Linux 抓取+过滤+落盘 | 新增 |
| `scripts/adb-logcat.ps1` | Windows 抓取+过滤+落盘 | 新增 |
| `actions/adb-logcat.yaml` | 动作定义（参数 + script 引用 + timeout） | 修改 |

两份脚本职责完全对称，仅语言不同。`internal/` 与 `frontend/` 不动。

---

## Task 1: 新增 `scripts/adb-logcat.sh`

**Files:**
- Create: `scripts/adb-logcat.sh`

**Interfaces:**
- Consumes: 环境变量 `LOGS_DIR`（必填）、`PACKAGE`/`TAG`/`INCLUDE`/`EXCLUDE`（可选，由 `runner.buildEnv` 注入）
- Produces: 写入 `${LOGS_DIR}/logcat_<YYYYMMDD_HHMMSS>.log`；stderr 打印 `写入: <路径>`

- [ ] **Step 1: 创建脚本文件**

Create `scripts/adb-logcat.sh`：

```sh
#!/bin/sh
# adb logcat 抓取到本地文件，可选按 包名 / Tag / 消息关键字 过滤。
# 参数经环境变量注入（见 runner.buildEnv）：
#   LOGS_DIR  必填，日志输出目录
#   PACKAGE   可选，包名（自动解析 pid 过滤）
#   TAG       可选，logcat tag，多个空格分隔
#   INCLUDE   可选，消息包含（正则，大小写不敏感）
#   EXCLUDE   可选，消息排除（正则，大小写不敏感）

TS=$(date +%Y%m%d_%H%M%S)
OUT="${LOGS_DIR}/logcat_${TS}.log"

# 收集 logcat 源参数：-v threadtime + 可选 -s TAG:* + 可选 --pid=PID
set -- -v threadtime
if [ -n "${TAG:-}" ]; then
  for t in $TAG; do set -- "$@" "${t}:*"; done
fi

# 包名 → pid 过滤：优先 --pid（Android 8+），不支持则降级按 threadtime 第 3 列 awk 过滤
USE_PID_FILTER=0
if [ -n "${PACKAGE:-}" ]; then
  PID=$(adb shell pidof -s "${PACKAGE}" | tr -d '\r\n')
  if [ -n "$PID" ]; then
    if adb logcat --help 2>&1 | grep -q -- '--pid'; then
      set -- "$@" --pid="$PID"
    else
      FILTER_PID="$PID"
      USE_PID_FILTER=1
    fi
  else
    echo "未找到包进程: ${PACKAGE}（进程未运行？继续抓全量）" >&2
  fi
fi

# 可选过滤阶段：参数空时 cat 透传，非空时过滤（-i 大小写不敏感，--line-buffered 保证流式）。
# 用 if 分支而非 `grep ... || cat`，避免 grep 无匹配返回非 0 时误走 cat。
stage_pid()     { if [ "$USE_PID_FILTER" -eq 1 ]; then awk -v p="$FILTER_PID" '$3==p'; else cat; fi; }
stage_include() { if [ -n "${INCLUDE:-}" ]; then grep -Ei --line-buffered "$INCLUDE"; else cat; fi; }
stage_exclude() { if [ -n "${EXCLUDE:-}" ]; then grep -v -Ei --line-buffered "$EXCLUDE"; else cat; fi; }

echo "写入: $OUT" >&2
adb logcat "$@" | stage_pid | stage_include | stage_exclude > "$OUT"
```

- [ ] **Step 2: 语法检查**

Run: `sh -n scripts/adb-logcat.sh`
Expected: 无输出，退出码 0。

- [ ] **Step 3: 验证包含过滤原语（不依赖 adb）**

Run:
```sh
printf 'D VoiceASR: debug line\nW VoiceASR: QUERY received\nE SystemUI: crash\n' \
  | { grep -Ei --line-buffered "query" || true; }
```
Expected: 只输出一行 `W VoiceASR: QUERY received`（证明 `INCLUDE` 大小写不敏感匹配生效）。

- [ ] **Step 4: 验证排除过滤原语**

Run:
```sh
printf 'D Tag: keep\nW Tag: Garbage noise\nE Tag: error\n' \
  | { grep -v -Ei --line-buffered "garbage" || true; }
```
Expected: 输出 `D Tag: keep` 与 `E Tag: error` 两行，不含 `Garbage noise`。

- [ ] **Step 5: 验证降级 pid 过滤原语（awk 第 3 列）**

Run:
```sh
printf '01-01 00:00:00.000  1111  2222 D Tag: a\n01-01 00:00:00.001  3333  4444 D Tag: b\n' \
  | awk -v p="1111" '$3==p'
```
Expected: 只输出第一行（PID=1111）。证明降级路径按 threadtime 第 3 列（PID）过滤。

- [ ] **Step 6: 端到端冒烟（连真机，可选——需 macOS/Linux 或 Git Bash 有 `timeout`）**

Run:
```sh
mkdir -p /tmp/logcat-test
LOGS_DIR=/tmp/logcat-test timeout 3 sh scripts/adb-logcat.sh
ls -la /tmp/logcat-test/
```
Expected: `timeout` 3 秒后终止脚本，目录下出现 `logcat_<时间戳>.log` 且非空。无真机则跳过此步，靠 Step 2-5 + Task 3 联调。

- [ ] **Step 7: 提交**

```sh
git add scripts/adb-logcat.sh
git commit -m "feat(scripts): 新增 adb-logcat.sh 过滤抓取脚本

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 新增 `scripts/adb-logcat.ps1`

**Files:**
- Create: `scripts/adb-logcat.ps1`

**Interfaces:**
- Consumes: 环境变量 `LOGS_DIR`（必填）、`PACKAGE`/`TAG`/`INCLUDE`/`EXCLUDE`（可选）；经 `$env:` 读取
- Produces: 写入 `$LOGS_DIR/logcat_<yyyyMMdd_HHmmss>.log`；`Write-Output "写入: <路径>"`

- [ ] **Step 1: 创建脚本文件**

Create `scripts/adb-logcat.ps1`：

```powershell
# adb logcat 抓取到本地文件，可选按 包名 / Tag / 消息关键字 过滤。
# 参数经环境变量注入（见 runner.buildEnv），PowerShell 用 $env: 读取：
#   LOGS_DIR  必填，日志输出目录
#   PACKAGE   可选，包名（自动解析 pid 过滤）
#   TAG       可选，logcat tag，多个空格分隔
#   INCLUDE   可选，消息包含（正则，-match 大小写不敏感）
#   EXCLUDE   可选，消息排除（正则，-notmatch 大小写不敏感）

$LOGS_DIR   = $env:LOGS_DIR
$TAG        = $env:TAG
$PACKAGE    = $env:PACKAGE
$INCLUDE    = $env:INCLUDE
$EXCLUDE    = $env:EXCLUDE
$filterPid  = $null

$ts  = Get-Date -Format yyyyMMdd_HHmmss
$out = Join-Path $LOGS_DIR "logcat_$ts.log"

# 收集 logcat 源参数
$logcatArgs = @('-v', 'threadtime')
if ($TAG) { ($TAG -split '\s+') | ForEach-Object { $logcatArgs += "$_:*" } }

# 包名 → pid 过滤：优先 --pid（Android 8+），不支持则降级按 threadtime 第 3 列匹配。
# 注意：$PID 是 PowerShell 自动变量（当前进程 PID），不可复用，故用 $procId。
$usePidFilter = $false
if ($PACKAGE) {
  $procId = (adb shell pidof -s $PACKAGE).Trim()
  if ($procId) {
    if ((adb logcat --help 2>&1) -match '--pid') {
      $logcatArgs += '--pid', $procId
    } else {
      $filterPid = $procId
      $usePidFilter = $true
    }
  } else {
    Write-Output "未找到包进程: $PACKAGE（进程未运行？继续抓全量）"
  }
}

Write-Output "写入: $out"
# 关键：必须用单条管道流式落盘——PowerShell 逐行读取 adb 的 stdout 并写文件。
# 严禁 $lines = & adb logcat 再过滤（会阻塞至 logcat 结束，违背流式）。
# Where-Object 条件：参数空时透传（-not $X 短路）；非空时各负其责。
adb logcat @logcatArgs |
    Where-Object { -not $usePidFilter -or ($_.ToString() -split '\s+')[2] -eq $filterPid } |
    Where-Object { -not $INCLUDE       -or $_ -match $INCLUDE } |
    Where-Object { -not $EXCLUDE       -or $_ -notmatch $EXCLUDE } |
    Out-File -FilePath $out -Encoding utf8
```

- [ ] **Step 2: 语法检查（PowerShell 解析器）**

Run:
```sh
pwsh -NoProfile -Command "[void][System.Management.Automation.Language.Parser]::ParseFile('scripts/adb-logcat.ps1', [ref]\$null, [ref]\$errs); \$errs"
```
（无 pwsh 则用 `powershell` 替换命令名。）
Expected: 无错误输出（`$errs` 为空），退出码 0。

- [ ] **Step 3: 验证包含过滤原语**

Run:
```sh
pwsh -NoProfile -Command "@('D VoiceASR: debug','W VoiceASR: QUERY received','E SystemUI: crash') | Where-Object { -not \$INCLUDE -or \$_ -match \$INCLUDE } -WithVar @{INCLUDE='query'}" 2>/dev/null || pwsh -NoProfile -Command "\$INCLUDE='query'; @('D VoiceASR: debug','W VoiceASR: QUERY received','E SystemUI: crash') | Where-Object { -not \$INCLUDE -or \$_ -match \$INCLUDE }"
```
Expected: 只输出 `W VoiceASR: QUERY received`（`-match` 大小写不敏感）。

- [ ] **Step 4: 验证排除过滤原语**

Run:
```sh
pwsh -NoProfile -Command "\$EXCLUDE='garbage'; @('D Tag: keep','W Tag: Garbage noise','E Tag: error') | Where-Object { -not \$EXCLUDE -or \$_ -notmatch \$EXCLUDE }"
```
Expected: 输出 `D Tag: keep` 与 `E Tag: error`，不含 `Garbage noise`。

- [ ] **Step 5: 提交**

```sh
git add scripts/adb-logcat.ps1
git commit -m "feat(scripts): 新增 adb-logcat.ps1 过滤抓取脚本

Co-Authored-By: Claude <noreply@anthropic.com>"
```

> 端到端验证统一放在 Task 3（开发机为 Windows，exe 走 `.ps1`，UI 联调最直接）。

---

## Task 3: 修改 `actions/adb-logcat.yaml` + 端到端联调

**Files:**
- Modify: `actions/adb-logcat.yaml`（全文替换）

**Interfaces:**
- Consumes: Task 1/2 产出的 `scripts/adb-logcat.{sh,ps1}`
- Produces: 一个参数化、可持续抓取的 `adb-logcat` 动作

- [ ] **Step 1: 改写动作定义**

用以下内容**完整替换** `actions/adb-logcat.yaml`：

```yaml
id: adb-logcat
title: 抓取日志
icon: hi:file
description: adb logcat 抓取到本地文件（可选按 包名/Tag/消息关键字 过滤，手动停止）
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

变更点：`shell` → `script`；新增 4 个可选 text 参数；`timeout` 10m → 24h；`description` 更新。

- [ ] **Step 2: registry 回归测试**

Run: `go test ./internal/registry`
Expected: PASS（确认 `ParseAction`/`Validate` 仍接受新 yaml 结构——4 个可选 text 参数、`script` + `timeout: 24h` 均合法；本改动不引入新校验逻辑，靠现有测试回归）。

- [ ] **Step 3: 构建 exe（按 CLAUDE.md 顺序，本计划未改 api.go/前端，跳过 npm 与 bindings）**

Run: `go build -ldflags "-H windowsgui" -o workflow-tool.exe .`
Expected: 无报错，产出 `workflow-tool.exe`。确认 exe 与 `actions/`、`scripts/` 同级（[`exeDir` 约定](../../main.go)，`script: ./scripts/adb-logcat` 才能解析到）。

- [ ] **Step 4: 端到端——全量抓取（向后兼容）**

运行 `workflow-tool.exe` → 选「抓取日志」→ 只填 `LOGS_DIR`，其余留空 → 运行 → 等 3-5 秒点「停止」。
Expected: `LOGS_DIR` 下生成 `logcat_<时间戳>.log`，内容为全量 threadtime 日志（含 PID/TID 列）；停止后无 `adb` 进程残留（任务管理器核查）。

- [ ] **Step 5: 端到端——包名过滤**

`PACKAGE` 填 `com.baidu.che.codriver`，运行数秒后停止。
Expected: 文件内仅含该进程日志。查看 stderr 区（输出面板）应见 `写入: <路径>`；若进程未运行，见 `未找到包进程: ...` 提示且文件为全量。

- [ ] **Step 6: 端到端——Tag + 包含 + 排除组合**

`TAG` 填一个已知 tag、`INCLUDE` 填一个会出现的词、`EXCLUDE` 填一个噪音词，运行数秒后停止。
Expected: 文件内容同时满足三层过滤。

- [ ] **Step 7: 端到端——停止按钮杀进程组**

抓取运行中点「停止」。
Expected: 立即停止，输出末尾出现退出行；任务管理器中无残留 `adb.exe` / `logcat` 子进程（验证 [`killGroup`](../../internal/runner/shell_runner.go) 生效）。

- [ ] **Step 8: 提交**

```sh
git add actions/adb-logcat.yaml
git commit -m "feat(actions): adb-logcat 支持 包名/Tag/消息 过滤，改用脚本跨平台落盘

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage（对照设计文档逐项）：**
- 修改 `adb-logcat.yaml`（script + 4 参数 + 24h）→ Task 3 Step 1 ✓
- 跨平台时间戳（`date` / `Get-Date -Format`）→ Task 1/2 Step 1 ✓
- 包名 `--pid` 优先 + threadtime 降级 → Task 1/2 Step 1（`adb logcat --help | grep --pid` 探测 + awk / 列匹配降级）✓
- Tag `-s TAG:*` → Task 1/2 Step 1 ✓
- 消息 `grep -Ei` / `Where-Object -match` → Task 1/2 Step 1 ✓
- 行缓冲 / 单条管道流式 → `.sh` `--line-buffered`、`.ps1` 单条管道（Step 1 注释强调）✓
- 停止机制（`CancelAction` + `killGroup`）→ Task 3 Step 7 验证 ✓
- 向后兼容（不填=全量）→ Task 3 Step 4 验证 ✓
- `$env:` 读取（PowerShell）→ Task 2 Step 1 顶部映射 ✓
- 无新增自动化测试（遵循项目惯例）→ Global Constraints + 各 Task 用原语/端到端验证 ✓

**2. Placeholder scan：** 无 TBD/TODO；所有代码块为完整可执行内容；验证步骤均含 exact command + expected。✓

**3. Type/命名一致性：** 两脚本参数名一致（`LOGS_DIR`/`PACKAGE`/`TAG`/`INCLUDE`/`EXCLUDE`）；yaml 的 param `id` 与脚本读取的环境变量一一对应；`.ps1` 避开自动变量 `$PID` 用 `$procId`，设计文档伪代码已同步修正。✓
