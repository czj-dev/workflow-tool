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
  # script: ./scripts/foo      # 形态 B：脚本文件（与 shell 二选一）
  cwd: ${SOME_DIR}             # 可选，工作目录，默认用户主目录
  timeout: 60s                 # 可选，超时（Go duration），默认 60s
  stream: ""                   # 可选，"" 普通逐行 | "llm" 解析 stream-json
  env:                         # 可选，追加到进程环境变量
    KEY: value
  capture_output: true         # 可选，默认 true；false 关闭全量 stdout/stderr 捕获

params:                        # 可选，参数表单
  - id: URL                    # 参数 ID，用于 ${URL} 引用
    label: 网址                # 表单标签
    type: text                 # text | bool | select | path
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

`shell` 与 `script` 必填其一，互斥。

| 字段 | 说明 |
|------|------|
| `shell` | 内联命令，macOS/Linux 用 `sh -c` 执行，Windows 用 PowerShell |
| `script` | 脚本路径（不含扩展名），按 OS 自动加 `.sh` / `.ps1`，相对路径基于 exe 目录 |
| `cwd` | 工作目录，支持 `${VAR}` 替换，默认 `$HOME` |
| `timeout` | Go duration 格式（`30s` / `5m` / `1h`），默认 `60s` |
| `stream` | 空 = 普通逐行输出；`"llm"` = 解析 stream-json 格式（见下） |
| `env` | 键值对，追加到当前环境变量 |
| `capture_output` | 布尔（默认 true）；`false` = 不捕获全量 stdout/stderr，长跑/持续输出 action 用 |

### params（参数表单）

每个参数对应前端表单的一个控件：

| type | 渲染为 | 说明 |
|------|--------|------|
| `text` | 文本输入框 | 支持拖拽文件路径 |
| `bool` | 开关 | 值为 `"true"` / `"false"` |
| `select` | 下拉选择 | 必须提供 `options` 数组 |
| `path` | 路径输入 + 选择按钮 | 调用系统目录对话框，支持拖拽 |

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

`stream: llm` action 在 workflow 中运行时，即使 `capture_output: false`，仍会提取结构化 outputs（text/thinking/session_id/cost_usd/total_tokens），因为这些来自 stream-json 语义解析而非原始 stdout 转储。

## LLM 流式模式（stream: llm）

为 `claude -p` 等逐 token 输出的 LLM 命令设计。标记 `stream: llm` 后：

- api 层按 `Command.Stream` 选择执行器：`"llm"` 用 `LLMRunner`，其余用 `ShellRunner`（原先是 `ShellRunner` 内部按 `Stream` 字段分支处理，现改为 api 层选型；YAML 字段本身的 `""`/`"llm"` 语义不变，向后兼容不受影响）
- `LLMRunner` 解析 stdout 的 stream-json 格式
- 只提取 assistant 的 **thinking**（思考过程）和 **text**（回复）增量推送前端
- 前端切换到专用 LLM 视图：可折叠思考块 + Markdown 流式渲染
- system / hook / result 及无法解析的行静默跳过

示例：

```yaml
id: claude-ask
title: 问 Claude
icon: hi:ai
params:
  - id: QUESTION
    label: 问题
    type: text
    required: true
command:
  shell: claude -p "${QUESTION}" --output-format=stream-json --verbose --thinking enabled
  stream: llm
  timeout: 5m
```

前置：本地须安装 `claude` CLI。

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
| `install-package` | `APK_PATH`(path,必填)、`ALLOW_TEST`(bool)、`ALLOW_DOWNGRADE`(bool) | `adb install -r [-t] [-d] <apk>`；校验 .apk 后缀 |
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
| `logcat-stream` | `LEVEL`、`TAG`、`INCLUDE`、`EXCLUDE` | 前台实时流式；手动停止 |
| `logcat-batch` | `LOGS_DIR`(path,必填)、`LEVEL`、`TAG`、`INCLUDE`、`EXCLUDE`、`CLEAR_BUFFER`(bool) | 抓取到 `logcat_<时间戳>.log`；`CLEAR_BUFFER=true` 才在抓取前 `logcat -c`（默认不清空，避免丢历史） |

过滤语义：`LEVEL` 为最低阈值（单字母 V/D/I/W/E/F，行 level ≥ 阈值才通过）；`TAG` 多个空格分隔、任一子串命中即通过；`INCLUDE`/`EXCLUDE` 对 message 做子串包含/排除。

**文件传输（10）**

| operation | params | 说明 |
|---|---|---|
| `push` | `LOCAL_PATH`(path,必填)、`REMOTE_PATH`(text,必填) | 推送单个文件，进度推送、3 次重试、可取消 |
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
  - { id: LOCAL_PATH, label: 本地路径, type: path, required: true }
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
id: adb-query
title: 测试 Query
icon: hi:voice
description: 发送语音 query 广播
params:
  - id: QUERY
    label: Query 内容
    type: text
    required: true
    default: 你好小度
presets:
  - name: 你好小度
    values: { QUERY: 你好小度 }
  - name: 打开空调
    values: { QUERY: 打开空调 }
command:
  shell: adb shell am broadcast -a vr.intent.action.QUERY --es query "${QUERY}"
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
- `shell` 与 `script` 与 `adb.operation` 三选一、互斥
- `params[].type` 只允许 `text` / `bool` / `select` / `path`
- `select` 类型必须提供 `options`
- `stream` 只允许空或 `"llm"`
- 同一目录下 id 不可重复

## 生效方式

新增/修改 YAML 后**重启 exe** 生效（启动时扫描 `actions/*.yaml`）。
