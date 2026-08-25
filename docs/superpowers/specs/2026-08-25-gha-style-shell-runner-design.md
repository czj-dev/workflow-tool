# GHA 风格 ShellRunner 改造设计

日期：2026-08-25
状态：已与用户逐节确认

## 背景与痛点

当前 ShellRunner 的跨平台模型（`internal/runner/shell_runner.go` 的 `buildCommandFromCfg`）：

- 内联 `command.shell:` 命令 → Windows 走 PowerShell（pwsh 7 优先，回退 Windows PowerShell 5），其他平台走 `sh -c`
- `command.script:` → 按 OS 拼接 `.ps1` / `.sh` 扩展名，意味着同一逻辑要维护两份脚本
- 同一条内联命令事实上要求在 PowerShell 和 POSIX sh 两个方言下都能跑

实证调查（2026-08-25）：抽查的三个多行动作（`adb-battery` / `log-json-extract` / `xdzs-device-init`）**全部是 bash 方言**（`[ -n "$S" ]`、heredoc、`for pkg in ...; do`、`|| true`），在 Windows PowerShell 下根本无法执行——现有动作事实上已假设 POSIX 语义，Windows 端靠运气活着。

`script` 形态的初衷是「直接挂 .sh / .py / .js 脚本文件，方便维护和运行」，当前「按 OS 拼扩展名」的实现偏离了该目标。

## 决策记录

用户拍板（按 GitHub Actions 模型移植）：

1. `shell` 字段改为 GHA 语义——**显式指定解释器工具**
2. bash 在 Windows 上优先解析 **Git Bash**
3. **错误处理语义统一**（默认严格、可显式放宽）
4. `script` 回归初衷：直接运行 `.sh` / `.py` / `.js` 脚本文件
5. Schema 迁移：**完全对标 GHA，一次性迁移所有 YAML，不留兼容层**
6. 默认 shell：**统一 bash**（两平台），而非 GHA 原版的 OS 相关默认
7. 实现形状：**argv 模板注册表 + 「一切皆脚本文件」**（内联 `run:` 落临时文件执行，GHA runner 的真实做法）

否决的备选：`-c` 内联 + 文件双轨（两套执行路径两套语义，自定义模板塞不进 switch）；砍掉 script 解释器路由（违背诉求 4）。

## YAML Schema

### Action 层

```yaml
command:
  run: echo hello              # 形态 A：内联命令（原 shell 字段改名），多行块照旧支持
  # script: ./scripts/foo.py   # 形态 B：脚本文件，必须带扩展名
  shell: bash                  # 可选修饰字段：解释器，默认 bash
  cwd: / timeout: / env: / capture_output:   # 语义不变
```

- **四选一互斥**：`run` / `script` / `adb.operation` / `llm.prompt`。`shell` 从「形态字段」降级为「修饰字段」——只在 run/script 形态下有意义，配 adb/llm 形态时写 `shell:` 报校验错
- **`shell:` 允许值**：
  - 内置名：`bash`（默认）/ `sh` / `pwsh` / `powershell` / `python` / `node` / `cmd`
  - 自定义模板：任意含 `{0}` 的字符串（如 `shell: "perl {0}"`），`{0}` 是脚本文件路径占位符
- **`script:` 按扩展名路由解释器**：
  - `.sh` → bash
  - `.ps1` → pwsh（探测不到 pwsh 时回退 Windows PowerShell 5，保持现有回退行为）
  - `.py` → python
  - `.js` → node
  - `shell:` 字段可显式覆盖扩展名推断
  - 未知扩展名在加载时报错
- 校验落点：`registry.validate`（现有 shell/script/adb/llm 四选一互斥校验改写）

### Workflow 层

- step 的 `shell:` 改名 `run:`，新增可选 `shell:` 工具字段，语义与 action 层完全一致
- 仍是 action / run / sleep 三选一；`script` **不**进 workflow step（需要脚本时包成 action，单一入口）
- `ShellRequest`（workflow 层执行回调请求类型）同步改字段

## 执行引擎

### argv 模板注册表

`internal/runner/shellspec.go` 新增：

```go
type ShellSpec struct {
    Template []string // argv 模板，"{0}" 替换为脚本文件路径
    Ext      string   // 内联 run 落临时文件的扩展名
    WrapHead string   // 写入脚本前的包装头（pwsh 用）
    WrapTail string   // 脚本尾包装（pwsh 用）
}
```

| 逻辑名 | Template | Ext | 包装 |
| --- | --- | --- | --- |
| `bash` | `<解析出的bash> --noprofile --norc -eo pipefail {0}` | `.sh` | 无 |
| `sh` | `sh -e {0}` | `.sh` | 无 |
| `pwsh` | `pwsh -NoProfile -Command {0}` | `.ps1` | 头 `$ErrorActionPreference = 'stop'`；尾 `if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }` |
| `powershell` | 同 pwsh 但用 `powershell` | `.ps1` | 同 pwsh |
| `python` | `python -u {0}`（`-u` 无缓冲 stdout，保 `##[progress]` 流式） | `.py` | 无 |
| `node` | `node {0}` | `.js` | 无 |
| `cmd` | `cmd /D /Q /V:ON /C "{0}"`（{0} 带引号） | `.cmd` | 无 |
| 自定义 | 用户模板按空白分词（与 GHA 一致，不支持引号分组） | 默认 `.sh` | 无 |

新增解释器 = 注册表加一条记录。

补充语义：

- **pwsh 回退**：`pwsh` 逻辑名解析时未安装 pwsh 7 → 自动回退 `powershell` 5（保持现有回退行为）；显式写 `powershell` 则直接用 5，不探测 pwsh
- **python 可执行名**：非 Windows 先找 `python3` 再回退 `python`（macOS/Linux 惯例）；Windows 直接 `python`
- **sh 在 Windows**：与 bash 同套探测级联找 `sh.exe`（Git Bash 自带，同样排除 System32 WSL）

### bash 解析级联（Windows）

新文件 `internal/runner/shell_lookup_windows.go`（非 Windows 为 `shell_lookup_other.go`，直接用 PATH 的 `bash`，不级联）。复刻 `internal/adb/binary` 的「config → PATH → 常见路径」模式，但不依赖 adbcore：

1. `config.yaml` 的 `BASH_PATH` 显式覆盖（由 `actionrun.Build` 从全局配置读取并传入 `ShellConfig`——与 adb 域 `ResolvePaths` 注入同模式）
2. `exec.LookPath("bash")`——**排除 `C:\Windows\System32\bash.exe`**（WSL 入口，脚本路径语义是 Linux 视角，混入即新坑）
3. 常见路径级联：`C:\Program Files\Git\bin\bash.exe` → `C:\Program Files\Git\usr\bin\bash.exe` → `C:\Program Files (x86)\Git\bin\bash.exe` → `C:\msys64\usr\bin\bash.exe` → `C:\msys64\bin\bash.exe`
4. 全找不到 → **执行时报错**（信息含「装 Git for Windows 或设 BASH_PATH」指引），**绝不静默回退 PowerShell**——静默换方言正是现状一切坑的根源

### 内联 `run:` 执行流

1. `${VAR}` 展开（现状链路不变：params > builtins > env）
2. 写临时文件：`os.CreateTemp("", "wf-run-*"+spec.Ext)`，内容**强制 LF 行尾**（bash 遇 CRLF 报 `$'\r': command not found`）；spec 有 WrapHead/WrapTail 时按 头+内容+尾 拼接
3. argv = spec.Template 中 `{0}` 替换为临时文件路径
4. `defer` 删除临时文件
5. `script:` 形态**不落临时文件**：`{0}` = 解析后的真实脚本路径（相对路径基于 exe 目录，现状不变），spec 默认按扩展名推断、`shell:` 字段可覆盖

Git Bash 接受 Windows 路径参数（自动转 MSYS 路径），临时文件路径无需手工转换。

## 错误处理语义

| Shell | 语义 |
| --- | --- |
| `bash` | `--noprofile --norc -eo pipefail`——任一命令非零即中断、管道取最右非零码 |
| `sh` | `-e`（pipefail 非 POSIX 可移植，不加） |
| `pwsh` / `powershell` | WrapHead `$ErrorActionPreference = 'stop'`；WrapTail 传播原生命令退出码（解决 PS 经典坑：adb/gradlew 非零码默认不传播为脚本退出码） |
| `python` / `node` / `cmd` / 自定义 | 无包装（异常/退出码自然传播） |

**逃生门**：默认严格、显式放宽——脚本内 `set +e`、`|| true`、`$ErrorActionPreference = 'Continue'` 照常有效。「统一」指默认行为可预测，不是剥夺作者控制权。

**不变项**：timeout / cancel 杀进程组（pgid）、`${VAR}` 展开链、`##[output]` / `##[progress]` 协议、`capture_output`、`exit_code` / `stdout` / `stderr` / `success` outputs。

## 迁移清单（一次性，无兼容层）

| 对象 | 改动 |
| --- | --- |
| 15 个内联 `shell:` 动作 | `shell:` → `run:`，内容零改写（已是 bash 方言，默认 bash 使其首次真正可跨平台） |
| `xdzs-device-init.yaml` | 脚本开头加 `set +e`（作者注释明确要容错逐条执行，默认 `-e` 会改变行为，显式保真） |
| `log-spm-download.yaml` | `script: ./scripts/spm-download` → `script: ./scripts/spm-download.py`（直挂 python 实现，见下方「spm-download 薄壳消灭」） |
| Go 类型 | `registry.Command{Shell→Run + Shell}`、`workflow.Step{Shell→Run + Shell}`、`ShellRequest`、`runner.ShellConfig` 同步改 |
| bindings | `ShellRequest` 是 Wails 绑定类型，改后必须 `wails3 generate bindings` → `npm run build` → `go build`（走 `bash deploy/build.sh`） |
| 文档 | `docs/action.md` + `docs/workflow.md` 全量更新（shell 允许值表 / script 扩展名路由 / 临时文件机制 / BASH_PATH 说明） |
| CLAUDE.md | 「四选一」与 shell/script 形态描述同步更新 |
| `config.yaml` | 不强制改——`BASH_PATH` 为可选逃生口，只写文档 |
| 前端 | 零源码改动（已确认无 `command.shell` 字段消费），bindings 重新生成即可 |

### spm-download 薄壳消灭（script 回归初衷的直接证词）

现状：`scripts/` 下 `spm-download.{sh,ps1}` 都是把 env 参数桥接成 `spm-download.py` argv 的**薄壳**，其存在的唯一理由是「script 形态只认 .sh/.ps1」（薄壳注释原话）。真正的实现是 `spm-download.py`。

迁移处置：

- `log-spm-download.yaml` 改 `script: ./scripts/spm-download.py`，直挂 python 实现
- `spm-download.py` 小改：argv 为空时从环境变量读 `ZIP_NAME` / `INNER_PATH` / `OUT_DIR`（吸收薄壳的 env→argv 桥接职责；`OUT_DIR` 为空省略的语义保留）
- 删除 `spm-download.sh` 与 `spm-download.ps1`（存在理由被本次改动消灭）
- 注册表 python 模板带 `-u`（见执行引擎节），吸收薄壳的关缓冲职责，`##[progress]` 流式不受影响

不在本次范围：`scripts/adb-install.{sh,ps1}`、`scripts/adb-logcat.{sh,ps1}` 是无 action 引用的孤儿脚本，不动（docs 示例迁移时不再引用它们即可）。

## 验收资产（新增）

5 个验收动作（`test-*` 前缀）+ 1 个验收工作流 + 2 个测试脚本：

| 文件 | 验收点 |
| --- | --- |
| `actions/test-shell-bash.yaml` | 默认 bash：多行块 + `${VAR}` 展开 + `##[output]` 协议行 + 退出码 0 |
| `actions/test-shell-failfast.yaml` | `-eo pipefail`：第 2 行故意失败，验证中断（后续行不执行、`exit_code` 非零）；「预期失败」写入 description |
| `actions/test-shell-pwsh.yaml` | 显式 `shell: pwsh` + WrapTail：原生命令非零退出码传播为脚本退出码 |
| `actions/test-script-python.yaml` + `scripts/test/hello.py` | `script:` `.py` 路由到 python |
| `actions/test-script-node.yaml` + `scripts/test/hello.js` | `script:` `.js` 路由到 node |
| `workflows/test-shell-acceptance.yaml` | 端到端串联：run（bash 默认，产出 `##[output]`）→ run + `shell: pwsh` → `if` 引用前步 outputs 的条件步 → action 步（跑 test-script-python）→ sleep + 收尾 echo |

`set +e` 逃生门由迁移后的 `xdzs-device-init` 作为现成验收样本覆盖。

## 测试策略

**runner 包**（新增为主）：

- 注册表：每个逻辑名展开正确 argv、`{0}` 替换位置、自定义模板（含 `{0}` 合法 / 不含报错）、`cmd` 引号格式
- 临时文件：内容含 `\r\n` 落盘强制 LF；执行后删除；WrapHead/WrapTail 拼接顺序
- bash 探测（Windows）：`BASH_PATH` 覆盖优先、PATH 命中但 System32 WSL bash 被排除、常见路径级联顺序、全找不到报错含指引；探测函数接受候选注入，单测不依赖真实机器状态
- script 路由：`.sh`/`.py`/`.js`/`.ps1` 各选对 spec、未知扩展名报错、`shell:` 覆盖推断
- 错误语义（本机 Git Bash 真实验证）：`-eo pipefail` 中断 + 非零 `exit_code`；`set +e` 逃生生效；pwsh 尾包装传播原生命令码
- 现有 `shell_runner_test.go` 随字段改名适配

**registry / workflow / actionrun**：四选一互斥改写（run/script/adb/llm）、`shell:` 值合法性、`shell:` 配 adb/llm 报错、Step/ShellRequest 改名适配。

**手动验证**：`bash deploy/build.sh` 后真机跑验收资产全套；重点 `log-json-extract`（heredoc）在 Windows 首次可执行。

## 成功标准

1. 同一份 YAML 在 Windows / macOS 同语义执行
2. `shell:` 可显式指定解释器（含自定义 `{0}` 模板）
3. 默认 `-eo pipefail` 错误处理统一，`set +e` 等逃生门有效
4. `script:` 直接挂 `.sh` / `.py` / `.js` 单份维护
5. 现有 16 个动作迁移后行为等价（`xdzs-device-init` 以 `set +e` 显式保真）
6. 验收动作 / 工作流全套通过

## 改动文件全景图

```text
新增  internal/runner/shellspec.go             注册表 + spec 解析
新增  internal/runner/shellspec_test.go
新增  internal/runner/shell_lookup_windows.go  bash 探测级联（含 WSL 排除）
新增  internal/runner/shell_lookup_other.go    非 Windows 直接 PATH
新增  internal/runner/shell_lookup_test.go
修改  internal/runner/shell_runner.go          buildCommandFromCfg → spec 驱动 + 临时文件
修改  internal/runner/shell_runner_test.go     字段/行为适配
修改  internal/registry/action.go              Command struct + validate
修改  internal/registry/registry_test.go
修改  internal/workflow/workflow.go            Step struct
修改  internal/workflow/executor.go            ShellRequest + 分发
修改  internal/workflow/executor_test.go
修改  internal/actionrun/build.go              分发适配
修改  internal/actionrun/build_test.go
迁移  actions/*.yaml ×16                       shell:→run:（+1 个加 set +e）
小改  scripts/spm-download.py                  argv 为空时从 env 读参数
删除  scripts/spm-download.{sh,ps1}            env→argv 桥接薄壳（存在理由消灭）
新增  actions/test-*.yaml ×5                   验收动作
新增  scripts/test/{hello.py,hello.js}         验收脚本
新增  workflows/test-shell-acceptance.yaml     验收工作流
检查  scripts/                                 spm-download 实际文件定扩展名
文档  docs/action.md + docs/workflow.md        全量同步
文档  CLAUDE.md                                四选一描述同步
前端  bindings 重新生成                         零源码改动
```

## 验收记录（2026-08-25，Windows 11 真机）

验收方式：无法自动化 GUI 点击，改用与 exe 完全相同的库路径
（registry.Load → actionrun.Build / workflow.Executor → Runner.Run）临时 harness
逐项执行清单（含事件流断言），等效覆盖「YAML 加载 → Runner 构造 → 解释器执行 →
输出协议」全链路；UI 事件推送层（events.go）由 api 包单测覆盖。

| # | 资产 | 结果 | 说明 |
| --- | --- | --- | --- |
| 1 | test-shell-bash | ✅ | exit=0；hello workflow-tool + 多行第二行；outputs verified=yes |
| 2 | test-shell-failfast | ✅ | exit=3；「不应出现此行」未出现（-eo pipefail 生效） |
| 3 | test-shell-pwsh | ✅（修复后） | exit=5；两行输出齐。**验收抓住实现 bug**：pwsh 模板原为 `-Command <路径>`，脚本内 exit $LASTEXITCODE 不传播（恒 1），改 `-File` 后正确传播（commit 01d7fe9，补模板断言 + 端到端回归测试） |
| 4 | test-script-python | ✅ | exit=0；hello from python 3.11 + py_major=3 |
| 5 | test-script-node | ✅ | exit=0；hello from node v26.7.0 + node_major=26 |
| 6 | test-shell-acceptance wf | ✅ | 整体 exit=0；produce→outputs→consume（build_id=42）→python action→sleep→all done 全链路通 |
| 7 | log-json-extract 回归 | ✅ | heredoc bash 语法在 Windows 上首次真正可执行；前置信息 + 中文还原正常 |
| 8 | xdzs-device-init 回归 | ✅ | 无设备环境下 adb 逐条报错不中断（set +e 保真），走到「[init] 完成」exit=0 |
| 9 | demo-all-features 回归 | ✅ | 走到 fail-demo 终止（exit=1）；demo-echo/build_id=42 等前置步输出齐；fail-demo stderr 含「演示失败」中文行 |

配套检查：

- Go 全包测试 PASS（runner/registry/workflow/api/actionrun）；前端 vitest 215/216、
  typecheck 干净；lint 20 项均为 pre-existing（不涉及本次改动文件）。
- 前端 91 例失败系 Node ≥22 experimental Web Storage 占位导致 jsdom localStorage
  不可达，setup.ts 补内存版 Storage 修复（commit ebe7638）；剩余 WorkflowView
  「00/01」1 例失败在改造前 commit bb0f53a 复现相同失败点，确认 pre-existing。
- 全量构建（frontend → bindings → go build）成功产出 workflow-tool.exe；
  pwsh -File 修复后已重建。
