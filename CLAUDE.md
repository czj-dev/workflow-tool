# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目

Workflow Tool：基于 **Wails v3 (alpha2.119) + Go** 的桌面工具。用 YAML 定义「动作」，前端按钮触发，实时流式输出，编译为跨 macOS/Windows 单二进制。

## 关键命令

构建（**顺序不能乱**——前端产物 embed 进二进制，binding 由 api.go 生成）：
```bash
cd frontend && npm install && npm run build && cd ..   # 产出 frontend/dist/
wails3 generate bindings                                # 改 api.go 后必须重跑，否则前端 method ID 不匹配
go build -ldflags "-H windowsgui" -o workflow-tool.exe . # -H windowsgui 仅 Windows，隐藏控制台
```

测试：
```bash
go test ./internal/runner ./internal/registry           # 核心包单测（不依赖 Wails）
go test -race ./...                                      # 带竞态检测
go test ./internal/runner -run TestExpand                # 单个测试
cd frontend && npm test                                  # 前端 vitest
cd frontend && npm run lint && npm run typecheck         # 前端 lint / 类型检查
```

调试 Go 侧日志：临时 `go build -o workflow-tool.exe .`（不加 `-H windowsgui`）会弹控制台显示 `log`/`fmt` 输出；发布再换回带 ldflags 的版本。

前端 `npm run dev` 只能调样式——`Call.ByID` 仅 Wails 运行时可用，纯 dev server 调不到后端，联调必须 `go build` 跑 exe。

## 架构

三层，`Runner` 接口稳定不变，所有功能扩展落在 YAML schema 与编排层：

```
internal/runner/    执行单元（纯 Go，可单测，不依赖 Wails）
internal/registry/  扫 actions/*.yaml 解析校验 + config.yaml 全局配置
internal/api/       Wails Service 绑定 + 事件 emit（唯一依赖 Wails 的包）
```

- **runner.Runner** 接口 `Run(ctx, params, emit) Result` 是稳定扩展点。当前唯一实现 `ShellRunner`：按 OS 构造 `exec.Cmd`（Windows 用 PowerShell/pwsh，其他用 `sh -c`），逐行 `emit` stdout/stderr。`stream: "llm"` 时 stdout 改走 `pumpLLM`（`llm.go`），解析 claude stream-json，只把 assistant 的 text / thinking 增量 emit 为 `"llm"` / `"llm-thinking"`。
- **变量替换**在**运行时**由 `runner.Expand` 完成（不在 registry 加载时）。优先级：动作参数 > 全局配置(config.yaml) > 环境变量；未命中保留 `${VAR}` 原样 + warning。
- **api.Service** 通过 `SetApp` 在 `main.go` 注入 app 引用（打破循环依赖）。`RunAction` 起 goroutine 执行，输出经事件 `action:<id>:output` 推送、结束发 `action:<id>:done`。同一动作并发运行被拒。
- **exe 目录约定**：`main.go` 的 `exeDir()` 用 exe 所在目录扫描同级 `actions/`、`config.yaml`；dev 时回退当前工作目录（项目根）。所以运行 exe 必须和 `actions/` 同级。

前端（`frontend/src/`，React 19 + TS + Vite + tailwind4 + base-ui/shadcn）：`ActionRunnerProvider` 是唯一状态中枢，`ListActions` 拉动作、`Events.On` 订阅输出事件、`view` 在 output/form/global/llm 间切。binding 从 `frontend/bindings/`（`wails3 generate bindings` 产物，ES module）导入。

## 动作 YAML（actions/*.yaml）

`id`（`^[a-z0-9-]+$` 全局唯一）+ `title` 必填；`command.shell` 与 `command.script` 互斥必选其一。`script` 路径不含扩展名，按 OS 自动加 `.sh`/`.ps1`，相对路径基于 exe 目录。`command.stream` 只允许 `""` 或 `"llm"`。`params`（type: text|bool|select|path，select 必带 options）驱动前端表单；`presets` 是作者预设的整套参数值。校验逻辑在 `registry.validate`。

## 改动注意

- 改 `internal/api/api.go` 的 Service 方法签名/类型后，**必须** `wails3 generate bindings` → `npm run build` → `go build`，否则前端调用报 "method ID not found"。
- 锁定 Wails `v3.0.0-alpha2.119`（CLI 与库同版本），**不要升到 alpha.3**（绑定机制损坏）。README 底部有 alpha2 API 速查表。
- 新增前端静态文案只改 `frontend/src/i18n/locales/{zh,en}.json`；动作 `title/description` 与后端 stdout/stderr 不参与 i18n。
