# Workflow Tool

一键触发命令/脚本的桌面 workflow 工具，基于 **Wails v3 + Go**。YAML 定义动作，按钮触发，实时流式输出，跨 macOS/Windows 单二进制分发，使用者无需装运行时。

## 状态

**Phase 1（MVP）完成并验证。**

| 能力 | 状态 |
|------|------|
| 按钮列表（YAML 加载） | ✅ |
| shell 命令执行 + 实时输出 | ✅ |
| script 脚本执行 + 跨平台（.sh/.ps1） | ✅ |
| 超时 / 取消 | ✅ |
| 单二进制跨平台分发 | ✅ |
| 前端（React+TS+shadcn 双栏 UI + 中英 i18n） | ✅ |
| 参数表单 / 多步骤 / 条件分支 | Phase 2/3/4 |

- 设计文档：`docs/specs/2026-07-28-phase1-design.md`
- 实现计划：`docs/superpowers/plans/2026-07-28-phase1.md`

## 架构

```
Web UI（按钮 + 输出面板）
        ↕  Wails 绑定 + 事件
API 层（api.Service: ListActions / RunAction / CancelAction）
        ↓
Registry（扫 actions/*.yaml）  →  Runner（ShellRunner: shell / script）
```

三层：`runner`（执行单元，纯 Go）→ `registry`（YAML 加载）→ `api`（Wails service 绑定）。`Runner` 接口为 Phase 2/3/4 预留扩展点，Phase 1 不变。

## 前置

- **Go 1.22+**（开发用 1.26.5）
- **Wails v3 CLI**：`go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.119`
- **Node.js**（前端构建）

国内 Go 代理（避免拉模块失败）：
```bash
go env -w "GOPROXY=https://mirrors.aliyun.com/goproxy/,direct"
go env -w "GOSUMDB=sum.golang.google.cn"
```

## 构建

```bash
# 1. 前端依赖 + 构建（产出 frontend/dist/）
cd frontend
npm install
npm run build

# 2. 生成 service bindings（改 api.go 后必须重跑，否则前端 method ID 不匹配）
cd ..
wails3 generate bindings

# 3. 编译 exe（embed frontend/dist）
go build -o workflow-tool.exe .
```

> `frontend/dist/` 是构建产物（`.gitignore` 忽略）；`frontend/bindings/` 由 `wails3 generate bindings` 生成。

## 运行

双击 `workflow-tool.exe`（须和 `actions/` 同级——exe 启动时扫描同级 `actions/*.yaml`）。

内置示例动作：
- **👋 打个招呼**：`shell` 形态，`echo`，开箱可用
- **🚀 部署**：`script` 形态，跑 `scripts/deploy.sh`（Mac/Linux）或 `scripts/deploy.ps1`（Windows）
- **🌐 抓网页转 Markdown**：参数化（需 `URL`/`OUTPUT_DIR` + `defuddle-cli`），属 Phase 3 场景

## 加一个动作

在 `actions/` 放 YAML：

```yaml
id: my-action              # 必需，^[a-z0-9-]+$，全局唯一
title: 我的动作             # 必需，按钮文字
icon: 🚀                   # 可选，emoji
description: 悬停提示       # 可选
command:
  shell: echo hello          # 形态 A：内联命令（与 script 二选一）
  # script: ./scripts/foo    # 形态 B：脚本文件（按 OS 自动加 .sh / .ps1）
  cwd: ${SOME_DIR}           # 可选，默认用户主目录
  timeout: 60s               # 可选，默认 60s
  env:                       # 可选，追加到现有环境
    KEY: value
```

`${VAR}` 从环境变量替换（未定义保留原样 + 友好报错）。重启 exe 生效。

完整字段见设计文档 §3.3。

## 界面语言（i18n）

界面静态文案走 `frontend/src/i18n/locales/{zh,en}.json`，默认中文，工具栏可切换中/EN，选择写入 localStorage、重启后记住。新增文案只改这两个 JSON。

> 边界：动作 `title/description/icon`（用户 YAML 自定义）、后端 emit 的报错与 stdout/stderr 输出**不参与翻译**，保持原样。

## 项目结构

```
workflow-tool/
├── actions/          动作定义 YAML（使用者编辑）
├── scripts/          script 形态引用的脚本（.sh / .ps1）
├── internal/
│   ├── runner/       Runner 接口 + ShellRunner（纯 Go，可单测）
│   ├── registry/     YAML 扫描 / 解析 / 校验（纯 Go）
│   └── api/          Wails service 绑定 + 事件 emit
├── frontend/
│   ├── index.html          Vite 入口（挂载点 #root）
│   ├── package.json        React 19 + TS + Vite + shadcn/ui + react-i18next
│   ├── src/                React 源码（App、components、context、hooks、i18n、types）
│   │   └── components/ui/  shadcn 组件源码（内嵌，base-ui 风格）
│   ├── dist/               vite 构建产物（embed 目标，gitignore）
│   └── bindings/           wails3 generate bindings 产物（ES module）
├── docs/             spec + plan
├── main.go           应用入口
├── go.mod / go.sum
└── README.md
```

## Wails v3 alpha2 API 速查（踩坑记录）

> ⚠️ 官方文档对应最新 alpha，**不要用 v3.0.0-alpha.3**——它的绑定机制是坏的（`Bind []any` + 旧式全局 bindings，method ID 和后端不同步，前端调用报 "method ID not found"）。本项目锁定 **`v3.0.0-alpha2.119`**（CLI 与库同版本）。

| 关注点 | alpha2.119 正确写法 |
|--------|---------------------|
| service 注册 | `Services: []application.Service{application.NewService(svc)}` |
| 事件 emit | `app.Event.Emit(name, data...)`（单数 `Event`，variadic） |
| 静态资源 | `Assets: application.AssetOptions{Handler: application.AssetFileServerFS(distFS)}`，其中 `distFS, _ := fs.Sub(assets, "frontend/dist")` |
| 创建窗口 | `app.Window.NewWithOptions(application.WebviewWindowOptions{...})` |
| service 拿 app 引用 | main 里 `application.New` 之后 `svc.SetApp(app)` 注入（打破循环依赖） |
| 前端调用 service | `import { ListActions } from './bindings/<pkg>/service.js'`（ES module，自动生成，`Call.ByID`） |
| 前端监听事件 | `import { Events } from '@wailsio/runtime'; Events.On(name, cb)`；回调里取 `e.data` |
| 生成 bindings | `wails3 generate bindings` → 输出 `frontend/bindings/`；**改 api.go 后必须重跑** |

## 路线图

| Phase | 能力 | 实现方式 | 接口变化 |
|-------|------|---------|---------|
| **1（已完成）** | 单命令/脚本一键触发 | ShellRunner + Registry | 定下 Runner 接口 |
| 2 | 多步骤串行 | WorkflowRunner 编排多个 Runner | 无（新加 Runner 实现） |
| 3 | 参数输入表单 | YAML `params` → 前端动态表单 | 无（params 字段启用） |
| 4 | 条件分支 | YAML `when` / `depends_on` | 无 |

`Runner` 接口稳定不变，所有扩展在 YAML schema 和编排层。

## 开发提示

- 改 `api.go` 后：`wails3 generate bindings` → `npm run build` → `go build`（顺序不能乱）
- 改前端：`cd frontend && npm run build && cd .. && go build`。单独 `npm run dev` 可调样式，但联调后端必须 `go build` 跑 exe（`Call.ByID` 仅 Wails 运行时可用，纯前端 dev server 调不到后端）；前端单测 `cd frontend && npm test`
- 核心包单测（不依赖 Wails）：`go test ./internal/runner ./internal/registry`
- 交叉编译 Mac：`GOOS=darwin GOARCH=arm64 go build -o workflow-tool .`（需 Mac 上 CGO/WebKit 依赖）
