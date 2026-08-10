# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目

Workflow Tool：基于 **Wails v3 (alpha2.119) + Go** 的桌面工具。用 YAML 定义「动作」与「工作流」，前端按钮触发，实时流式输出，编译为跨 macOS/Windows 单二进制。

## 关键命令

构建（已封装为 `deploy/` 脚本，Windows 用 Git Bash，跨 macOS/Linux）：
```bash
bash deploy/build.sh        # 一键全量：前端 → bindings → 单二进制（平台自适应）
bash deploy/frontend.sh     # 仅前端（依赖缺则 npm install；bindings 缺则自动生成）
bash deploy/backend.sh      # 仅后端（bindings + go build；Windows 自动 windowsgui + taskkill 释放占用）
```

构建**顺序不能乱**——前端产物 embed 进二进制，binding 由 api.go 生成（脚本已按此顺序编排）：
```bash
cd frontend && npm install && npm run build && cd ..    # 1. 产出 frontend/dist/（前端 import bindings，故 bindings 须先就绪）
wails3 generate bindings                                 # 2. 改 api.go 后必须重跑，否则前端 method ID 不匹配
go build -ldflags "-H windowsgui" -o workflow-tool.exe . # 3. -H windowsgui 仅 Windows，隐藏控制台
```

详见 [deploy/README.md](deploy/README.md)。

测试：
```bash
go test ./internal/runner ./internal/registry ./internal/workflow   # 核心包单测（不依赖 Wails）
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
internal/runner/    执行单元（纯 Go，可单测，不依赖 Wails）：ShellRunner / SleepRunner
internal/adbcore/   adb 域子进程治理：RunCommand/RunStreaming/RunCommandWithStdin + errors + validation
                    （自包含，复用 runner 的 pgid/hide 逻辑，不依赖 Wails）
internal/adb/       adb 域框架：ADBRunner（实现 runner.Runner）+ operation 自注册路由表 + OpContext
  ├── binary/       adb/fastboot/scrcpy 路径探测级联（config→PATH→常见路径，仅探测不下载）
  ├── device/       设备列表/信息/模式/wireless + 激活 serial 解析
  ├── package/      包管理 9 operations（install/uninstall/list/enable/disable/clear/force-stop/pull-apk/details）
  ├── logcat/       结构化 logcat 2 operations（stream/batch，Go 端 threadtime 解析 + 过滤）
  ├── file/         文件传输 10 operations（push/pull/多文件/list/mkdir/delete/rename/size/storage，进度+重试+取消）
  └── scrcpy/       scrcpy 6 operations（start/record-start/record-stop/clipboard-set/get/screenshot）
internal/registry/  扫 actions/*.yaml 解析校验 + config.yaml 全局配置 + fragments.yaml 片段
internal/workflow/  扫 workflows/*.yaml 加载校验 + Executor 串行执行 steps
internal/api/       Wails Service 绑定 + 事件 emit（唯一依赖 Wails 的包）
```

- **runner.Runner** 接口 `Run(ctx, params, emit) Result` 是稳定扩展点。当前实现 `ShellRunner`（按 OS 构造 `exec.Cmd`，Windows 用 PowerShell/pwsh，其他用 `sh -c`，逐行 `emit` stdout/stderr）与 `SleepRunner`（workflow sleep step）。`stream: "llm"` 时 stdout 改走 `pumpLLM`（`llm.go`），解析 claude stream-json，只把 assistant 的 text / thinking 增量 emit 为 `"llm"` / `"llm-thinking"`。
- **adb 域**：`command.adb.operation` 形态由 `adb.ADBRunner`（实现同一 `Runner` 接口）处理。`api.execute` 按 `command.shell`/`script`/`adb.operation` 三选一选型。ADBRunner 解析设备 serial（params `ADB_SERIAL` 或 `device.ResolveActive`）+ 二进制路径（config 覆盖→PATH→常见路径），构造 `OpContext` 后按 `operation` 查路由表分发到域 handler。**各域子包（package/logcat/file/scrcpy）在自己的 `init()` 中调 `adb.RegisterOperation` 自登记，`main.go` blank-import 触发登记；新增 operation 不需改 `internal/adb/runner.go` 共享文件。** 输出走与 shell 动作完全相同的 `action:<id>:output` 通道；文件传输进度发 `stream:"progress"`。
- **变量替换**在**运行时**由 `runner.Expand` 完成（不在 registry 加载时）。优先级：动作参数 > 全局配置(config.yaml) > 环境变量；未命中保留 `${VAR}` 原样 + warning。
- **workflow.Executor** 串行执行 workflow 的 steps（action / inline shell / sleep 三选一），支持 `retry` 和 `continue_on_error`。step 边界 emit `step-start` / `step-done` 事件。执行 action step 时通过回调查 registry 合并 params 构造 ShellRunner。
- **api.Service** 通过 `SetApp` 在 `main.go` 注入 app 引用（打破循环依赖）。`RunAction` 起 goroutine 执行，输出经事件 `action:<id>:output` 推送、结束发 `action:<id>:done`。同一动作并发运行被拒。
- **exe 目录约定**：`main.go` 的 `exeDir()` 用 exe 所在目录扫描同级 `actions/`、`workflows/`、`config.yaml`、`fragments.yaml`；dev 时回退当前工作目录（项目根）。所以运行 exe 必须和这些文件同级。

前端（`frontend/src/`，React 19 + TS + Vite + tailwind4 + base-ui/shadcn）：`ActionRunnerProvider` 是唯一状态中枢，`ListActions` 拉动作、`Events.On` 订阅输出事件、`view` 在 output/form/global/llm/logcat/workflow/fragments 间切。`DeviceSelector`（挂 `AppSidebar` SidebarHeader）调 `ListDevices`/`SetActiveDevice` 选激活设备，后端是激活 serial 唯一真相、运行 adb 动作时自动注入 `${ADB_SERIAL}`。binding 从 `frontend/bindings/`（`wails3 generate bindings` 产物，ES module）导入。UI 优先复用 `components/ui/` 下的 shadcn 原子（Badge / IconButton 等），避免手写重复样式。

## 动作 YAML（actions/*.yaml）

`id`（`^[a-z0-9-]+$` 全局唯一）+ `title` 必填；`command.shell` 与 `command.script` 与 `command.adb.operation` 三选一互斥必选其一。`script` 路径不含扩展名，按 OS 自动加 `.sh`/`.ps1`，相对路径基于 exe 目录。`command.adb` 是第三种形态：写 `command.adb.operation: <域操作名>`，由内置 ADBRunner 分发到 adb 域服务（27 个 operation：包管理/logcat/文件传输/scrcpy），各 operation 的 params 契约见 [docs/action.md](docs/action.md)。`command.stream` 只允许 `""` / `"llm"` / `"logcat"`（`"logcat"` 为 adb logcat-stream 域专用，前端切 logcat 视图）。`params`（type: text|bool|select|path，select 必带 options）驱动前端表单；`presets` 是作者预设的整套参数值。可选 `icon`：写 `hi:<key>`（key 见 `frontend/src/components/ActionIcon.tsx` 注册表）渲染 hugeicons 矢量图标，或直接写 emoji/文本（原样显示，向后兼容）。校验逻辑在 `registry.validate`。

`command` 新增可选 `capture_output`（布尔，默认 true；false 关闭全量 stdout/stderr 捕获，长跑/持续输出 action 如 scrcpy/logcat 用）。

完整字段文档：[docs/action.md](docs/action.md)。

## 工作流 YAML（workflows/*.yaml）

`id` + `title` + `steps` 必填。每个 step 三选一：`action`（引用已有 action id，可用 `params` 覆盖参数）、`shell`（内联 shell 命令，可选 `timeout`）、`sleep`（等待 N 秒）。可选 `id`（步骤标识，供 outputs/if 引用，未写用索引兜底——**索引兜底键 `"0"`/`"1"` 需 bracket 语法引用：`steps["0"].outputs.exit_code`，expr 点语法不接受数字开头的键**）、`name`（Pipeline Spine 显示文案）、`if`（expr 表达式条件，false → SKIPPED）、`env`（step 级环境变量）、`capture_output`（默认 true）、`retry`（失败重试次数）、`continue_on_error`（失败不中断后续步骤）。workflow 可自带顶层 `env`（注入所有 step，优先级低于 params 高于 config.yaml）与 `params`（同 action 的 ParamSpec，`id` 不可用 `steps`/`env`/`params`/`config` 保留字）。每个 step 执行完自动产出 `outputs`（exit_code/stdout/stderr/success，脚本可用 `##[output key=value]` 追加自定义 key），供后续 step 通过 `${{ steps.<id>.outputs.<key> }}` 或 `if` 表达式引用。校验逻辑在 `workflow.Validate`。

完整字段文档：[docs/workflow.md](docs/workflow.md)。

## 片段 YAML（fragments.yaml）

`fragments: [{title, content, tags}]`，UI 侧「片段」视图按 tag 分组浏览、内容支持 `${VAR}` 展开预览、一键复制。CRUD 在前端编辑后由后端写回 YAML。

## 改动注意

- 改 `internal/api/api.go` 的 Service 方法签名/类型后，**必须** `wails3 generate bindings` → `npm run build` → `go build`（或直接 `bash deploy/build.sh`），否则前端调用报 "method ID not found"。
- 锁定 Wails `v3.0.0-alpha2.119`（CLI 与库同版本），**不要升到 alpha.3**（绑定机制损坏）。
- 新增前端静态文案只改 `frontend/src/i18n/locales/{zh,en}.json`；动作 `title/description` 与后端 stdout/stderr 不参与 i18n。
- 前端组件优先复用已装 shadcn 原子（`components/ui/` 下 25 个）；`IconButton` 是项目封装（Button + Tooltip + aria-label），需要图标按钮时优先用它，避免重新手写 `<button>` + tailwind。
- 修改 action / workflow 的 **YAML schema**（字段增删改、校验逻辑变动）后，**必须同步更新** `docs/action.md` 和 `docs/workflow.md`——这两份文档是面向使用者的完整字段参考，schema 改了文档不跟等于挖坑。
