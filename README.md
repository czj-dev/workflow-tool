# Workflow Tool

一键触发命令/脚本/多步骤工作流/AI 任务的桌面工具。基于 **Wails v3 + Go + React**，YAML 声明动作、工作流与 AI 任务，按钮触发，实时流式输出，编译为跨 macOS / Windows 单二进制。

## 核心特性

- **YAML 驱动**：在 `actions/` 放一个 `.yaml` 即新增一个动作，零代码；`workflows/`、`ai/` 同理新增工作流与 AI 任务
- **卡片网格**：动作、工作流、AI 任务三类双态卡（紧凑态 / 展开态），悬停看描述，长按卡头图标展开预设环快选，带使用留痕与卡片氛围色
- **表单装配台**：声明 `params`（text / bool / select / path）自动渲染装配式表单；presets 一键填入或直跑
- **多步骤工作流**：`workflows/` 定义串行 step（引用 action / 内联 shell / sleep / AI 任务），支持 retry、continue_on_error、`if` 条件跳过与步骤 outputs（`${{ }}`）引用
- **定时调度**：`schedules.yaml` 用 5 段 cron（分钟粒度）定时运行动作、工作流或 AI 任务，调度面板可增删、启停、立即运行；目标正忙时到点记为跳过而不是失败；调度器跑在应用进程内，应用须在到点时运行，到点后把运行交给独立执行器（应用退出后照常跑完，重启后认领）；应用没在运行时溜走的到点记为错过，可选 `catch_up` 补跑
- **运行记录**：每次运行（手动、调度、立即运行）都在 `runs/` 留下结论与可回放的输出日志，运行记录列表可按目标、状态、来源筛选，运行详情回放过程（AI 运行还原成工序段）、停止运行中的记录，AI 运行可一键续跑
- **AI 任务**：`ai/` 下的 YAML 把「意图 + 输入」交给 pi（唯一 AI 运行器，OpenAI 兼容端点经用户级 `~/.workflow-tool/auth.json` 三键 `AI_BASE_URL` / `AI_AUTH_KEY` / `AI_MODEL` 配置——设置页「Agent」分类编辑，0600 落盘不随包分发，ADR-0008）执行；聊天式会话页 + 工序轨道面板透出思考与工具调用，历次运行留档可查，支持 `resume` 续接会话，也可作为工作流的一步或被调度定时运行
- **设备选择器**：adb 设备下拉选择，展开即刷新列表
- **内置 YAML 编辑器**：CodeMirror 6，Action / Workflow / AI 任务卡片标题直达编辑
- **adb 域 operation**：install / push 走 PTY 实时进度，input-text 支持中文（ADBKeyboard 输入法广播），foreground-info 前台信息三段展示
- **全局变量**：`config.yaml` 定义跨动作共享变量，`${VAR}` 语法在运行时替换
- **指令片段**：`fragments.yaml` 存储可复用文本片段，Tag 分类 + 变量展开 + 一键复制
- **跨平台**：macOS / Windows 单二进制，无运行时依赖
- **中英文 i18n**：界面静态文案支持切换

## 前置依赖

| 工具 | 版本 | 说明 |
|------|------|------|
| Go | 1.25+ | 后端编译（go.mod 锁 1.25.0） |
| Node.js | 20.19+ 或 22.13+ | 前端构建（Vite 8 与 ESLint 10 的下限，24 亦可） |
| Wails CLI | `v3.0.0-alpha2.119` | 绑定生成 + 构建 |

安装 Wails CLI：
```bash
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.119
```

国内 Go 代理（可选）：
```bash
go env -w "GOPROXY=https://mirrors.aliyun.com/goproxy/,direct"
go env -w "GOSUMDB=sum.golang.google.cn"
```

## 构建

### 一键构建（推荐）

```bash
bash deploy/build.sh       # bindings → 前端 → 单二进制（平台自适应）
```

### 分步构建

```bash
bash deploy/frontend.sh    # 仅前端（自动 npm install + 生成 bindings）
bash deploy/backend.sh     # 仅后端（bindings + go build）
```

### 手动构建

```bash
# 1. 生成绑定（frontend/bindings/ 不入库，新克隆后必须先生成；改 api.go 后必须重跑）
wails3 generate bindings

# 2. 前端
cd frontend && npm install && npm run build && cd ..

# 3. 编译
# macOS:
go build -o workflow-tool .
# Windows:
go build -ldflags "-H windowsgui" -o workflow-tool.exe .
```

> **顺序不能乱**：前端 import bindings，前端产物又 embed 进二进制，所以是 bindings → 前端 → 编译。

## 运行

可执行文件须与 `actions/` 目录同级（启动时扫描同级 `actions/*.yaml` + `workflows/*.yaml` + `ai/*.yaml`）：

```bash
./workflow-tool        # macOS
workflow-tool.exe      # Windows 双击
```

## 动作定义（actions/*.yaml）

```yaml
id: my-action              # ^[a-z0-9-]+$ 全局唯一
title: 我的动作
icon: hi:play              # hugeicons 图标 key，或 emoji
description: 可选描述
command:
  run: echo hello           # 与 script / adb.operation 三选一
  # script: ./scripts/foo.sh  # 形态 B：脚本文件，扩展名决定解释器（.sh / .ps1 / .py / .js）
  cwd: ${SOME_DIR}         # 可选，不写则继承应用进程的工作目录
  timeout: 60s
  stream: ""               # "" 普通输出 | "logcat" 结构化日志视图
  env:
    KEY: value
params:
  - id: URL
    label: 网址
    type: text             # text | bool | select | path | file | textarea | list | arguments
    required: true
presets:
  - name: 首页
    values: { URL: https://example.com }
```

变量替换优先级：**`command.env` > 动作参数 > 全局配置 > 内置变量 > 环境变量**（同名时靠前的胜出）。

> 完整字段说明见 [Action 定义指南](docs/action.md)。

## 工作流定义（workflows/*.yaml）

```yaml
id: install-and-test
title: 安装后测试
icon: hi:workflow
steps:
  - action: adb-install         # 引用已有 action
  - sleep: 5                    # 等待 N 秒
  - action: adb-debug-activity
    params: { PAGE: main }      # 覆盖 action 参数
  - run: echo "done"            # 内联 shell
    timeout: 10s
    retry: 2
    continue_on_error: true
```

> 完整字段说明见 [Workflow 定义指南](docs/workflow.md)。

## AI 任务定义（ai/*.yaml）

```yaml
id: ai-bug-analyze
title: 分析 bug 卡片
system: |
  你是 bug 分析师，只基于取到的证据下结论。
prompt: |
  根据卡片 ${BUG_URL} 给出根因假设与验证命令。
params:
  - id: BUG_URL
    label: 卡片链接
    type: text
    required: true
timeout: 30m               # 默认 30m
```

工作流用 `ai: <任务 id>` 调用 AI 任务；CLI（`workflow-tool list|describe|run`）能列出、描述 AI 任务，运行默认被拒（`ai_blocked`），加 `--allow-ai` 显式放行。

> 完整字段说明见 [AI 任务定义指南](docs/ai.md)。

## 测试

```bash
# Go 核心包单测
go test ./internal/...

# 带竞态检测
go test -race ./...

# 前端
cd frontend && npm test
cd frontend && npm run lint && npm run typecheck
```

## 项目结构

```
workflow-tool/
├── actions/            动作定义 YAML
├── workflows/          工作流定义 YAML
├── ai/                 AI 任务定义 YAML
├── fragments.yaml      指令片段
├── config.yaml         全局变量配置
├── schedules.yaml      调度定义（cron → action / workflow / ai）
├── runs/               运行记录（运行时生成，不入仓库）
├── logs/               应用日志（运行时生成，不入仓库）
├── scripts/            脚本文件（.sh / .ps1）
├── internal/
│   ├── actionrun/      动作 → Runner 构造 + workflow step 回调
│   ├── adb/            adb 域 operation 子包（package / file / input / logcat / foreground / scrcpy…）
│   ├── adbcore/        跨平台进程基座（执行 / PTY / 进程组 / 校验）
│   ├── ai/             AI 任务 schema / 校验 / 加载
│   ├── airun/          AI 任务 → AIRunner 构造（输入合并 / 模板展开 / 守则 / pi 初始化 / skill 零拷贝）
│   ├── runner/         Runner 接口 + Shell/Sleep/AI Runner + 变量展开
│   ├── builtinvars/    内置变量（CURRENT_DATE / CURRENT_TIME / ADB_SERIAL）
│   ├── registry/       actions + config + fragments 加载校验
│   ├── workflow/       workflow 加载、校验、串行执行 + 表达式
│   ├── schedule/        调度：schedules.yaml 加载、cron 解析、进程内 Scheduler（目标三选一）、错过与补跑
│   ├── runstore/        运行记录：runs/<run-id>/ 的写入、查询与保留策略；执行器运行的认领与心跳
│   ├── procinfo/        进程身份核对（pid + 启动时刻）
│   ├── targetlock/      落盘的目标锁（同一目标跨进程只有一个运行）
│   ├── applog/          应用日志：logs/app.log（NDJSON，轮转）
│   ├── cli/            headless 子命令 list / describe / run，兼独立执行器
│   ├── apphome/         exe 目录约定与 baseDir 解析（main 与 cli 共用）
│   └── api/            Wails Service 绑定 + 事件推送（按域拆文件）
├── frontend/
│   ├── src/            React 19 + TS + Vite + Tailwind 4 + shadcn (base-ui)
│   ├── bindings/       wails3 generate bindings 产物
│   └── dist/           vite 构建产物（embed 目标）
├── deploy/             构建脚本（build.sh / frontend.sh / backend.sh）
├── docs/               文档（action.md / workflow.md / ai.md / runs.md / 截图 / 设计文档）
├── main.go             应用入口
└── go.mod
```

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Go 1.25 + Wails v3 alpha2.119 |
| 前端框架 | React 19 + TypeScript + Vite 8 |
| UI | Tailwind CSS 4 + shadcn/ui (base-ui 风格) + hugeicons |
| YAML 编辑器 | CodeMirror 6（@uiw/react-codemirror） |
| 状态 | ActionRunnerProvider（Context + Events） |
| i18n | react-i18next |
| AI 渲染 | streamdown + nexus-ui (Thread/Message/Reasoning) |

## 注意事项

- 锁定 Wails `v3.0.0-alpha2.119`，**不要升到 alpha.3**（绑定机制损坏）
- 改 `internal/api/`（绑定导出方法）后必须重新生成 bindings
- `npm run dev` 仅能调样式，联调后端须 `go build` 跑 exe
- 新增前端文案只改 `frontend/src/i18n/locales/{zh,en}.json`
