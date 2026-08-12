# Action 动作定义指南

动作（Action）是 Workflow Tool 的基本执行单元。在 `actions/` 目录下放一个 `.yaml` 文件即可新增一个动作，无需写代码。

## 完整字段参考

```yaml
id: my-action                  # 必填，^[a-z0-9-]+$ 全局唯一
title: 我的动作                 # 必填，按钮/卡片显示文字
icon: hi:play                  # 可选，hugeicons 图标 key 或 emoji
description: 简要说明           # 可选，UI 悬停提示

command:
  shell: echo hello            # 形态 A：内联 shell 命令
  # script: ./scripts/foo      # 形态 B：脚本文件
  # adb: { operation: push }   # 形态 C：adb 域操作
  # llm: { system: ROLE, prompt: TASK }   # 形态 D：LLM 调用
  cwd: ${SOME_DIR}             # 可选，工作目录，默认用户主目录
  timeout: 60s                 # 可选，超时（Go duration），默认 60s
  stream: ""                   # 可选，"" 普通逐行 | "logcat" 结构化 logcat JSON
  env:                         # 可选，追加到进程环境变量
    KEY: value
  capture_output: true         # 可选，默认 true；false 关闭全量 stdout/stderr 捕获

params:                        # 可选，参数表单
  - id: URL                    # 参数 ID，用于 ${URL} 引用
    label: 网址                # 表单标签
    type: text                 # text | bool | select | path | file | textarea
    required: true             # 未填时「运行」按钮禁用
    default: ""                # 默认值
    options: []                # select 类型必填

presets:                       # 可选，预设参数组合
  - name: 首页
    description: 可选描述
    values: { URL: https://example.com }
```

## 字段详解

### id

- 格式：`^[a-z0-9-]+$`（小写字母、数字、连字符）
- 全局唯一，重复 id 加载时报错
- 同时用作事件通道名：`action:<id>:output` / `action:<id>:done`

### command

`shell`、`script`、`adb`、`llm` **四选一互斥**，必须指定其一。

| 字段 | 说明 |
|------|------|
| `shell` | 内联命令，macOS/Linux 用 `sh -c` 执行，Windows 用 PowerShell |
| `script` | 脚本路径（不含扩展名），按 OS 自动加 `.sh` / `.ps1`，相对路径基于 exe 目录 |
| `adb` | adb 域操作（详见下方「adb 域形态」章节） |
| `llm` | LLM 调用（详见下方「LLM 域形态」章节） |
| `cwd` | 工作目录，支持 `${VAR}` 替换，默认 `$HOME` |
| `timeout` | Go duration 格式（`30s` / `5m` / `1h`），默认 `60s` |
| `stream` | 空 = 普通逐行输出；`"logcat"` = 结构化 logcat JSON（adb logcat-stream 域专用，前端切 logcat 视图） |
| `env` | 键值对，追加到当前环境变量 |
| `capture_output` | 布尔（默认 true）；`false` = 不捕获全量 stdout/stderr，长跑/持续输出 action 用 |

### params（参数表单）

每个参数对应前端表单的一个控件：

| type | 渲染为 | 说明 |
|------|--------|------|
| `text` | 文本输入框 | 支持拖拽文件路径 |
| `bool` | 开关 | 值为 `"true"` / `"false"` |
| `select` | 下拉选择 | 必须提供 `options` 数组 |
| `path` | 路径输入 + 选择按钮 | 调用系统**目录**对话框（选目录），支持拖拽 |
| `file` | 路径输入 + 选择按钮 | 调用系统**文件**对话框（选单个文件），支持拖拽。需选文件的参数（如 `adb-push` 的 LOCAL_PATH、`adb-install` 的 APK_PATH）用此类型 |
| `textarea` | 多行文本域 | 自适应高度、等宽字体；用于 LLM prompt 模板、长脚本片段等多行内容 |

参数值在命令中用 `${ID}` 引用。

### presets（预设）

作者定义的常用参数组合。UI 行为：
- 侧边栏：单击 preset → 进表单（预填值），双击 → 直接运行
- Grid 卡片：preset chip 点击直接运行

### icon

两种写法：
- `hi:<key>`：渲染 hugeicons 矢量图标（key 见 `frontend/src/components/ActionIcon.tsx`）
- emoji 或任意文本：原样显示

常用图标 key：`play` / `file` / `package` / `car` / `voice` / `ai` / `test` / `settings` / `workflow`

## 变量替换

运行时由 `runner.Expand` 处理，替换优先级：

1. **动作参数**（params 表单填入的值）
2. **全局配置**（`config.yaml` 中的键值对）
3. **环境变量**

三者都未定义则保留 `${VAR}` 原样 + 控制台 warning。

### workflow 中的变量优先级扩展

当 action 被 workflow 引用时，变量优先级变为：

params（step.params）> step.env > workflow.env > config.yaml > 系统环境变量

`stream: logcat` action 之外，`command.llm` action 在 workflow 中运行时，即使 `capture_output: false`，仍会提取结构化 outputs（text/thinking/session_id/cost_usd/total_tokens），因为这些来自 stream-json 语义解析而非原始 stdout 转储。

## LLM 域形态（command.llm）

LLM 是与 `adb` 并列的一等执行形态：作者只声明「哪个 param 是系统提示（system），哪个是用户提示（prompt）」，CLI 拼装、stream-json 解析、system 的安全传参全部由内置 **LLMRunner** 兜住，不需要手写任何 CLI flag。

```yaml
command:
  llm:
    system: ROLE   # 可选，param id → 作为 --append-system-prompt 的独立参数传给 CLI
    prompt: TASK   # 必填，param id → 写入子进程 stdin
  timeout: 5m       # 仍适用，默认 60s（LLM 调用建议显式设更长超时）
```

### 工作机制

- **CLI 名**：从全局配置 `config.yaml` 的 `LLM_CLI` 读取，缺省 `ducc`；一处改全局切换到 `claude` 等其他 CLI。
- **固定拼装**：`<LLM_CLI> -p --output-format=stream-json --verbose --thinking enabled [--append-system-prompt <system值>]`。
- **system 是独立 argv，不经 shell 字符串**：LLMRunner 直接 `exec.Command` 构造进程，`system` 作为 `--append-system-prompt` 的独立参数传入，多行、引号、`$`、`` ` `` 都零转义风险——这是它相对旧版「拼进 shell 字符串」方案的核心收益。
- **prompt 走 stdin**：同样不经 shell 字符串，`prompt` 指向的 param 值直接写入子进程 stdin。
- **输出**：解析 stdout 的 stream-json 格式，只提取 assistant 的 **thinking**（思考过程）和 **text**（回复）增量推送前端（`"llm-thinking"` / `"llm"` 事件）；stderr 原样转发不解析；system/hook/result 及无法解析的行静默跳过。
- **前端**：`command.llm` 动作的表单（`LlmForm`）把 `prompt` 对应的 param 放在主位（大号 textarea，优先聚焦），`system` 对应的 param 折叠进「角色设定」（默认收起，偶尔调整）；运行后自动切换到 LLM 视图（可折叠思考块 + Markdown 流式渲染）。

### 示例

```yaml
id: claude-ask
title: 问 LLM
icon: hi:ai
params:
  - id: QUESTION
    label: 问题
    type: textarea
    required: true
command:
  llm:
    prompt: QUESTION
  timeout: 5m
```

**Prompt 场景封装成 action**：把「意图不变、只是动态参数不同」的分析任务（bug 卡片分析、日志根因定位……）做成一个 action，`system` 承载稳定的角色模板，`prompt` 承载含 `${OTHER_PARAM}` 引用的动态任务文本：

```yaml
id: claude-bug-analyze
title: 分析 bug 卡片
params:
  - id: ROLE
    label: 角色设定（系统提示）
    type: textarea
    required: true
    default: 你是车载语音 bug 分析师，给出根因假设与验证命令。
  - id: BUG_URL
    label: iCafe 卡片链接
    type: text
    required: true
  - id: TASK
    label: 分析任务
    type: textarea
    required: true
    default: |
      根据 ${BUG_URL} 给出根因假设与验证命令。
command:
  llm:
    system: ROLE
    prompt: TASK
  timeout: 5m
```

新增一个分析场景 = 复制一份 YAML 改 params + system/prompt 模板，前后端代码不需要再改。

前置：本地须安装对应 CLI（`ducc` 或 `claude`）。

## 脚本形态（script）

`script` 字段指向脚本文件路径（不含扩展名），运行时按 OS 自动拼接：

- macOS / Linux → `<script>.sh`（用 `sh -c` 执行）
- Windows → `<script>.ps1`（用 PowerShell 执行）

路径规则：
- 相对路径基于 **exe 所在目录**（非 cwd）
- 推荐放在 `scripts/` 目录下

示例：

```yaml
command:
  script: ./scripts/adb-install
  timeout: 5m
```

对应文件：`scripts/adb-install.sh`（Mac）/ `scripts/adb-install.ps1`（Windows）。

## adb 域形态（command.adb）

`shell`/`script` 之外，`command.adb` 是第三种执行形态，调用内置 **ADBRunner**，按 `operation` 分发到原生 Go 封装的 adb 域服务（包管理 / logcat / 文件传输 / scrcpy）。相比裸 `adb shell`，它提供：设备 serial 自动解析、二进制路径探测、进度/取消、结构化过滤，且无需手写脚本。

```yaml
command:
  adb:
    operation: install-package   # 域操作名，见下表
  timeout: 5m                    # 仍适用
  capture_output: false          # 长跑/持续输出（logcat/scrcpy）建议 false
```

### 工作机制

- **设备解析**：优先用 params 里的 `ADB_SERIAL`（由后端根据前端设备选择器自动注入）；为空则取首个 ready 设备。所以运行 adb 域动作前先在侧边栏设备选择器里选一个设备。
- **二进制路径**：`ADB_PATH`/`FASTBOOT_PATH`/`SCRCPY_PATH` 从 `config.yaml` 读取，空则按级联探测（config → PATH → 常见安装路径）。
- **输出**：逐行经 `emit` 推送到与 shell 动作完全相同的 `action:<id>:output` 事件通道；文件传输进度走 `stream: "progress"`。
- **取消**：与所有动作一样，点「停止」即 cancel ctx，流式命令（logcat/scrcpy）随即终止。

### operation 与 params 契约

每个 operation 从 action params 取输入字段（大写下划线命名）。所有 operation 公共：`ADB_SERIAL`（可空，空则自动选）。下面只列出各 operation 的专属字段。

**包管理（9）**

| operation | params | 说明 |
|---|---|---|
| `install-package` | `APK_PATH`(file,必填)、`ALLOW_TEST`(bool)、`ALLOW_DOWNGRADE`(bool) | `adb install -r [-t] [-d] <apk>`；校验 .apk 后缀 |
| `uninstall-package` | `PACKAGE`(text,必填) 或 `PACKAGES`(text,多个空格分隔) | 单/批卸载 |
| `list-packages` | `FILTER`(select: user/system/all，默认 all) | 并发合并 enabled/disabled 状态 |
| `enable-package` / `disable-package` | `PACKAGE` 或 `PACKAGES` | 批量部分成功计数 |
| `clear-data` | `PACKAGE`(必填) | `pm clear` |
| `force-stop` | `PACKAGE`(必填) | `am force-stop` |
| `pull-apk` | `PACKAGE`(必填) | `pm path` → `adb pull` 到临时目录，输出路径经 stdout |
| `package-details` | `PACKAGE`(必填) | 版本号 / APK 大小 / 数据大小 |

**结构化 logcat（2）**

| operation | params | 说明 |
|---|---|---|
| `logcat-stream` | `PACKAGE`、`LEVEL`、`TAG`、`INCLUDE`、`EXCLUDE` | 前台实时流式；手动停止 |
| `logcat-batch` | `LOGS_DIR`(path,必填)、`PACKAGE`、`LEVEL`、`TAG`、`INCLUDE`、`EXCLUDE`、`CLEAR_BUFFER`(bool) | 抓取到 `logcat_<时间戳>.log`；`CLEAR_BUFFER=true` 才在抓取前 `logcat -c`（默认不清空，避免丢历史） |

过滤语义：`LEVEL` 为最低阈值（单字母 V/D/I/W/E/F，行 level ≥ 阈值才通过）；`TAG` 多个空格分隔、任一子串命中即通过；`INCLUDE`/`EXCLUDE` 对 message 做子串包含/排除。`PACKAGE` 仿 Android Studio Logcat 的包名过滤：启动时 `adb shell pidof <pkg>` 解析为 pid（多进程应用可返回多个 pid），Go 端按 pid 过滤。`logcat-stream` 额外每 5s 重试解析，故可在应用启动前先开 logcat、应用重启后自动跟上（app 未运行时该包无输出）。`logcat-stream` 配 `stream: logcat` 时为**双层过滤**：这里的服务端预过滤（PACKAGE/LEVEL/TAG/INCLUDE/EXCLUDE）减少 IPC 量，前端 logcat 视图另可运行时按 level/tag/message 对已缓冲条目再过滤，无需重启。

**文件传输（10）**

| operation | params | 说明 |
|---|---|---|
| `push` | `LOCAL_PATH`(file,必填)、`REMOTE_PATH`(text,必填) | 推送单个文件，进度推送、3 次重试、可取消 |
| `pull` | `REMOTE_PATH`(必填)、`LOCAL_PATH`(path,必填) | 拉取单个文件 |
| `push-multiple` | `LOCAL_PATH`(path,必填)、`REMOTE_PATH`(必填) | 本地目录 → 远程目录 |
| `pull-multiple` | `REMOTE_PATH`(必填)、`LOCAL_PATH`(path,必填) | 远程目录 → 本地目录 |
| `list-files` | `REMOTE_PATH`(默认 `/sdcard/`)、`SHOW_HIDDEN`(bool) | 列目录 |
| `mkdir` | `REMOTE_PATH`(必填) | 创建远程目录 |
| `delete` | `REMOTE_PATH`(必填) | 删除远程文件/目录 |
| `rename` | `REMOTE_PATH`(必填)、`NEW_REMOTE_PATH`(必填) | 重命名/移动 |
| `directory-size` | `REMOTE_PATH`(必填) | 远程目录占用大小 |
| `storage-info` | `REMOTE_PATH`(必填) | 挂载点总/已用/可用 |

远程路径会做规范化与 `..` 拦截。`push`/`pull` 进度经 `stream: "progress"` 推送。

**scrcpy（6）**

| operation | params | 说明 |
|---|---|---|
| `scrcpy-start` | 见下方选项表 | 前台投屏，关窗即停；手动停止 kill 进程组 |
| `scrcpy-record-start` | `RECORD_PATH`(path,必填) + 见下方选项表 | 无头录屏（`--no-playback`），后台进行，可独立停止 |
| `scrcpy-record-stop` | 无 | 停止当前设备的录制，校验输出文件非空 |
| `clipboard-set` | `TEXT`(text,必填) | 设置设备剪贴板 |
| `clipboard-get` | 无 | 读取设备剪贴板，结果经 stdout |
| `screenshot` | `OUTPUT_PATH`(path,必填) | `exec-out screencap -p` 存到本地 |

`scrcpy-start` / `scrcpy-record-start` 的投屏选项（均为可选，整数类空=不传）：

| param | 类型 | 说明 |
|---|---|---|
| `MAX_SIZE` | int | `--max-size` |
| `BIT_RATE` | int | `--video-bit-rate` |
| `MAX_FPS` | int | `--max-fps` |
| `AUDIO_BIT_RATE` | int | `--audio-bit-rate` |
| `VIDEO_CODEC` | text | `--video-codec`（h264 默认不传） |
| `AUDIO_CODEC` | text | `--audio-codec`（opus 默认不传） |
| `SHOW_TOUCHES` / `NO_AUDIO` / `NO_CONTROL` / `STAY_AWAKE` / `TURN_SCREEN_OFF` / `POWER_OFF_ON_CLOSE` / `FULLSCREEN` / `ALWAYS_ON_TOP` / `DISABLE_SCREENSAVER` | bool | 对应同名 scrcpy flag |
| `ROTATION` / `DISPLAY_ID` / `TIME_LIMIT` | int | `--display-orientation` / `--display-id` / `--time-limit` |

### 示例

```yaml
id: adb-push
icon: hi:upload
title: 推送文件
params:
  - { id: LOCAL_PATH, label: 本地文件, type: file, required: true }
  - { id: REMOTE_PATH, label: 远程路径, type: text, required: true, default: /sdcard/ }
command:
  adb: { operation: push }
  timeout: 10m
```

## 实际示例

### 最简动作

```yaml
id: hello
title: 打个招呼
icon: 👋
command:
  shell: echo "Hello, World!"
```

### 带参数 + 预设

```yaml
id: adb-keyevent
title: 模拟按键
icon: hi:flash
description: 模拟设备按键（input keyevent），常用键见预设
params:
  - id: KEYCODE
    label: KEYCODE（数字）
    type: text
    required: true
    default: "3"
presets:
  - name: HOME（3）
    values: { KEYCODE: "3" }
  - name: BACK（4）
    values: { KEYCODE: "4" }
command:
  shell: adb shell input keyevent "${KEYCODE}"
  timeout: 30s
```

### 带条件逻辑

```yaml
id: adb-scrcpy
title: 投屏
icon: hi:play
params:
  - id: RECORD
    label: 录屏
    type: bool
    default: "false"
  - id: RECORD_PATH
    label: 录屏保存路径
    type: path
command:
  shell: |
    args="--window-title=Scrcpy"
    if [ "${RECORD}" = "true" ] && [ -n "${RECORD_PATH}" ]; then
      args="$args --record=${RECORD_PATH}/scrcpy-$(date +%Y%m%d_%H%M%S).mp4"
    fi
    eval scrcpy $args
  timeout: 24h
```

## 校验规则

加载时由 `registry.Validate` 校验，不合法的文件会被跳过并记录错误：

- `id` 必须匹配 `^[a-z0-9-]+$`
- `title` 必填
- `shell` 与 `script` 与 `adb.operation` 与 `llm.prompt` **四选一、互斥**
- `params[].type` 只允许 `text` / `bool` / `select` / `path` / `file` / `textarea`
- `select` 类型必须提供 `options`
- `stream` 只允许空 或 `"logcat"`
- `command.llm.prompt` 必填时对应 param 必须存在于 `params` 中；`command.llm.system` 非空时同样校验
- 同一目录下 id 不可重复

## 生效方式

新增/修改 YAML 后**重启 exe** 生效（启动时扫描 `actions/*.yaml`）。
