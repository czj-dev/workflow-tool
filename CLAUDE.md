# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目

Workflow Tool：基于 **Wails v3 (alpha2.119) + Go** 的桌面工具。用 YAML 定义「动作」「工作流」与「AI 任务」，前端按钮触发，实时流式输出，编译为跨 macOS/Windows 单二进制。

## 关键命令

构建（已封装为 `deploy/` 脚本，Windows 用 Git Bash，跨 macOS/Linux）：
```bash
bash deploy/build.sh        # 一键全量：bindings → 前端 → 单二进制（平台自适应）
bash deploy/frontend.sh     # 仅前端（总是 npm install 同步依赖；bindings 自动生成）
bash deploy/backend.sh      # 仅后端（bindings + go build；Windows 自动 windowsgui + taskkill 释放占用）
```

构建**顺序不能乱**——bindings → 前端 → 单二进制：前端 import bindings，前端产物又 embed 进二进制（脚本已按此顺序编排）：
```bash
wails3 generate bindings                                 # 1. 产出 frontend/bindings/（gitignored，新克隆后必须先生成；改 api.go 后必须重跑，否则前端 method ID 不匹配）
cd frontend && npm install && npm run build && cd ..    # 2. 产出 frontend/dist/
go build -ldflags "-H windowsgui" -o workflow-tool.exe . # 3. -H windowsgui 仅 Windows，隐藏控制台
```

详见 [deploy/README.md](deploy/README.md)。

测试：
```bash
go test ./internal/...                                    # 后端全部包单测（api 包的测试同样 headless，不需要起 GUI）
go test -race ./...                                      # 带竞态检测
go test ./internal/runner -run TestExpand                # 单个测试
cd frontend && npm test                                  # 前端 vitest
cd frontend && npm run lint && npx tsc -p tsconfig.app.json --noEmit   # 前端 lint / 类型检查
```

注意：`npm run typecheck` 是 `tsc --noEmit`，而根 `tsconfig.json` 只有 `references`（`files: []`），它**不检查任何文件**；真正的类型检查是 `npx tsc -p tsconfig.app.json --noEmit`（`npm run build` 里的 `tsc -b` 也会查）。vitest 运行不做类型检查，测试文件里的类型错误只有这一步能发现。
调试 Go 侧日志：临时 `go build -o workflow-tool.exe .`（不加 `-H windowsgui`）会弹控制台显示 `log`/`fmt` 输出；发布再换回带 ldflags 的版本。

前端 `npm run dev` 只能调样式——`Call.ByID` 仅 Wails 运行时可用，纯 dev server 调不到后端，联调必须 `go build` 跑 exe。

## 架构

三层，`Runner` 接口稳定不变，所有功能扩展落在 YAML schema 与编排层：

```
internal/runner/    执行单元（纯 Go，可单测，不依赖 Wails）：ShellRunner / SleepRunner / AIRunner
internal/adbcore/   adb 域子进程治理：RunCommand/RunStreaming/RunCommandWithStdin + errors + validation
                    （自包含，复用 runner 的 pgid/hide 逻辑，不依赖 Wails）
internal/adb/       adb 域框架：ADBRunner（实现 runner.Runner）+ operation 自注册路由表 + OpContext
  ├── binary/       adb/fastboot/scrcpy 路径探测级联（config→PATH→常见路径，仅探测不下载）
  ├── device/       设备列表/信息/模式/wireless + 激活 serial 解析
  ├── foreground/   前台信息 1 operation（foreground-info：前台 Activity/焦点窗口多 display 分组/View 树格式化报告，纯函数解析+排版）
  ├── input/        文本输入 1 operation（input-text：纯 ASCII 走 input text，含非 ASCII 走 ADBKeyboard 输入法广播，未安装时自动装内嵌 APK）
  ├── package/      包管理 9 operations（install/uninstall/list/enable/disable/clear/force-stop/pull-apk/details）
  ├── logcat/       结构化 logcat 2 operations（stream/batch，Go 端 threadtime 解析 + 过滤）
  ├── file/         文件传输 10 operations（push/pull/多文件/list/mkdir/delete/rename/size/storage，进度+重试+取消）
  └── scrcpy/       scrcpy 6 operations（start/record-start/record-stop/clipboard-set/get/screenshot）
internal/builtinvars/
                     内置变量注册表（CURRENT_DATE / CURRENT_TIME / ADB_SERIAL）：runner.Expand 在查找源（params + config）未命中时兜底查询
internal/registry/  扫 actions/*.yaml 解析校验 + config.yaml 全局配置 + fragments.yaml 片段 + var-groups.yaml 变量分组 + skills/ 发现
internal/actionrun/ LoadedAction → Runner 构造（三选一形态分发/env 分层/capture 合并；
                    api 直跑与 workflow action step 两条路径共用，行为保持一致）
internal/ai/        AI 任务定义：Task schema / Parse（严格解析，未知键与预留字段报错）/ Validate / Load（扫 ai/*.yaml）
internal/airun/     AI 任务 → AIRunner 构造（airun.Build：输入合并/保留运行参数/模板展开/守则读取/pi 初始化/skill 零拷贝；pi_setup.go：可执行解析、三键校验、hermetic 目录与 models.json）；
                    airun.Run（构造 → 运行，超时包成带续接提示的 TimeoutError）与 airun.Step（工作流的 AI 步骤）
                    是应用内手动运行、CLI/执行器与 workflow ai step 共用的执行段，行为保持一致；airun.Readout 是 done 的终点读数
internal/workflow/  扫 workflows/*.yaml 加载校验 + Executor 串行执行 steps
internal/schedule/  调度：schedules.yaml 的 Definition / 5 段 cron（分钟粒度，不支持 / 步长）/ 进程内 Scheduler；
                     目标三选一 action / workflow / ai（ADR-0005：AI 任务是第三种调度目标）；可选 catch_up（M4）。
                     Scheduler.TrackMissed 把每条调度「上次评估到的时刻」持久化到 schedules.state.json，
                     应用恢复后把其间溜走的到点逐个报给 MissedHandlers.Missed（留 missed 记录），
                     开了 catch_up 的另为最近一个错过的时刻调 CatchUp（见 missed.go）
internal/api/       Wails Service 绑定 + runRegistry 运行簿记（唯一依赖 Wails 的包），按域拆文件：
                    api.go(Service 骨架/路径解析) actions.go ai.go run.go workflows.go schedules.go runs.go(运行记录查询与接入点) devices.go config.go
                    dialog.go tree_click.go events.go(action:*/ai:*/workflow:* 事件契约与 seq/step 顺序协议集中；
                     schedules:changed / runs:changed 失效通知；运行日志 events.ndjson 的落盘点与 emit 是同一处、同一份 payload）
                    runregistry.go
internal/cli/       headless 子命令 list / describe / run（供 Agent 从 shell 调用，绝不 import Wails）；
                    AI 任务与含 AI 步骤的 workflow 默认 ai_blocked（退出码 2），--allow-ai 显式放行，用法见 internal/cli/SKILL.md；
                    兼任独立执行器（M4）：run --record <run-id> 接手应用建好的运行记录（executor.go），
                    先接手（写 pid 与首次心跳）再加载目标与依赖——先加载后接手会让应用侧核对循环在空窗里误判中断
internal/apphome/   exe 目录约定与 baseDir 解析 + 用户级目录（UserDir = WORKFLOW_TOOL_USER_HOME > ~/.workflow-tool，AuthPath 即 auth.json；main 与 cli 共用的单一真相源）
internal/target/    「目标」的共享词汇：Kind（action / workflow / ai）与 Target；schedule 与 runstore 都依赖它，
                     不各自定义一份字符串常量靠「恰好相等」互认；不依赖仓库内其他包
internal/runstore/  运行记录：runs/<run-id>/run.json（结论）+ events.ndjson（过程）；Start/Note/Finish（终态只写一次）、
                    内存索引 + List/Latest 查询、保留策略（每目标 50 次 / 30 天）；不依赖 Wails。
                    M4：Open 按心跳与进程身份认领仍在运行的执行器运行（其余遗留 running 一律 interrupted；
                    未接手 pid=0 的给 30 秒接手宽限 AttachGrace，别把「还没接手」误判成「执行器没了」）、
                    Poll 供应用定期核对在途的执行器运行、Attach 让执行器接手一条记录（回写 pid、心跳、续写日志、落终态）、
                    RequestStop 写 STOP 停止标记；LogEmitter 是运行日志行 / 前端事件 payload 的共同契约（取号 + 落盘）
internal/procinfo/   进程身份核对：pid + 启动时刻 → 是否仍是那个进程（Alive/Self）。目标锁判残留、运行记录认领共用；
                     启动时刻向系统查（unix 走 ps -o etime=，Windows 走 PowerShell Get-Process），容差 10 秒
internal/targetlock/ 落盘的目标锁 runs/locks/<kind>-<id>.lock（内容 = 持有者 pid + 启动时刻）：同一目标跨进程只有一个运行；
                     持有者已死的锁按进程身份判残留后接管。应用内运行、执行器、CLI 运行与工作流的步骤都经它互斥
internal/applog/    应用日志 logs/app.log：NDJSON，单文件 5MB 保留 3 份；记调度与运行器自身的行迹（到点、跳过、
                    启动失败、中断）；写失败永不影响运行
```

- **runner.Runner** 接口 `Run(ctx, params, emit) Result` 是稳定扩展点。当前实现 `ShellRunner`（GHA 模型：`run` 内联命令与 `script` 脚本都写入临时脚本文件，由 `shellspec.go` 注册表指定的解释器执行——默认 bash（`-eo pipefail`），Windows 上 bash 走 BASH_PATH→PATH(排除 WSL)→常见目录级联探测，绝不静默回退 PowerShell；逐行 `emit` stdout/stderr）、`SleepRunner`（workflow sleep step）与 `AIRunner`（AI 任务的执行器，见下）。
- **取消与超时**（`runner.Run`）：杀进程组后等管道关闭，没在 0.5 秒内关闭就再补杀一次——组长恰在 fork 途中被杀时，新生的子进程会躲过第一次组杀并握着管道不放。
- **adb 域**：`command.adb.operation` 形态由 `adb.ADBRunner`（实现同一 `Runner` 接口）处理。`actionrun.Build` 按 `command.run`/`script`/`adb.operation` 三选一构造 Runner（api 直跑与 workflow action step 两条路径共用，capture_output 与 env 分层语义一致；二进制路径解析经注入的 `ResolvePaths`，唯一实现是 api.binPaths）。ADBRunner 解析设备 serial（params `ADB_SERIAL` 或 `device.ResolveActive`）+ 二进制路径（config 覆盖→PATH→常见路径），构造 `OpContext` 后按 `operation` 查路由表分发到域 handler。**各域子包（package/logcat/file/scrcpy/foreground 等）在自己的 `init()` 中调 `adb.RegisterOperation` 自登记，`main.go` blank-import 触发登记；新增 operation 不需改 `internal/adb/runner.go` 共享文件。** 输出走与 shell 动作完全相同的 `action:<id>:output` 通道；文件传输进度发 `stream:"progress"`。
- **AI 任务**：与动作、工作流并列的第三种可执行物（`ai/*.yaml`，定义在 `internal/ai`，构造在 `internal/airun`），不再是动作的 `command.llm` 形态；运行器只有 pi（唯一 AI 运行器，ADR-0008，一步替换旧 ducc / CC stream-json 协议，无双协议无回退）。`airun.Build` 在进程启动前把任务定义与本次输入合成为终值：校验并合并输入（本次传入 > 定义 `default` > `config.yaml` 同名值；默认值本身是模板，按声明顺序展开；未声明参数名报错）→ 处理保留运行参数（`prompt`/`system` 键出现即整体替换定义模板，`resume` 非空转 `--session`）→ 展开 `prompt`/`system`/`cwd`/`env` → 校验 cwd（空兜底 BaseDir）→ 读守则（exe 同级 `ai-rules.md`，缺省用内置默认）→ pi 初始化（`pi_setup.go`：可执行解析 `AI_PI_BIN` > `<BaseDir>/pi/pi` > PATH，显式配置指向不存在的文件早失败；`AI_BASE_URL`/`AI_AUTH_KEY`/`AI_MODEL` 三键校验早失败（三键来自用户级 `~/.workflow-tool/auth.json`，`Deps.AgentConfig` 每次运行现读合并：非空覆盖 config.yaml 同名键，config.yaml 残留仅作回退并附迁移 BuildWarning，读失败早失败）；建 hermetic 目录 `pi-agent/`（env `PI_CODING_AGENT_DIR` 注入，用户自己的 `~/.pi` 不生效）与 `pi-sessions/`（`--session-dir`）；原子写 `pi-agent/models.json`——provider 固定 `workflow-tool`、`apiKey` 写 `${AI_AUTH_KEY}` 插值字面量，密钥不落盘，请求时从 pi 子进程 env 解析）→ 解析 skills 绑定（零拷贝：`--skill` 直传源目录，skills/ 根=project、skills/user/=user 两级作用域；历史复制同步已删，`skills.synced.json` 停写；id 解析失败即本次运行失败）。密钥防泄漏：`AI_AUTH_KEY` 从模板 vars 层剔除（提示词/运行日志不泄漏），但进子进程 env 供 pi 插值；保留运行参数不进子进程 env。`runner.AIRunner.Run` 直接 `exec.Command` 构造子进程 argv：`pi --mode json --offline --no-approve --session-dir <pi-sessions> --no-skills [--skill <src> ...] --model workflow-tool/<AI_MODEL> [--session <id>]` + 无人值守守则与任务 `system` 合成**单个** `--append-system-prompt` 的**独立 argv**（不经 shell 字符串，多行/引号/`$` 零风险）；`prompt` 写入 `cmd.Stdin`；`--no-approve` 忽略信任门控（pi 无审批机制，无人值守天然满足 ADR-0007）。stdout 逐行喂 `pi_events.go` 解析（role 门控只认 assistant、`message_end` 权威块收口、run 级 text 跨消息累计、usage 快照、流内失败判定），text / thinking 增量与工具调用对 emit 为 `"ai"` / `"ai-thinking"` / `"ai-tool"`；`[skill]` 绑定报告与 Build 层警告（如 config.yaml 残留 `AI_CLI` 的提示）由 Run 开头最先 emit。失败语义：pi exit 0 但流内 `stopReason` 为 error/aborted（或 `agent_settled.aborted`）→ 判失败 ExitCode -1、文案推 stderr；进程自身错误（超时/取消/启动失败）优先于流内判定。outputs 落 `session_id`/`cost_usd`/`total_tokens`/`input_tokens`/`output_tokens`，`Result.Stdout` 是 run 级累计的 assistant 全文。
- **变量替换**在**运行时**由 `runner.Expand` 完成（不在 registry 加载时）。run / script 形态的查找顺序：`command.env` > 动作参数（覆盖同名 config.yaml）> 内置变量(`builtinvars`) > 环境变量；未命中保留 `${VAR}` 原样 + warning。`command.env` 在最前是因为 `ShellRunner` 把 `cfg.Env` 的终值并进查找源并压过 params（与子进程 env 的覆盖顺序对齐；PowerShell 把 `${VAR}` 当变量语法读不到环境变量，统一在 Go 侧展开才能跨平台一致），所以参数覆盖不了同名的 `command.env`。workflow 里再在最前面叠 step `env` > workflow `env`；adb 形态没有 env 层。完整链见 docs/action.md「变量替换」。AI 任务的 `prompt`/`system`/`cwd`/`env` 模板走同一个 `Expand`，只是第一层换成本次输入（`airun.Build`）；任务的 `env` 只进子进程环境，不参与查找。
- **workflow.Executor** 串行执行 workflow 的 steps（action / inline run / sleep / ai 四选一），支持 `retry` 和 `continue_on_error`。step 边界 emit `step-start` / `step-done` 事件。执行回调是单参数请求 struct（`ActionRequest`/`ShellRequest`/`AIRequest`，ctx 随请求传递不闭包捕获），api 层据此合并 params 并经 `actionrun.Build` / `airun.Build` 构造 Runner（Shell/ADB/AI）。ai step 的 `params` 值只做 `${{ }}` 替换，`${VAR}` 原样交给 `airun.Build`；加载时只校验任务 id 格式，任务不存在要到执行该步骤时才失败。step 的 `timeout`/`capture_output`/`shell` 对 ai step 不生效。
- **api.Service** 通过 `SetApp` 在 `main.go` 注入 app 引用（打破循环依赖）。`RunAction` 起 goroutine 执行，输出经事件 `action:<id>:output` 推送、结束发 `action:<id>:done`。同一动作并发运行被拒。事件名与投递集中在 `events.go` 的 actionEvents/workflowEvents；payload 的形状与取号（action 按递增 seq 排序还原产出顺序、workflow 按带 step 归属落桶）在 `runstore.LogEmitter`——应用内的运行先经它落盘再把同一个 payload 推给前端，执行器的运行只有落盘那一份。改事件协议只动这两处。
- **AI 运行的两条路径**共用 `airun.Run`（手动运行）/ `airun.Step`（步骤，内部也是 Run）与同一把目标锁 `Service.aiRunning`：手动运行（`RunAi`，事件 `ai:<id>:output` / `ai:<id>:done`，形状与排序协议同 `action:<id>:*`——`newAiEvents` 复用 actionEvents，只是前缀不同）与 workflow 的 ai step（`aiStepRun`，`beginChild` 把 ctx 挂在工作流 ctx 下，不发 `ai:<id>:*`，输出带步骤归属走 `workflow:<wf-id>:output`；workflow `env` 与 step `env` 作为 `ExtraEnv` 覆盖任务 `env` 同名键）。撞锁立即失败、不等待；改 AI 运行行为时两条路径要保持一致。
- **调度**：`schedules.yaml`（`schedules: [{id, name, enabled, cron, action | workflow | ai, params}]`，目标三选一，与 exe 同级）由 `api.New` 经 `schedule.LoadFile` 加载；目标必须是当前已加载的 id（动作 / 工作流 / AI 任务各查各的表，同一 id 可同时是不同种类）。`params` 覆盖目标的输入，保存与加载时都按目标校验（`validateScheduleTargetParams`）：动作允许标量或 `$literal` 对象；工作流只允许标量或 JSON 字符串；AI 任务只允许标量，且键必须是任务已声明的参数或保留运行参数 `prompt`/`system`/`resume`（未声明即报错）。动作 / 工作流另按**参数声明**校验已提供取值的形状（`validateDeclaredParams`，与 `internal/cli` 的 `coerceParams` 同规则：select 须在 options 内、bool 须是布尔或 "true"/"false"、list / arguments 须是合法 JSON 字符串）——未声明的键是允许的（动作与工作流把它们当额外变量源，既有用法），缺省的必填参数也不在这里报错（值可以来自 config.yaml 同名键）。`schedule.Scheduler` 跑在应用进程内：`ServiceStartup` 起 goroutine 以 30s tick 轮询，按分钟比对 5 段 cron（不支持 `/` 步长），同一分钟内按 `triggered[id][minuteKey]` 去重，`Replace` 换定义后旧一代的待触发作废。到点经 `launchSchedule`（origin `schedule`）以调度自带的 `params` 发起运行；「立即运行」是 `RunScheduleNow` → `scheduler.TriggerNow` → `launchScheduleNow`（origin `run-now`，`SetTriggerNow` 指定的专用回调）。**冲突只跳过**（ADR-0006）：撞上运行中的目标时，到点经 `onTargetBusy` 留一条 `skipped` 运行记录并注明原因，不覆盖上一次真实运行的结果，也不算错误（互斥的真相是 `targetlock` 的落盘锁，进程内的 `runRegistry.begin/beginChild` 先占它再登记取消入口；工作流的动作步骤与 AI 步骤经 `actionrun.LockStep` 占各自目标的锁，撞上立即失败）；立即运行返回「…已在运行，已跳过」；手动运行仍是「…正在运行」。撞锁的分类靠 `*targetBusyError`（带 skipped 标记），不解析文案。**调度到点与立即运行不在应用进程里跑**（M4，`api/executor.go`）：`launchExecutor` 先建运行记录（`process.mode: executor`）、登记进程内簿记（`runRegistry.hold`，取消入口 = 写停止标记）、通告调度卡，然后经 `spawnExecutor` 拉起同一可执行文件的 `run --record <run-id> --allow-ai`（新进程组、环境标记 `WORKFLOW_TOOL_EXECUTOR=1`，不随应用退出）。`spawnExecutor` 是包级变量：生产是真进程，测试（`executor_test.go` 的 init）换成在当前进程里跑同一份 `cli.ExecuteRecord` 后立即 `pollExecutorRun`。应用侧 `watchExecutorRuns`（ServiceStartup 起，2 秒一轮）对在途的执行器运行调 `runstore.Poll`：执行器写了终态就按**记录的 run-id** 撤销登记（`registryFor(...).endIf`，不误清该目标上新开始的运行的取消入口与锁）、发 `runs:changed`、更新调度卡（skipped/missed 的终态只更新 LastSkip，不覆盖 LastRun）；执行器没了就留中断。应用启动时 `New` 打开运行记录后立刻 `adoptExecutorRuns` 把仍在运行的执行器运行登记进簿记。手动运行仍在应用进程内。
运行**开始**即 `beginScheduledRun` → `emitScheduleChanged`：最近结果变为 running 且带 `runId`，前端据此让卡片进入运行态、能进运行详情跟踪（调度发起的运行前端没有它的输出捕获，只能靠这次通知得知）。其他启动失败走 `failScheduleStart`（留 `failed` 记录 + 更新最近结果）。增删改与启停在 `api/schedules.go`（`SaveSchedule` / `DeleteSchedule` / `SetScheduleEnabled`），校验通过后写回 `schedules.yaml` 并 `scheduler.Replace`，随后 emit `schedules:changed`。`ScheduleItem.LastRun` 是最近一次**真实**运行的结论（状态词汇同运行记录：running / succeeded / failed / cancelled；运行中就带 `runId`，可进运行详情实时跟踪），`LastSkip` 是最近一次到点被跳过的原因（新一次真实运行开始即清掉）。本次会话内由内存态 `scheduleRuns` 维护（token 防止迟到的完成回调覆盖新一次运行），内存里没有的从运行记录回填——最近结果因此跨重启保留。`Reload` / `ReloadWorkflows` 之后调 `reconcileSchedules`，按新的目标列表重新校验调度。**错过与补跑**（M4）：调度器每个 tick 先 `reconcileMissed`，把「上次评估到的时刻」到当前分钟之间溜走的到点报给 `missedInstant`（留 `missed` 记录 + `schedule.missed` 日志，每条调度一次恢复最多 50 个）；调度写了 `catch_up: true` 的另调 `catchUp`（`launch(def, schedule)`）。停用期间、改过 cron、没有历史、时钟回拨都不算错过。
- **exe 目录约定**：`apphome.ExeDir()` 取 exe 所在目录（同级有 `actions/` 才算，否则 dev 回退当前工作目录），`main.go` 与 `api.New` 从这里加载同级的 `actions/`、`workflows/`、`ai/`、`skills/`、`config.yaml`、`fragments.yaml`、`var-groups.yaml`（全局配置的变量分组，首次写入时创建）、`schedules.yaml`，守则 `ai-rules.md` 与 pi 的 hermetic 目录（`pi-agent/`、`pi-sessions/`）也放在这里；`bin/` 是随产物携带的工具二进制目录（构建脚本把构建机的 jq 复制进来；`ShellRunner`/`AIRunner` 启动子进程时把 `<exe目录>/bin` 注入 PATH 最前——产物自带工具不依赖目标机安装，目录不存在则零注入）；运行记录 `runs/<run-id>/`、目标锁 `runs/locks/`、应用日志 `logs/app.log` 与调度器的 `schedules.state.json` 同样以它为根（均 gitignored）；CLI 另可用 `--base-dir` / `WORKFLOW_TOOL_HOME` 覆盖。所以运行 exe 必须和这些文件同级。唯一例外是 Agent 三键：存用户级 `~/.workflow-tool/auth.json`（`apphome.UserDir()` = `WORKFLOW_TOOL_USER_HOME` > 用户主目录；0600 原子写，不随包分发），Settings →「Agent」分类编辑，GUI/CLI/执行器共读同一份。
- **运行记录**（详见 docs/runs.md）：每次顶层运行（动作 / 工作流 / AI 任务 × 手动 / 调度 / 立即运行）都经 `beginRun` 建一条记录（`runstore.Start`，在占锁**之后**——锁都占不到就没有这次运行；目标种类用 `internal/target` 的 `Kind`。调度发起的走 `startRun` 并带 `process.mode: executor`——记录先于执行器进程存在，建好后 `Session.Detach` 交出去）。应用内的运行里 emit 的每一行同步落进 `events.ndjson`（`LogEmitter.Output/Done`，与推给前端的 payload 是同一个对象；工作流的 output 事件也带递增 `seq`，供回放与运行中的详情跟踪排序、去重），三条执行路径在入口处 `defer s.settleRun(...)()` 做收尾兜底（意外退出时也给运行记录与调度状态一个交代，最后释放目标锁），正常路径显式调 `endRun` 按 `runstore.Outcome` 写终态（取消 / 超时是失败 / 非零退出）并 emit `runs:changed`（payload 的唯一权威定义是 `events.go` 的 `runsChangedPayload`，始终带目标）。跳过与启动失败留一条没有过程的记录（`runstore.Note`）。跳过的记录单独计保留配额（每目标 50 条），不挤占真实运行的配额。工作流的步骤不单独留档（输出带步骤归属落在父工作流的日志里）；AI 运行额外落档本次注入的守则全文（`SetRules`，取自 `airun.Run` 的第二个返回值）。`Session` 为 nil 时所有方法空操作：记录写不进去时运行照常进行。查询 API 在 `api/runs.go`（`ListRuns` / `GetRun` / `GetRunEvents`）；`ListAiTasks` 给每个任务带上 `lastRun`（AI 卡摘要的来源）。应用启动时 `runstore.Open` 逐条对账遗留的 running 记录：`in-app` 的改写为 interrupted（应用内的运行随应用退出必然终止）；`executor` 的按心跳（10 秒一跳、30 秒内算新鲜）与进程身份认领，心跳过期但进程仍在就再等，确认不在才改写为 interrupted（原因文案不同）。跳过与错过都不覆盖上一次真实运行的结果，保留配额也单独计。`ResumeRun(runID)` 是运行详情的「续跑」：以一条 AI 运行记录的同一份输入加 `resume: <session_id>` 发起一次新的手动运行（`airun.Run` / `airun.Step` 是手动运行、CLI 与执行器共用的执行段，终点读数是 `airun.Readout`）。

前端（`frontend/src/`，React 19 + TS + Vite + tailwind4 + base-ui/shadcn）：`ActionRunnerProvider` 是唯一状态中枢，`ListActions` / `ListWorkflows` / `ListAiTasks` 拉三类可执行物、`Events.On` 订阅输出事件、`view`（`RunnerView`）在动作（actions-grid / output / logcat / edit）、工作流（workflows-grid / workflow / workflow-edit）、AI 任务（ai-grid / ai-chat / ai-edit）与 global / schedules / settings / fragments 间切；参数表单不是视图，是左侧非模态抽屉 `ParamSheet`。AI 任务走独立「AI 任务」分组 + `AiGridView` 双态卡网格 + `AiChatView` 会话页（底部输入框绑保留运行参数 `prompt`，输入框上方是参数 chip）+ `AiYamlEditor`。草稿 `aiDrafts` 按任务只存用户改过的键（只在内存）：`prompt` / `system` 恒发送，已声明参数只发改过的，没改的交给后端取默认值并展开模板。使用留痕记在 `ai-usage`；历次运行不再本地另存，由后端的运行记录承担（见下方「运行记录（M3）」）。Provider 的 `runAi(id, overrides?, background?)` / `focusAi(id)` / `openAiChat(id, patch?)` 是运行、回到会话页、打开空会话页的语义方法，供 AppSidebar / AiGridView 复用；网格卡「运行」是后台起跑，输入未就绪时改开会话页。每次 AI 运行有独立捕获（按任务 id，前台/后台都建），所以切走再切回能回放；被 workflow 的 ai step 占用的任务记在 `aiHolders`，点它跳到那个 workflow。`DeviceSelector`（挂 `AppSidebar` SidebarHeader）调 `ListDevices`/`SetActiveDevice` 选激活设备，后端是激活 serial 唯一真相、运行 adb 动作时自动注入 `${ADB_SERIAL}`。运行记录（M3）：应用内不再另存会话记录（`useAiHistory` 已删），`ListAiTasks` 的 `lastRun` 是 AI 卡摘要的来源；后端 `runs:changed` 事件只让 Provider 的 `runsRevision` 递增（防抖合并「开始 + 结束」两条）并刷新 AI 任务列表，运行记录本身按需拉取（`listRuns` / `getRun` / `getRunEvents`），不在 Provider 里常驻。`RunsView`（列表 + 筛选）与 `RunDetailView`（结论 / 过程 / 产出）是全应用唯一查看运行过程的地方，也是唯一能停掉调度发起的运行的地方（右上角「停止」→ `stopRun`，按目标取消；AI 运行留下会话 id 时另有「续跑」→ `resumeRun`，进入新运行的详情）。执行器承担的运行（`processMode === "executor"`）没有实时事件可订阅，运行期间每 2 秒重读一次运行日志（`EXECUTOR_POLL_MS`）。回放与实时共用同一份归约器——`lib/aiStream.ts`（AI 输出流 → 工序段）、`lib/workflowStream.ts`（工作流事件 → 步骤桶）、`lib/runReplay.ts`（运行日志 → 回放状态，seq 帧门与实时路径同一契约，动作的退出码行接入同一条队列）；`openRun` 记住来处，`closeRun` 各回各处。运行中的记录在回放之上订阅该目标的实时事件继续应用——**先订阅、后读盘**（反过来会留下窗口：读盘到订阅生效之间的输出两头落空，seq 号段出现永久的洞，详情停更到运行结束；先订阅则读盘之前的事件重送一遍，由 `applyLiveEvent` 据 seq 跳过）。调度编辑器（`ScheduleFormSheet`）的开关状态提升到 Provider（`scheduleEditor`），调度页与 AI 卡的「定时」入口（目标锁定）共用，组件挂在 `App.tsx` 骨架上；切换视图即关闭。`ScheduleFormValue.catchUp`（补跑）缺省为关，卡片的时间规则旁标出开了补跑的调度。从网格卡后台起跑撞上运行中的目标时，Provider 去正在占用该目标的那条运行的详情（`goToLiveRun`），不让这一下点击毫无反应。binding 从 `frontend/bindings/`（`wails3 generate bindings` 产物，ES module）导入。UI 优先复用 `components/ui/` 下的 shadcn 原子（Badge / IconButton 等），避免手写重复样式。

**窗口级文件拖拽**（跨三处，改任一处都要看另外两处）：`main.go` 开 `EnableFileDrop` 并在 `WindowFilesDropped` 回调里把路径 + `DropTargetDetails()` 的松手坐标 Emit 成 `file:dropped` → 前端两个消费方共用 `lib/filedrop.ts` 的规则：`ActionRunnerProvider` 按坐标 `elementFromPoint` 定位输入框写入（命中非控件时向上找 `[data-slot="field"]` 再向下取控件，`path`/`file` 字段靠 `data-drop-single` 只取首个），`FragmentsList` 独立订阅同一事件处理变量 token（token 是 `<button>` 不在 Field 内，通用管道对它必然落空，故两条订阅天然互斥）。**隐式前提：`frontend/index.html` 的 `<body data-file-drop-target>` 不能删** —— Wails 用 `closest('[data-file-drop-target]')` 找落点，祖先没这个属性时事件根本不发给 Go 且完全静默。悬停反馈是 `index.css` 里一条 `body.file-drop-target-active`（Wails 自动加摘该类，零 JS）；hover 阶段的坐标只能靠 monkey-patch 框架内部的 `window._wails.handleDragOver` 拿到，已明确不走这条路。

## 动作 YAML（actions/*.yaml）

`id`（`^[a-z0-9-]+$` 全局唯一）+ `title` 必填；`command.run` 与 `command.script` 与 `command.adb.operation` **三选一互斥**必选其一。`command.shell` 是可选修饰字段（只能搭配 run/script 形态）：指定解释器——内置名 `bash`/`sh`/`pwsh`/`powershell`/`python`/`node`/`cmd` 或含 `{0}` 的自定义模板，默认 bash。`script` 路径必须带受支持扩展名（`.sh`→bash、`.ps1`→pwsh、`.py`→python、`.js`→node；显式写了 `command.shell` 时以它为准，不校验扩展名），相对路径基于 exe 目录。`command.adb` 是 adb 域形态：写 `command.adb.operation: <域操作名>`，由内置 ADBRunner 分发到 adb 域服务（29 个 operation：包管理/logcat/文件传输/scrcpy/文本输入/前台信息），各 operation 的 params 契约见 [docs/action.md](docs/action.md)。`command.llm` 已不是动作形态（AI 任务独立定义在 `ai/`，见下节），留在 `actions/` 里的旧文件加载时报「command 必须指定 run/script/adb 之一」。`command.stream` 只允许 `""` / `"logcat"`（`"logcat"` 为 adb logcat-stream 域专用，前端切 logcat 视图）。`params`（type: text|bool|select|path|file|textarea|list|arguments，select 必带 options，可选 `description` 渲染为字段下方说明）驱动前端表单；`presets` 是作者预设的整套参数值。可选 `icon`：写 `hi:<key>`（key 见 `frontend/src/components/ActionIcon.tsx` 注册表）渲染 hugeicons 矢量图标，或直接写 emoji/文本（原样显示，向后兼容）。可选 `color`：卡片氛围色，`amber` / `green` / `cyan` / `blue` / `violet` 之一（五色板白名单），不写则按分组序循环（循环仍按原四色板，ADR-0003）。`command` 另有可选 `cwd`（工作目录，模板；不写则继承应用进程的工作目录）、`timeout`（Go duration，默认 60s）、`env`（追加到子进程环境变量，值是模板）。`hmi.tree` 声明该动作输出交互树（见下方协议行）。校验逻辑在 `registry.Validate`。

`command` 新增可选 `capture_output`（布尔，默认 true；false 关闭全量 stdout/stderr 捕获，长跑/持续输出 action 如 scrcpy/logcat 用）。

run/script 形态的 stdout 协议行（`internal/runner/output.go`）：`##[output key=value]` 收进 outputs（该行仍照常显示）；`##[progress 文本]` 改以 `stream:"progress"` emit，前端原地覆盖上一条进度行（`frontend/src/lib/outputFold.ts`），不进 stdout 捕获。第三种协议行 `##[tree <json>]`（一帧 = 一棵完整的树，JSON 必须单行）改以 `stream:"tree"` emit，同样不进 stdout 捕获；adb 域（`list-files`、`foreground-info` 的 View 树）不经协议行，由 Go 侧 `adb.OpContext.EmitTree` 直发同构帧。只有声明了 `hmi.tree` 的 action 才把 tree 流渲染成可交互树，未声明的 action 与 workflow 内联 `run` step 按普通文本显示（`runner.WithoutTreeHMI`）。`hmi.tree.click` 把叶子点击映射成一次目标 action 运行：`params` 里的 `${{ node.path }}` / `${{ params.X }}` 经 `workflow.Substitute` 求值，只传显式列出的参数；再写 `multi: true` 开启勾选多选，批量时表达式改用 `${{ nodes.paths }}`（选中叶子的 path 换行拼接）。解析在 `api/tree_click.go`，帧 schema 见 docs/action.md「树帧」章节。裸 `\r` 不能用于刷新——`splitLines` 把 `\r` 也当行结束符，只会追加。

完整字段文档：[docs/action.md](docs/action.md)。

## 工作流 YAML（workflows/*.yaml）

`id` + `title` + `steps` 必填。每个 step 四选一：`action`（引用已有 action id，可用 `params` 覆盖参数）、`run`（内联命令，写入临时脚本执行，可选 `timeout` 与 `shell` 修饰字段指定解释器）、`sleep`（等待 N 秒）、`ai`（调用 `ai/` 下的 AI 任务 id，`params` 是本次输入，值只做 `${{ }}` 替换；产出 `text` / `thinking` / `session_id` / `cost_usd` 等，写在 `steps.<id>.outputs` 下）。可选 `id`（步骤标识，供 outputs/if 引用，未写用索引兜底——**索引兜底键 `"0"`/`"1"` 需 bracket 语法引用：`steps["0"].outputs.exit_code`，expr 点语法不接受数字开头的键**）、`name`（Pipeline Spine 显示文案）、`if`（expr 表达式条件，false → SKIPPED）、`env`（step 级环境变量）、`capture_output`（默认 true）、`retry`（失败重试次数）、`continue_on_error`（失败不中断后续步骤）。workflow 可自带顶层 `env`（注入所有 step；同名时压过 step `params` 与 config.yaml，见 docs/action.md）与 `params`（同 action 的 ParamSpec，`id` 不可用 `steps`/`env`/`params`/`config` 保留字）。每个 step 执行完自动产出 `outputs`（exit_code/stdout/stderr/success，脚本可用 `##[output key=value]` 追加自定义 key），供后续 step 通过 `${{ steps.<id>.outputs.<key> }}` 或 `if` 表达式引用。校验逻辑在 `workflow.Validate`。

完整字段文档：[docs/workflow.md](docs/workflow.md)。

## AI 任务 YAML（ai/*.yaml）

与动作、工作流并列的第三种可执行物：YAML 里不写命令，只写角色、任务正文、输入与运行约束，交给 pi（唯一 AI 运行器，ADR-0008）执行。顶层字段共 13 个：`id`（`^[a-z0-9-]+$`，`ai/` 内唯一）+ `title` 必填；可选 `icon`/`description`/`color`/`params`/`presets`/`system`/`timeout`/`cwd`/`env`/`skills`；`prompt` 键必须出现（可为空串，表示提示词由调用方给入）。`params`/`presets` 结构同动作，多两条约束：参数 id 不能是保留运行参数 `prompt`/`system`/`resume`（三者无需声明即接受），预设值的键必须是已声明参数或保留运行参数。`model`/`effort`/`permission` 等十个预留字段写进 YAML 即加载失败。校验逻辑在 `ai.Validate`（经 `ai.Parse` 严格解析，未知键报错）。

完整字段文档：[docs/ai.md](docs/ai.md)。

## 片段 YAML（fragments.yaml）

`fragments: [{title, content, tags, color}]`（`color` 可选，色卡五色之一；不在色卡内的值读写时一律按未设置处理），UI 侧「片段」视图按 tag 分组浏览、内容支持 `${VAR}` 展开预览、一键复制，每条片段可用 `color` 自选卡片颜色。CRUD 在前端编辑后由后端写回 YAML。

## 改动注意

- 改 `internal/api` 包（任意域文件）的 Service 方法签名/类型后，**必须** `wails3 generate bindings` → `npm run build` → `go build`（或直接 `bash deploy/build.sh`），否则前端调用报 "method ID not found"。
- 锁定 Wails `v3.0.0-alpha2.119`（CLI 与库同版本），**不要升到 alpha.3**（绑定机制损坏）。
- 新增前端静态文案只改 `frontend/src/i18n/locales/{zh,en}.json`；动作 `title/description` 与后端 stdout/stderr 不参与 i18n。
- 前端组件优先复用已装 shadcn 原子（`components/ui/` 下 26 个）；`IconButton` 是项目封装（Button + Tooltip + aria-label），需要图标按钮时优先用它，避免重新手写 `<button>` + tailwind。
- 修改 action / workflow / AI 任务的 **YAML schema**（字段增删改、校验逻辑变动）后，**必须同步更新** `docs/action.md`、`docs/workflow.md` 和 `docs/ai.md`——这三份文档是面向使用者的完整字段参考，schema 改了文档不跟等于挖坑。
- 同理，改 `schedules.yaml` 的目标种类或 params 校验、运行记录 / 运行日志 / 应用日志的形状与保留策略后，**必须同步更新** `docs/runs.md`（以及 `docs/ai.md` 的「调度」一节）。
- 改调度发起路径（`api/executor.go`）时记住两条接缝：`spawnExecutor` 包级变量在测试里被换成「当前进程内跑 `cli.ExecuteRecord`」，所以**调度指向的目标必须落在磁盘上**（夹具里只放在内存 registry 的目标，执行器重新加载目录时找不到）；执行器的停止标记轮询间隔是真实的一秒，取消执行器运行的用例要等它收尾（否则它还在往用例的临时目录里写，`TempDir` 清理会偶发失败）。`internal/procinfo` 的 Windows 分支（PowerShell `Get-Process`）与执行器真进程拉起（`spawnExecutorProcess`）**没有自动化测试覆盖**，改到时要在 Windows 上手动验证。
- 步骤卡（`WorkflowStepList`）的开合是**受控**的：base-ui 的非受控 `defaultOpen` 只在首次挂载时生效，而步骤卡总是以 pending 态先挂载，靠 `defaultOpen` 表达「运行中 / 出错 / AI 步骤默认展开」不会生效（2026-11 之前就是这样，AI 步骤的工序段因此看不到）。新增「默认展开」的条件改 `wantOpen`，别改回 `defaultOpen`。
- AI 相关术语以 [CONTEXT.md](CONTEXT.md) 为准：叫「AI 任务」「AI 步骤」「保留运行参数」「无人值守守则」，不再叫 LLM 动作 / LLM 步骤。

## Agent skills

### Issue tracker

事项与规格记录在 GitHub Issues。见 `docs/agents/issue-tracker.md`。

### Triage labels

使用五个默认 triage 标签。见 `docs/agents/triage-labels.md`。

### Domain docs

采用单仓领域文档布局。见 `docs/agents/domain.md`。
