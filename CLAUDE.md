# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目

Workflow Tool：基于 **Wails v3 (alpha2.119) + Go** 的桌面工具。用 YAML 定义「动作」与「工作流」，前端按钮触发，实时流式输出，编译为跨 macOS/Windows 单二进制。

## 关键命令

构建（已封装为 `deploy/` 脚本，Windows 用 Git Bash，跨 macOS/Linux）：
```bash
bash deploy/build.sh        # 一键全量：前端 → bindings → 单二进制（平台自适应）
bash deploy/frontend.sh     # 仅前端（总是 npm install 同步依赖；bindings 自动生成）
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
go test ./internal/runner ./internal/registry ./internal/workflow ./internal/actionrun   # 核心包单测（不依赖 Wails）
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
  ├── foreground/   前台信息 1 operation（foreground-info：前台 Activity/焦点窗口多 display 分组/View 树格式化报告，纯函数解析+排版）
  ├── input/        文本输入 1 operation（input-text：ASCII 走 input text，非 ASCII 剪贴板桥）
  ├── package/      包管理 9 operations（install/uninstall/list/enable/disable/clear/force-stop/pull-apk/details）
  ├── logcat/       结构化 logcat 2 operations（stream/batch，Go 端 threadtime 解析 + 过滤）
  ├── file/         文件传输 10 operations（push/pull/多文件/list/mkdir/delete/rename/size/storage，进度+重试+取消）
  └── scrcpy/       scrcpy 6 operations（start/record-start/record-stop/clipboard-set/get/screenshot）
internal/registry/  扫 actions/*.yaml 解析校验 + config.yaml 全局配置 + fragments.yaml 片段
internal/actionrun/ LoadedAction → Runner 构造（四选一形态分发/env 分层/capture 合并/LLM 拼装；
                    api 直跑与 workflow action step 两条路径共用，行为保持一致）
internal/workflow/  扫 workflows/*.yaml 加载校验 + Executor 串行执行 steps
internal/api/       Wails Service 绑定 + runRegistry 运行簿记（唯一依赖 Wails 的包），按域拆文件：
                    api.go(Service 骨架/路径解析) actions.go run.go workflows.go devices.go config.go
                    dialog.go events.go(action:*/workflow:* 事件契约与 seq/step 顺序协议集中) runregistry.go
```

- **runner.Runner** 接口 `Run(ctx, params, emit) Result` 是稳定扩展点。当前实现 `ShellRunner`（GHA 模型：`run` 内联命令与 `script` 脚本都写入临时脚本文件，由 `shellspec.go` 注册表指定的解释器执行——默认 bash（`-eo pipefail`），Windows 上 bash 走 BASH_PATH→PATH(排除 WSL)→常见目录级联探测，绝不静默回退 PowerShell；逐行 `emit` stdout/stderr）、`SleepRunner`（workflow sleep step）与 `LLMRunner`（LLM 一等形态，见下）。
- **adb 域**：`command.adb.operation` 形态由 `adb.ADBRunner`（实现同一 `Runner` 接口）处理。`actionrun.Build` 按 `command.run`/`script`/`adb.operation`/`llm.prompt` 四选一构造 Runner（api 直跑与 workflow action step 两条路径共用，capture_output 与 env 分层语义一致；二进制路径解析经注入的 `ResolvePaths`，唯一实现是 api.binPaths）。ADBRunner 解析设备 serial（params `ADB_SERIAL` 或 `device.ResolveActive`）+ 二进制路径（config 覆盖→PATH→常见路径），构造 `OpContext` 后按 `operation` 查路由表分发到域 handler。**各域子包（package/logcat/file/scrcpy/foreground 等）在自己的 `init()` 中调 `adb.RegisterOperation` 自登记，`main.go` blank-import 触发登记；新增 operation 不需改 `internal/adb/runner.go` 共享文件。** 输出走与 shell 动作完全相同的 `action:<id>:output` 通道；文件传输进度发 `stream:"progress"`。
- **LLM 域**：`command.llm{system, prompt}` 形态由 `runner.LLMRunner` 处理（对标 ADBRunner 的一等形态，不再寄生在 shell/stdin/stream 三个字段上）。`LLMRunner.Run` 直接 `exec.Command` 构造子进程 argv：CLI 名取 `config.yaml` 的 `LLM_CLI`（默认 `ducc`）+ 固定 flags（`-p --output-format=stream-json --verbose --thinking enabled`）+ `system` 对应 param 值作为 `--append-system-prompt` 的**独立 argv**（不经 shell 字符串，多行/引号/`$` 零风险）；`prompt` 对应 param 值写入 `cmd.Stdin`。stdout 按 stream-json 解析（`llm.go` 的 `parseLLMLine`/`recordStructuredFields`），只把 assistant 的 text / thinking 增量 emit 为 `"llm"` / `"llm-thinking"`。
- **变量替换**在**运行时**由 `runner.Expand` 完成（不在 registry 加载时）。优先级：动作参数 > 全局配置(config.yaml) > 环境变量；未命中保留 `${VAR}` 原样 + warning。`command.llm` 的 system/prompt 值同样走这条链路展开后再传给 LLMRunner。
- **workflow.Executor** 串行执行 workflow 的 steps（action / inline run / sleep 三选一），支持 `retry` 和 `continue_on_error`。step 边界 emit `step-start` / `step-done` 事件。执行回调是单参数请求 struct（`ActionRequest`/`ShellRequest`，ctx 随请求传递不闭包捕获），api 层据此合并 params 并经 `actionrun.Build` 构造 Runner（Shell/ADB/LLM）。
- **api.Service** 通过 `SetApp` 在 `main.go` 注入 app 引用（打破循环依赖）。`RunAction` 起 goroutine 执行，输出经事件 `action:<id>:output` 推送、结束发 `action:<id>:done`。同一动作并发运行被拒。事件名/payload/顺序协议（action 按递增 seq 排序还原产出顺序、workflow 按带 step 归属落桶）集中在 `events.go` 的 actionEvents/workflowEvents，改事件协议只动这一个文件。
- **exe 目录约定**：`main.go` 的 `exeDir()` 用 exe 所在目录扫描同级 `actions/`、`workflows/`、`config.yaml`、`fragments.yaml`；dev 时回退当前工作目录（项目根）。所以运行 exe 必须和这些文件同级。

前端（`frontend/src/`，React 19 + TS + Vite + tailwind4 + base-ui/shadcn）：`ActionRunnerProvider` 是唯一状态中枢，`ListActions` 拉动作、`Events.On` 订阅输出事件、`view` 在 output/form/global/llm-grid/llm-chat/logcat/workflow/fragments 间切（原 `llm` 视图已移除）。`command.llm` 动作走独立「AI 对话」分组 + LlmGridView 列表 + LlmChatView 聊天单页（底部输入框绑 promptParam、历史存 localStorage，按 actionId 分桶、封顶 50 条）；判定依据仍是 `action.llm != null`（`ActionItem.LLM` 由后端按 `command.llm` 是否非空注入）。`useLlmHistory` 是历史 hook；Provider 的 `openLlmChat(id)` 是打开聊天页空态的语义方法，供 AppSidebar/LlmGridView 复用。`DeviceSelector`（挂 `AppSidebar` SidebarHeader）调 `ListDevices`/`SetActiveDevice` 选激活设备，后端是激活 serial 唯一真相、运行 adb 动作时自动注入 `${ADB_SERIAL}`。binding 从 `frontend/bindings/`（`wails3 generate bindings` 产物，ES module）导入。UI 优先复用 `components/ui/` 下的 shadcn 原子（Badge / IconButton 等），避免手写重复样式。

**窗口级文件拖拽**（跨三处，改任一处都要看另外两处）：`main.go` 开 `EnableFileDrop` 并在 `WindowFilesDropped` 回调里把路径 + `DropTargetDetails()` 的松手坐标 Emit 成 `file:dropped` → 前端两个消费方共用 `lib/filedrop.ts` 的规则：`ActionRunnerProvider` 按坐标 `elementFromPoint` 定位输入框写入（命中非控件时向上找 `[data-slot="field"]` 再向下取控件，`path`/`file` 字段靠 `data-drop-single` 只取首个），`FragmentsList` 独立订阅同一事件处理变量 pill（pill 是 `<button>` 不在 Field 内，通用管道对它必然落空，故两条订阅天然互斥）。**隐式前提：`frontend/index.html` 的 `<body data-file-drop-target>` 不能删** —— Wails 用 `closest('[data-file-drop-target]')` 找落点，祖先没这个属性时事件根本不发给 Go 且完全静默。悬停反馈是 `index.css` 里一条 `body.file-drop-target-active`（Wails 自动加摘该类，零 JS）；hover 阶段的坐标只能靠 monkey-patch 框架内部的 `window._wails.handleDragOver` 拿到，已明确不走这条路。

## 动作 YAML（actions/*.yaml）

`id`（`^[a-z0-9-]+$` 全局唯一）+ `title` 必填；`command.run` 与 `command.script` 与 `command.adb.operation` 与 `command.llm.prompt` **四选一互斥**必选其一。`command.shell` 是可选修饰字段（只能搭配 run/script 形态）：指定解释器——内置名 `bash`/`sh`/`pwsh`/`powershell`/`python`/`node`/`cmd` 或含 `{0}` 的自定义模板，默认 bash。`script` 路径必须带受支持扩展名（`.sh`→bash、`.ps1`→pwsh、`.py`→python、`.js`→node；显式写了 `command.shell` 时以它为准，不校验扩展名），相对路径基于 exe 目录。`command.adb` 是 adb 域形态：写 `command.adb.operation: <域操作名>`，由内置 ADBRunner 分发到 adb 域服务（29 个 operation：包管理/logcat/文件传输/scrcpy/文本输入/前台信息），各 operation 的 params 契约见 [docs/action.md](docs/action.md)。`command.llm{system, prompt}` 是 LLM 一等形态：`prompt`（必填）与 `system`（可选）都是 param id，由内置 LLMRunner 拼 CLI argv（见上方架构小节），详见 [docs/action.md](docs/action.md) 「LLM 域形态」章节。`command.stream` 只允许 `""` / `"logcat"`（`"logcat"` 为 adb logcat-stream 域专用，前端切 logcat 视图）。`params`（type: text|bool|select|path|file|textarea，select 必带 options，可选 `description` 渲染为字段下方说明）驱动前端表单；`presets` 是作者预设的整套参数值。可选 `icon`：写 `hi:<key>`（key 见 `frontend/src/components/ActionIcon.tsx` 注册表）渲染 hugeicons 矢量图标，或直接写 emoji/文本（原样显示，向后兼容）。校验逻辑在 `registry.validate`。

`command` 新增可选 `capture_output`（布尔，默认 true；false 关闭全量 stdout/stderr 捕获，长跑/持续输出 action 如 scrcpy/logcat 用）。

run/script 形态的 stdout 协议行（`internal/runner/output.go`）：`##[output key=value]` 收进 outputs（该行仍照常显示）；`##[progress 文本]` 改以 `stream:"progress"` emit，前端原地覆盖上一条进度行（`frontend/src/lib/outputFold.ts`），不进 stdout 捕获。裸 `\r` 不能用于刷新——`splitLines` 把 `\r` 也当行结束符，只会追加。

完整字段文档：[docs/action.md](docs/action.md)。

## 工作流 YAML（workflows/*.yaml）

`id` + `title` + `steps` 必填。每个 step 三选一：`action`（引用已有 action id，可用 `params` 覆盖参数）、`run`（内联命令，写入临时脚本执行，可选 `timeout` 与 `shell` 修饰字段指定解释器）、`sleep`（等待 N 秒）。可选 `id`（步骤标识，供 outputs/if 引用，未写用索引兜底——**索引兜底键 `"0"`/`"1"` 需 bracket 语法引用：`steps["0"].outputs.exit_code`，expr 点语法不接受数字开头的键**）、`name`（Pipeline Spine 显示文案）、`if`（expr 表达式条件，false → SKIPPED）、`env`（step 级环境变量）、`capture_output`（默认 true）、`retry`（失败重试次数）、`continue_on_error`（失败不中断后续步骤）。workflow 可自带顶层 `env`（注入所有 step，优先级低于 params 高于 config.yaml）与 `params`（同 action 的 ParamSpec，`id` 不可用 `steps`/`env`/`params`/`config` 保留字）。每个 step 执行完自动产出 `outputs`（exit_code/stdout/stderr/success，脚本可用 `##[output key=value]` 追加自定义 key），供后续 step 通过 `${{ steps.<id>.outputs.<key> }}` 或 `if` 表达式引用。校验逻辑在 `workflow.Validate`。

完整字段文档：[docs/workflow.md](docs/workflow.md)。

## 片段 YAML（fragments.yaml）

`fragments: [{title, content, tags}]`，UI 侧「片段」视图按 tag 分组浏览、内容支持 `${VAR}` 展开预览、一键复制。CRUD 在前端编辑后由后端写回 YAML。

## 改动注意

- 改 `internal/api` 包（任意域文件）的 Service 方法签名/类型后，**必须** `wails3 generate bindings` → `npm run build` → `go build`（或直接 `bash deploy/build.sh`），否则前端调用报 "method ID not found"。
- 锁定 Wails `v3.0.0-alpha2.119`（CLI 与库同版本），**不要升到 alpha.3**（绑定机制损坏）。
- 新增前端静态文案只改 `frontend/src/i18n/locales/{zh,en}.json`；动作 `title/description` 与后端 stdout/stderr 不参与 i18n。
- 前端组件优先复用已装 shadcn 原子（`components/ui/` 下 25 个）；`IconButton` 是项目封装（Button + Tooltip + aria-label），需要图标按钮时优先用它，避免重新手写 `<button>` + tailwind。
- 修改 action / workflow 的 **YAML schema**（字段增删改、校验逻辑变动）后，**必须同步更新** `docs/action.md` 和 `docs/workflow.md`——这两份文档是面向使用者的完整字段参考，schema 改了文档不跟等于挖坑。
