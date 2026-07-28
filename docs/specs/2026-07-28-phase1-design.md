# Workflow Tool — Phase 1 设计文档

- **日期**: 2026-07-28
- **状态**: 设计已确认，待实现
- **技术栈**: Wails v3 + Go + YAML
- **项目路径**: `C:/Users/ASUS/Documents/workflow-tool/`

---

## 1. 概述

一个桌面端个人 workflow 工具：通过按钮一键触发预设的命令/脚本，实时查看输出。目标是**开箱即用**——单一二进制 + `actions/` 配置文件夹，分发给任何 Mac/Windows 用户都能直接用、自己加动作，无需装运行时环境。

### 1.1 核心约束

| 约束 | 说明 |
|------|------|
| GUI 带按钮 | 点击触发，不是 CLI |
| Windows + macOS 跨平台 | 一套代码出两平台二进制 |
| 零执行成本 | 单二进制分发，使用者无需配置 Go/Node 环境 |

### 1.2 为什么选 Wails

- Go 后端跑命令 + Web 前端展示，事件总线天然支持**实时流式输出**
- 编译成单二进制，跨平台分发（依赖 WebView2，Win11/新 Win10 自带）
- 对比 Fyne：UI 现代好看、前后端分离对 AI coding 友好
- 对比 Tauri：Go 学习/编译成本低于 Rust，对胶水 workflow 任务够用

---

## 2. 渐进式路线图（D 路径：从 A 起步可扩展到 C）

**核心原则**：`Runner` 接口一旦定下不再改，所有扩展都在 YAML schema 和编排层发生。

| Phase | 能力 | 实现方式 | 接口变化 |
|-------|------|---------|---------|
| **1 (MVP)** | 单命令/脚本一键触发 | ShellRunner + Registry | 定下 Runner 接口 |
| 2 | 多步骤串行 | WorkflowRunner 编排多个 Runner | 无（新加 Runner 实现） |
| 3 | 参数输入表单 | YAML `params` schema → 前端动态表单 | 无（params 字段启用） |
| 4 | 条件分支 | YAML `when` / `depends_on` | 无（编排层扩展） |

每一层升级 = YAML 多几个字段 + 一个新 Runner 实现，Go 核心 `Runner` 接口永远不变。

---

## 3. Phase 1 详细设计

### 3.1 Runner 接口（核心，稳定不变）

```go
package runner

// EmitFunc 把一行输出推到前端。stream 为 "stdout" 或 "stderr"。
type EmitFunc func(stream string, line string)

// Runner 是执行单元。Phase 1 唯一实现是 ShellRunner。
// 接口为 Phase 2/3/4 预留扩展点，本身不再改。
type Runner interface {
    Run(ctx context.Context, params map[string]any, emit EmitFunc) Result
}

type Result struct {
    ExitCode int
    Err      error
    Duration time.Duration
}
```

设计要点：
- `params` Phase 1 传 `nil`，接口里留着是 Phase 3（参数表单）的伏笔。
- `emit` 让 Runner 把每行输出外推，**Runner 不耦合 Wails 事件系统**——单测时 emit 写进一个 slice 即可验证。
- `ctx` 贯穿，承载超时与取消。

### 3.2 Command 结构（shell + script 二选一）

```go
type Command struct {
    Shell   string            `yaml:"shell"`   // 形态 A：内联命令字符串
    Script  string            `yaml:"script"`  // 形态 B：脚本文件路径（不带扩展名）
    Cwd     string            `yaml:"cwd"`     // 工作目录，默认 $HOME
    Timeout string            `yaml:"timeout"` // duration 字符串，默认 "60s"
    Env     map[string]string `yaml:"env"`     // 追加到现有环境变量
}
```

校验规则：`shell` 和 `script` **二选一**，都不填或都填报错。

**形态 A — `shell`（内联命令）**：
传给 `sh -c`（macOS/Linux）或 `cmd /c`（Windows）的字符串。支持 `&&` / `;` / `|` / 多行。适合 1~3 条紧耦合、跨平台语法一致的命令。

**形态 B — `script`（脚本文件）**：
不带扩展名的路径，先做 `${VAR}` 替换。替换后若为绝对路径直接用；若为相对路径，**相对 exe 目录解析**（与 `actions/` 同基准）。ShellRunner 按当前 OS 自动选文件后缀：
- macOS/Linux：`<script>.sh` → 用 `sh` 执行
- Windows：`<script>.ps1` → 用 `pwsh`（回退 `powershell`）执行

**一份 YAML 动作定义覆盖两平台**，复杂逻辑和平台差异各写各的脚本，不破坏单一动作原则。已有 `.sh`/`.ps1` 脚本可直接挂用，符合"开箱即用"。

### 3.3 YAML Schema 字段规范

| 字段 | 类型 | 必需 | 默认 | 约束 / 说明 |
|------|------|:----:|------|------------|
| `id` | string | ✅ | — | `^[a-z0-9-]+$`，全局唯一，事件通道名靠它 |
| `title` | string | ✅ | — | 按钮显示文字 |
| `icon` | string | ❌ | 空 | 一个 emoji |
| `description` | string | ❌ | 空 | 悬停提示 |
| `command` | object | ✅ | — | 命令定义块 |
| `command.shell` | string | 二选一 | — | 内联命令，支持 `${VAR}` 替换 |
| `command.script` | string | 二选一 | — | 脚本文件路径（不带扩展名） |
| `command.cwd` | string | ❌ | `$HOME` | 工作目录，必须存在否则报错 |
| `command.timeout` | duration | ❌ | `60s` | `time.ParseDuration` 解析（`30s`/`2m`/`1h`） |
| `command.env` | map\<string,string\> | ❌ | 空 | 追加到现有环境之上，不覆盖整盘 |

**变量替换规则**（Phase 1）：`${VAR}` 仅从**环境变量**解析，统一适用于 `shell` / `script` / `cwd` 三个字符串字段。未定义的 `${VAR}` 保留原样并在启动时记一条 warning（不报错——为 Phase 3 `params` 预留同一替换上下文）。

### 3.4 Registry 加载机制

启动时扫描 **exe 同级** `./actions/*.yaml` → 逐个解析为 `ActionDef` → 存入内存 `map[id]ActionDef`。
前端 `ListActions()` 返回该列表渲染按钮。

边界处理：
- **重复 id**：报错，保留先解析的，后者跳过。
- **解析失败的文件**：跳过，收集错误。坏动作在前端列表里灰掉并标错因，不影响其他动作。
- **`actions/` 目录缺失**：启动时 warning，UI 提示"无动作"，不崩。

> 把 `actions/` 放在 exe 同级，使用者拿到 exe + `actions/` 文件夹就能加动作——这是"零执行成本"的关键。

### 3.5 数据流（点按钮 → 看到输出）

```
[用户点按钮]
  → 前端调用 RunAction(id)                       [Wails binding]
  → API 层从 Registry 取 ActionDef
  → 构造 ShellRunner + ctx(带 timeout)
  → Runner.Run → exec.Command("sh","-c",cmd)     (Win: cmd /c 或 pwsh script.ps1)
  → goroutine 读 StdoutPipe / StderrPipe
  → 每行 emit → runtime.EventsEmit("action:{id}:output", {stream, line})
  → 前端 EventsOn 订阅 → 追加到输出面板
  → 结束 → emit "action:{id}:done" 事件 + 返回 Result
```

Wails 事件总线是这套设计的"血管"：`exec` 管道输出实时流到前端。

### 3.6 跨平台执行对照

| OS | `shell` 形态 | `script` 形态 |
|----|-------------|--------------|
| macOS / Linux | `sh -c "<shell>"` | `sh <script>.sh` |
| Windows | `cmd /c "<shell>"` | `pwsh -File <script>.ps1`（回退 `powershell`） |

### 3.7 错误处理

| 场景 | 处理 |
|------|------|
| YAML 解析失败 | 跳过该动作，列表标灰显示错因 |
| `cwd` 不存在 | 不跑，返回错误，UI 提示 |
| `shell`/`script` 都填或都不填 | 加载时报错 |
| 命令 `exit != 0` | UI 标红 + 显示 stderr，`Result.ExitCode` 记录 |
| 超时 | `ctx` 触发 → `Process.Kill()`，`Result.Err` 标 timeout |
| 用户取消 | 前端"停止"按钮 → `CancelAction(id)` → `ctx.Done()` → `Process.Kill()` |
| `script` 指定文件在当前 OS 不存在 | 报错（如 mac 上只放了 `.ps1`） |

### 3.8 并发策略

同一 action **单实例锁**：正在跑时拒绝再次触发（前端按钮置灰）。
理由：Phase 1 简化，避免多个同类输出流串台。不同 action 之间互不阻塞。

### 3.9 测试策略

| 层 | 测什么 | 怎么测 |
|----|--------|--------|
| ShellRunner | 成功·失败·超时·取消·stdout/stderr 分流 | 用 `echo`/`exit 1`/`sleep`，emit 写进 slice 断言 |
| Registry | 好文件解析、坏文件跳过、重复 id 报错 | 临时目录造测试 YAML |
| API/事件流 | emit 顺序、事件名正确 | 事件 recorder 替代前端 |

验收标准：三层测试全绿才能算 Phase 1 完成。

---

## 4. 明确不做（YAGNI）

Phase 1 **不包含**以下能力，避免过度设计：
- `steps` / 多步骤编排 → Phase 2
- `params` / 参数输入表单 → Phase 3
- `when` / `depends_on` / 条件分支 → Phase 4
- 动作热重载（改 YAML 要重启）→ 后续可加 fsnotify
- 执行历史持久化（仅内存态当前运行）→ 后续
- 用户配置 / 主题切换 → 后续
- 内嵌脚本块（YAML 里直接写多行 Go/python）→ 用 `script` 文件足够

---

## 5. 项目结构（Phase 1 预期）

```
workflow-tool/
├── docs/specs/              # 设计文档（本文件）
├── actions/                 # 动作定义（使用者可编辑/新增）
│   └── *.yaml
├── scripts/                 # 脚本文件（command.script 引用）
│   ├── *.sh                 # macOS/Linux
│   └── *.ps1                # Windows
├── frontend/                # Wails 前端（Web UI：按钮列表 + 输出面板）
├── internal/
│   ├── runner/              # Runner 接口 + ShellRunner 实现
│   ├── registry/            # YAML 扫描、解析、校验
│   └── api/                 # Wails 绑定层（ListActions/RunAction/CancelAction）
├── main.go                  # Wails app 入口
├── go.mod
├── wails.json
└── README.md
```

---

## 6. 验收标准（可验证的完成）

- [ ] exe 启动后扫描 `actions/` 渲染按钮列表
- [ ] 点击按钮，命令执行，stdout/stderr 实时流式显示
- [ ] 超时正确终止进程，UI 标注 timeout
- [ ] "停止"按钮能取消正在运行的 action
- [ ] `shell` 和 `script` 两种形态都能正确执行
- [ ] `script` 按 OS 正确选择 `.sh` / `.ps1`
- [ ] 跨平台编译：macOS 和 Windows 各出一份二进制
- [ ] Runner / Registry / API 三层测试通过
- [ ] 把 exe + `actions/` + `scripts/` 拷到另一台无 Go 环境的机器能直接跑

---

## 附：动作定义示例

```yaml
# actions/scrape-to-md.yaml
id: scrape-to-md
title: 抓网页转 Markdown
icon: 🌐
description: 把 URL 正文抓成 Markdown 存到本地
command:
  shell: defuddle-cli convert "${URL}" -o "${OUTPUT_DIR}/${NAME}.md"
  cwd: ${OUTPUT_DIR}
  timeout: 90s
  env:
    USER_AGENT: "Mozilla/5.0"
```

```yaml
# actions/deploy.yaml —— script 形态，跨平台
id: deploy
title: 部署
icon: 🚀
command:
  script: ./scripts/deploy
  cwd: ${PROJECT_DIR}
  timeout: 5m
```
