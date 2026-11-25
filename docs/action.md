# Action 动作定义指南

动作（Action）是 Workflow Tool 的基本执行单元。在 `actions/` 目录下放一个 `.yaml` 文件即可新增一个动作，无需写代码。

## 完整字段参考

```yaml
id: my-action                  # 必填，^[a-z0-9-]+$ 全局唯一
title: 我的动作                 # 必填，按钮/卡片显示文字
icon: hi:play                  # 可选，hugeicons 图标 key 或 emoji
color: blue                    # 可选，卡片氛围色：amber | green | blue | violet（不写按组序循环）
description: 简要说明           # 可选，UI 悬停提示

command:
  run: echo hello              # 形态 A：内联命令（GHA 风格）
  shell: bash                  # 可选修饰：解释器，默认 bash
  # script: ./scripts/foo.sh   # 形态 B：脚本文件（带扩展名）
  # adb: { operation: push }   # 形态 C：adb 域操作
  cwd: ${SOME_DIR}             # 可选，工作目录；不写则继承应用进程的工作目录
  timeout: 60s                 # 可选，超时（Go duration），默认 60s
  stream: ""                   # 可选，"" 普通逐行 | "logcat" 结构化 logcat JSON
  env:                         # 可选，追加到进程环境变量
    KEY: value
  capture_output: true         # 可选，默认 true；false 关闭全量 stdout/stderr 捕获

params:                        # 可选，参数表单
  - id: URL                    # 参数 ID，用于 ${URL} 引用
    label: 网址                # 表单标签
    type: text                 # text | bool | select | path | file | textarea | list | arguments
    required: true             # 未填时「运行」按钮禁用
    default: ""                # 默认值
    options: []                # select 类型必填
    description: 可选说明      # 渲染在字段下方的灰色提示文案

presets:                       # 可选，预设参数组合
  - name: 首页
    description: 可选描述
    values: { URL: https://example.com }

hmi:                           # 可选，声明动作输出的交互视图
  tree: {}                      # 声明后才将 tree 流渲染为树；无 click 时叶子复制路径
  # tree:
  #   click:
  #     action: other-action    # 点击叶子后运行的目标动作，可跨 action
  #     multi: true             # 可选，树块开启勾选多选 + 批量按钮（见「树帧」章节）
  #     params:
  #       FILE: '${{ node.path }}'      # 显式映射，不自动继承来源参数；单击叶子时求值
  #       FILES: '${{ nodes.paths }}'   # 多选批量时求值：选中 path 换行拼接；单击时为单元素
```

## 字段详解

### id

- 格式：`^[a-z0-9-]+$`（小写字母、数字、连字符）
- 全局唯一，重复 id 加载时报错
- 同时用作事件通道名：`action:<id>:output` / `action:<id>:done`

### command

`run`、`script`、`adb` **三选一互斥**，必须指定其一。调用 Agent CLI 不属于动作的任何形态——那是独立的 AI 任务，见 [ai.md](ai.md)。

| 字段 | 说明 |
|------|------|
| `run` | 内联命令（GHA 风格），写入临时脚本文件执行。默认 `bash`（Windows 自动探测 Git Bash）；多行块照旧支持 |
| `script` | 脚本文件路径（必须带扩展名），按扩展名路由解释器：`.sh`→bash、`.ps1`→pwsh、`.py`→python、`.js`→node；显式 `shell` 时不校验扩展名 |
| `shell` | 可选修饰字段：解释器逻辑名，默认 `bash`。可选 `bash`/`sh`/`pwsh`/`powershell`/`python`/`node`/`cmd`，或含 `{0}` 的自定义模板（如 `"perl {0}"`，按空白分词）。只允许搭配 `run`/`script` 形态 |
| `adb` | adb 域操作（详见下方「adb 域形态」章节） |
| `cwd` | 工作目录，支持 `${VAR}` 替换；不写则继承应用进程的工作目录 |
| `timeout` | Go duration 格式（`30s` / `5m` / `1h`），默认 `60s` |
| `stream` | 空 = 普通逐行输出；`"logcat"` = 结构化 logcat JSON（adb logcat-stream 域专用，前端切 logcat 视图） |
| `env` | 键值对，追加到当前环境变量 |
| `capture_output` | 布尔（默认 true）；`false` = 不捕获全量 stdout/stderr，长跑/持续输出 action 用 |

### params（参数表单）

每个参数对应前端表单的一个控件：

| type | 渲染为 | 说明 |
|------|--------|------|
| `text` | 文本输入框 | 支持拖拽文件路径（多个路径空格拼接） |
| `bool` | 开关 | 值为 `"true"` / `"false"` |
| `select` | 下拉选择 | 必须提供 `options` 数组 |
| `path` | 路径输入 + 选择按钮 | 调用系统**目录**对话框（选目录），支持拖拽（多选只取第一个） |
| `file` | 路径输入 + 选择按钮 | 调用系统**文件**对话框（选单个文件），支持拖拽（多选只取第一个）。需选文件的参数（如 `adb-push` 的 LOCAL_PATH、`adb-install` 的 APK_PATH）用此类型 |
| `textarea` | 多行文本域 | 自适应高度、等宽字体；用于长文本、多行命令片段等多行内容 |
| `list` | 可增删、排序的字符串行 | 值为 JSON 字符串数组，如 `'["DVR_A","DVR_B"]'`；空值用 `'[]'` |
| `arguments` | 可增删、排序的 flag/多值行 | 值为 JSON 数组字符串，如 `'[{"flag":"--es","values":["key","hello world"]},{"flag":"-W","values":[]}]'`；重复 flag 与行顺序保留 |

`list` / `arguments` 的非空 `default` 和 `presets[].values` 都须写成 **JSON 字符串**（外层 YAML 引号），不是 YAML 数组；加载动作或保存预设前会校验 JSON 形状。旧 logcat 预设的 `TAG` 可保留旧格式，但仅在同一预设提供有效 `FILTER` 且其覆盖 `TAG` 时。`list` 的元素必须是字符串；`arguments` 的每行含 `flag` 字符串和 `values` 字符串数组，无值 flag 用空数组。留空 `default` 表示未设置；可选字段的 `'[]'` 表示空数组，required 字段的 `'[]'` 视为未填写，至少须有一行。参数值在命令中用 `${ID}` 引用；若是 `command.run`，可从对应的 `$ID` 环境变量读 JSON，避免直接拼接到脚本源码。

可选 `description`：渲染在该字段控件下方的灰色说明文案（bool 类型渲染在 label 下方），用于写清取值示例或注意事项。不填则不占位。

#### 拖拽文件路径

从文件管理器把文件或文件夹拖到窗口里，按**松手时鼠标的位置**写入对应输入框（不需要先点击聚焦）。落在字段标签、图标、「选择」按钮上也算命中该字段；落在没有输入框的地方则不做任何事，无提示。

- 值**整体覆盖**原有内容，写入后光标留在该框内
- 拖入多个时按系统给出的顺序**空格拼接**，含空格的路径自动加双引号（如 `/a/x.txt "/b/My Docs/y.txt"`）；`path` / `file` 类型只取第一个
- 顺序只与系统给出的数组一致，**不保证等于文件管理器里看到的排列**
- 只处理空格，路径自带引号或 shell 特殊字符不做转义
- 片段视图里未定义的变量 pill（红框）也可以拖入，落下即填好，不需要先点开它

### presets（预设）

作者定义的常用参数组合。UI 行为：
- 侧边栏：单击 preset → 进表单（预填值），双击 → 直接运行
- Grid 卡片：preset chip 点击直接运行

### icon

两种写法：
- `hi:<key>`：渲染 hugeicons 矢量图标（key 见 `frontend/src/components/ActionIcon.tsx`）
- emoji 或任意文本：原样显示

常用图标 key：`play` / `file` / `package` / `car` / `voice` / `ai` / `test` / `settings` / `workflow`

### color

可选的卡片氛围色（四色板白名单）：`amber` / `green` / `blue` / `violet`。写了则该卡图标底色、卡面光晕、边框染色梯度优先用此色；不写按分组显示序循环（同组同色）。非法值加载时报错。见 [ADR-0003](adr/0003-ambient-color.md)。

## 变量替换

运行时由 `runner.Expand` 处理，替换优先级（同名时靠前的胜出）：

1. **`command.env`**（run / script 形态的 env 块）
2. **动作参数**（params 表单填入的值）
3. **全局配置**（`config.yaml` 中的键值对）
4. **内置变量**（见下表，无需声明即可直接使用）
5. **环境变量**

都未定义则保留 `${VAR}` 原样 + 控制台 warning。

`command.env` 排在最前是实现上的取舍：它的终值会被并进查找源，由 Go 侧统一展开 `${VAR}`，PowerShell 脚本里的 `${VAR}` 才能跨平台读到（PowerShell 把 `${VAR}` 当变量语法，读不到环境变量）。代价是动作参数覆盖不了同名的 `command.env`——想用参数控制一个值，就别在 `command.env` 里再定义同名键。

`command.adb.operation` 形态没有 `command.env` 这一层：它的参数值在进入 runner 前已按「动作参数 > 全局配置 > 内置变量 > 环境变量」展开，`command.env` 与 workflow 的 `env` 都不参与查找。

### 内置变量

| 变量 | 值 | 用途示例 |
|---|---|---|
| `CURRENT_DATE` | 当天日期，`yyyyMMdd`（如 `20260819`） | `${OUTPUT_DIR}screenshot-${CURRENT_DATE}.png` |
| `CURRENT_TIME` | 当前毫秒时间戳（如 `1755590400000`） | `${OUTPUT_DIR}${CURRENT_TIME}.png`，避免同名文件覆盖 |
| `ADB_SERIAL` | 当前激活设备 serial（UI 设备选择器选中的设备） | shell/script 动作里 `adb -s "${ADB_SERIAL}" shell ...` |

`ADB_SERIAL` 若在 `config.yaml` 里显式配置，或动作参数、`command.env` 里已有同名值，则内置变量不生效（参数/配置优先级更高，见上）——这是给需要固定某台设备的场景保留的覆盖能力。`command.adb.operation` 形态本身有独立的在线校验与自动重连回退逻辑（详见下方"adb 域形态"），内置变量表里的 `ADB_SERIAL` 主要解决 `command.run`/`script` 形态里引用 `${ADB_SERIAL}` 时同样能取到当前激活设备。

### workflow 中的变量优先级扩展

当 action 被 workflow 引用时，step 的 `env` 与 workflow 的 `env` 也进入查找源，并且同样排在参数之前。变量优先级变为：

step.env > workflow.env > command.env > step.params > workflow.params > config.yaml > 内置变量 > 系统环境变量

- 内联 `run` step 没有 `command.env` 和 `step.params` 这两层：step.env > workflow.env > workflow.params > config.yaml > 内置变量 > 系统环境变量
- `env` 的值本身也是模板：`command.env` 按完整的参数链展开；`step.env` / `workflow.env` 只按 workflow.params 及之后的链展开，引用不到 `step.params`

## AI 调用不属于动作

需要调用 Agent CLI（`claude`、`ducc` 等）时不写动作，而是写一个 AI 任务：`ai/` 目录下的独立定义，有自己的会话页、输入参数、守则与产出，见 [AI 任务定义指南](ai.md)。

动作曾经有第四种形态 `command.llm`，现已整体独立出去，不再被识别——留在 `actions/` 里的这类文件加载时报「command 必须指定 run/script/adb 之一」。迁移方法见 ai.md 的「从 command.llm 迁移」。

## 脚本形态（script）

`script` 字段指向脚本文件路径（**必须带扩展名**），按扩展名路由解释器：

- `.sh` → bash
- `.ps1` → pwsh（未装 pwsh 时回退 Windows PowerShell 5）
- `.py` → python
- `.js` → node

显式写了 `command.shell` 时以它为准，扩展名推断让位（如 `script: ./x.pl` + `shell: "perl {0}"`）。

路径规则：
- 相对路径基于 **exe 所在目录**（非 cwd）
- 推荐放在 `scripts/` 目录下
- 单份维护：不再需要 `.sh` + `.ps1` 双份脚本，同一份文件跨平台执行

示例：

```yaml
command:
  script: ./scripts/spm-download.py
  timeout: 10m
```

## 错误处理语义（run / script 形态）

- `bash`（默认）：`--noprofile --norc -eo pipefail`——任一命令非零即中断、管道取最右非零码
- `sh`：`-e`
- `pwsh` / `powershell`：脚本头注入 `$ErrorActionPreference = 'stop'`；尾部注入退出码传播
  （原生命令如 adb/gradlew 的非零退出码默认不会成为脚本退出码，包装行解决该 PowerShell 经典坑）
- `python` / `node`：异常与退出码自然传播（`python -u` 无缓冲 stdout，保 `##[progress]` 流式）
- `cmd`：无错误语义增强（GHA 亦然）

逃生门：脚本内 `set +e`、`|| true`、`$ErrorActionPreference = 'Continue'` 照常有效——
默认严格、显式放宽。

内联 `run` 的内容写入临时脚本文件（LF 行尾）执行，无引号/转义边界问题；`script` 直接
执行真实文件，不落副本。

## Windows bash 探测级联

`bash`/`sh` 在 Windows 按以下顺序解析（绝不静默回退 PowerShell，找不到即报错）：

1. `config.yaml` 的 `BASH_PATH`（显式覆盖）
2. `PATH` 中的 bash（排除 `C:\Windows\System32\bash.exe`——那是 WSL 入口，语义完全不同）
3. 常见安装路径：`C:\Program Files\Git\bin` → `C:\Program Files\Git\usr\bin` →
   `C:\Program Files (x86)\Git\bin` → `C:\msys64\usr\bin` → `C:\msys64\bin`

找不到时安装 Git for Windows 或设置 `BASH_PATH`。macOS/Linux 直接用 PATH。

## 输出协议（run / script 形态）

`run` 与 `script` 动作可以在 stdout 里写协议行，让宿主对该行做特殊处理。协议行必须独占一行，`##[` 前后允许空白。

| 协议行 | 作用 |
|---|---|
| `##[output key=value]` | 解析为该 step 的 `outputs.key`，供 workflow 后续 step 用 `${{ steps.<id>.outputs.key }}` 引用。该行**仍会**照常显示在输出里 |
| `##[progress 文本]` | 文本以「进度流」推送，前端**原地覆盖**上一条进度行（模拟终端 `\r` 刷新）。该行不显示协议壳、不进 stdout 捕获，因此不污染 `outputs.stdout` |
| `##[tree <json>]` | 以 `stream: "tree"` 推送；仅声明 `hmi.tree` 的 action 渲染为可交互树，未声明时作为普通文本显示。该行不进 stdout 捕获；schema 见下节 |

进度协议的用途是长任务的单行滚动读数（下载百分比、逐块计数等）。裸 `\r` 不行：宿主的行扫描把 `\r` 也当行结束符（见 `internal/runner/exec.go` 的 `splitLines`），于是每次刷新都变成追加一行。

```python
# python：注意 flush，管道下默认块缓冲会把进度攒到退出才吐
print(f"##[progress 下载 {done * 100 // total}%  {done}/{total} 字节]", flush=True)
```

```sh
# sh：逐行输出天然无缓冲
echo "##[progress 上传 $i/$n]"
```

Python 脚本更稳的做法是在 wrapper 里加 `-u`（`python3 -u foo.py`），一次性关掉缓冲，不必逐处 `flush=True`。

### 树帧（##[tree]）

树帧是输出流的第三种内容形态（文本行 / progress 单行之外）：一帧 = 一棵完整树。只有 action 声明 `hmi.tree` 才渲染；未声明时 script 的协议行或 ADB 的 JSON 作为普通文本显示。JSON 必须单行（换行会破坏协议行识别），schema 与 `internal/adb/tree.go` 对齐（`label` 必填，其余可选）：

```json
{
  "title": "log_xxx.zip · 共 2809 个条目",
  "nodes": [
    {
      "label": "log_xxx.zip", "kind": "dir",
      "children": [
        { "label": "config.json", "kind": "file", "detail": "4 KB", "path": "config.json" }
      ]
    }
  ]
}
```

- `defaultExpandAll`：帧级可选布尔值；`true` 时初始展开全部节点，省略或 `false` 时默认展开两层。`foreground-info` 的 View 树和 `list-files` 文件树设为 `true`，其他树即使带属性也不自动全展开
- `label`：节点身份（文件名 / View 树的文本、content-desc、resource-id 或 class）
- `kind`：类型徽标，前端**原样渲染、无 kind→文案/颜色映射**（设备文件树 `dir`/`file`/`symlink`/`other`，View 树=具体 class 短名）；配色只按结构：容器=主题色、叶子=灰
- `detail`：弱化补充（大小 / bounds / 截断说明），块内搜索时与 label 一起参与匹配
- `path`：叶子点击复制的完整路径；缺省时前端回退根到叶 label 面包屑（`/` 连接）
- `children`：空即叶子
- `properties`：可选的通用只读属性对象。字符串空值省略，布尔值保留显式 `false`；对象值按 key/value 递归展示。`foreground-info` 的 View 树使用 `class`、`text`、`content-desc`、`resource-id`、`package`、`index`、`drawing-order`、`bounds` 以及主要交互状态字段；`bounds` 为 `{left, top, right, bottom}`。

树块交互：省略 `defaultExpandAll` 时默认展开 2 层；设置为 `true` 的帧（如 View 树、设备文件树）默认展开全部节点；非叶子行点击折叠/展开子树，「折叠/展开」按钮改全局深度；属性面板默认折叠，不参与树层级、搜索或复制文本；块内搜索命中 label 或 detail（命中+祖先保留，仅 detail 命中的行降透明）；叶子默认复制 `path` 并弹 toast；声明 `hmi.tree.click` 后，叶子改为运行其 `action`，并将 `params` 里的 `${{ node.path }}`、`${{ params.ZIP_NAME }}` 等表达式按当前节点和生成该帧的本次 action 参数求值。映射仅传显式列出的参数，目标 action 未映射的参数由其自身默认值处理；求值失败留在树页提示错误，成功运行切至目标 action 的独立输出页。再声明 `click.multi: true` 可开启勾选多选：每行前多出 checkbox，目录勾选即整棵子树全选/取消（部分选中呈半选态），行点击行为不变（仍是立即运行单个）；树底出现「下载选中 (N)」按钮，把全部选中叶子作为一次目标 action 运行——此时 `params` 表达式改用 `${{ nodes.paths }}`（选中叶子的 `path` 按树序换行拼接，`node.*` 不可用），而单击叶子时同一表达式求值为该节点单个 `path`，因此一套 `${{ nodes.paths }}` 映射可同时服务两种触发；未声明 `multi` 的树不渲染 checkbox 与批量按钮，行为零改动，接收方参数建议 `textarea` 类型、脚本按行切分（单值兼容）。目录行点击始终只折叠/展开；同一动作输出的所有树共用此规则。workflow 引用该 action 的 step 也读取此声明，内联 `run` 无 action HMI。深层树可横向滚动查看完整缩进。`MaxTreeNodes=5000` 是数据源可选用的截断工具，并非树帧发送器的全局硬限制；设备文件列表不设置节点数上限，由扫描时限控制。

adb 域（`list-files`、`foreground-info` 的 View 树）不经协议行——Go 侧直接构造同构帧以 `stream: "tree"` 发射；script/run 动作用 `##[tree` 协议行进入同一通道：

```python
# 单行紧凑 JSON；ensure_ascii=False 保住中文可读性（scripts/spm-download.py 浏览模式）
print("##[tree " + json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "]", flush=True)
```

## adb 域形态（command.adb）

`shell`/`script` 之外，`command.adb` 是第三种执行形态，调用内置 **ADBRunner**，按 `operation` 分发到原生 Go 封装的 adb 域服务（包管理 / logcat / 文件传输 / scrcpy / 输入 / 前台信息）。相比裸 `adb shell`，它提供：设备 serial 自动解析、二进制路径探测、进度/取消、结构化过滤，且无需手写脚本。

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
| `logcat-stream` | `PACKAGE`、`LEVEL`、`TAG`、`INCLUDE`、`EXCLUDE`、`FILTER` | 前台实时流式；手动停止 |
| `logcat-batch` | `LOGS_DIR`(path,必填)、`PACKAGE`、`LEVEL`、`TAG`、`INCLUDE`、`EXCLUDE`、`CLEAR_BUFFER`(bool) | 抓取到 `logcat_<时间戳>.log`；`CLEAR_BUFFER=true` 才在抓取前 `logcat -c`（默认不清空，避免丢历史） |

过滤语义：`LEVEL` 为最低阈值（单字母 V/D/I/W/E/F，行 level ≥ 阈值才通过）；`TAG` 为 `list` 类型，以 JSON 字符串数组传入（如 `'["DVR_A","DVR_B"]'`，空值 `'[]'`），任一 tag 子串命中即通过，带空格的 tag 仍是一个元素；非空旧式空格分隔字符串不再接受；`INCLUDE`/`EXCLUDE` 对 message 做子串包含/排除。`PACKAGE` 仿 Android Studio Logcat 的包名过滤：启动时 `adb shell pidof <pkg>` 解析为 pid（多进程应用可返回多个 pid），Go 端按 pid 过滤。`logcat-stream` 额外每 5s 重试解析，故可在应用启动前先开 logcat、应用重启后自动跟上（app 未运行时该包无输出）。`logcat-stream` 配 `stream: logcat` 时**只有一个求值器（后端）**：上述五个参数（或 `FILTER`）只是启动初值，运行期由 logcat 甲板经 `UpdateLogcatFilter` 整体下发新规则，后端重筛整个 raw ring（容量由 `internal/adb/logcat/stream.go` 的 `ringCap` 决定，当前 10000 条，未写满时按实际条数）并以 `logcat-replace` 帧整体重发——放宽条件能找回 ring 内的历史行。前端不做任何过滤求值，改规则无需重启动作。规则非法（未知 key、非法正则、pid/tid 非整数、未知 link）时后端拒绝并沿用旧规则，拒绝原因回显在甲板上，不静默降级。

`FILTER`（仅 `logcat-stream`）是完整规则的 JSON 载体，由 logcat 甲板「存为预设」写入：`{"tokens":[{"key":"tag|message|pid|tid|any","op":"contains|exact|regex","negated":bool,"value":"…","link":"or"}],"minLevel":"V","package":""}`。非空、JSON 合法且含 `tokens` 数组时**整体生效**，`LEVEL`/`TAG`/`INCLUDE`/`EXCLUDE`/`PACKAGE` 全部忽略（后端 `RuleFromParamsExt`）；非法 JSON、缺少 `tokens` 数组或为空则退化到上述五个启动字段。表单里改启动字段而有效 `FILTER` 仍存在时改动不生效——需先清空 `FILTER`。

`link` 是条件组连接符：`"or"` 表示该 token **另起一个条件组**，组间任一组完全命中即通过；缺省或 `"and"` 表示并入当前组。组内语义是同 key OR、跨 key AND（每组按 key 建桶）。取反 token（`negated: true`）是全局排除，不参与分组、其 `link` 被忽略。首个正向 token 的 `link` 无前组可切，等同并入。无任何 `"or"` 的规则退化为单组，与旧语义一致。正向 token 的未知 `link` 值后端硬失败（取反 token 的 `link` 如上所述被忽略，不校验）。

**文件传输（10）**

| operation | params | 说明 |
|---|---|---|
| `push` | `LOCAL_PATH`(file,必填)、`REMOTE_PATH`(text,必填) | 推送单个文件，进度推送、3 次重试、可取消 |
| `pull` | `REMOTE_PATH`(必填)、`LOCAL_PATH`(path,必填) | 拉取单个文件 |
| `push-multiple` | `LOCAL_PATH`(path,必填)、`REMOTE_PATH`(必填) | 本地目录 → 远程目录 |
| `pull-multiple` | `REMOTE_PATH`(必填)、`LOCAL_PATH`(path,必填) | 远程目录 → 本地目录 |
| `list-files` | `REMOTE_PATH`(默认 `/sdcard/`)、`DEPTH`(正整数，默认 4)、`SHOW_HIDDEN`(bool) | 递归读取目录（直接子项为第一层）；`stream: "tree"` 默认展开全部已扫描层级，叶子点击复制设备完整路径 |
| `mkdir` | `REMOTE_PATH`(必填) | 创建远程目录 |
| `delete` | `REMOTE_PATH`(必填)、`ALLOW_PROTECTED`(可选 bool，默认 false；true 时放行 /data、/system 等系统分区，设备根 "/" 仍拒绝) | 删除远程文件/目录 |
| `rename` | `REMOTE_PATH`(必填)、`NEW_REMOTE_PATH`(必填) | 重命名/移动 |
| `directory-size` | `REMOTE_PATH`(必填) | 远程目录占用大小 |
| `storage-info` | `REMOTE_PATH`(必填) | 挂载点总/已用/可用 |

`list-files` 不跟随目录内的符号链接；属性面板展示文件大小、修改时间、权限、类型，链接额外展示目标，目录不计算总大小。动作 YAML 的 `command.timeout` 默认 `5s`，约束整个目录扫描阶段（不包含设备探测、组树与前端渲染）；取得部分结果后超时或子目录不可读时保留部分树并发出警告，未读到根目录结果、设备断开或手动取消则失败。未扫描完的目录会标明状态。无独立节点数上限，扫描大量文件时仍可能产生较大的树帧；设备 `ls` 的行格式不支持含换行符的文件名，解析失败时动作报错；链接名自身含 ` -> ` 时，无法从该行格式可靠区分链接名与目标名。远程路径会规范化（包括折叠 `..`）。`push`/`pull` 进度经 `stream: "progress"` 推送。

**scrcpy（6）**

| operation | params | 说明 |
|---|---|---|
| `scrcpy-start` | 见下方选项表 | 前台投屏，关窗即停；手动停止 kill 进程组；传 `RECORD_PATH` 时投屏同步录制，关窗/停止自动 finalize 文件 |
| `scrcpy-record-start` | `RECORD_PATH`(path,必填) + 见下方选项表 | 无头录屏（`--no-playback`），后台进行，可独立停止 |
| `scrcpy-record-stop` | 无 | 停止当前设备的录制，校验输出文件非空 |
| `clipboard-set` | `TEXT`(text,必填) | 设置设备剪贴板 |
| `clipboard-get` | 无 | 读取设备剪贴板，结果经 stdout |
| `screenshot` | `OUTPUT_PATH`(path,必填)、`DISPLAY_ID`(text,可选) | `exec-out screencap -p` 存到本地；`DISPLAY_ID` 非空时加 `-d <id>` 指定截屏 display（多屏设备用），自动剥离 screencap 混入 PNG 前的多屏警告噪声 |

**输入（1）**

| operation | params | 说明 |
|---|---|---|
| `input-text` | `TEXT`(text,必填)、`KEEP_IME`(bool) | 纯 ASCII 走 `input text`（空格转 `%s`）；含中文/emoji/换行走 ADBKeyboard 输入法广播（检测 `com.android.adbkeyboard`，**未安装则自动安装内嵌 APK** → `ime enable`/`ime set` 切到 `.AdbIME` → `am broadcast -a ADB_INPUT_B64 --es msg <base64>`，base64 规避空格/引号/非 ASCII 转义）；输入后默认恢复原输入法，`KEEP_IME=true` 时保留 ADBKeyboard 便于连续输入 |

**前台信息（1）**

| operation | params | 说明 |
|---|---|---|
| `foreground-info` | `ACTIVITY`(bool,默认 true)、`WINDOWS`(bool,默认 true)、`VIEW_TREE`(bool,默认 true) | 一次输出三段：前台 Activity（`topResumedActivity`）、焦点窗口（`dumpsys window displays` 按 display 分组的 `mCurrentFocus`/`mFocusedApp` 等摘要）、View 树（`uiautomator dump` 无障碍树，以 `stream: "tree"` 树块渲染——折叠/搜索/叶子复制见「输出协议」章节）。段级失败仅 warning 不影响其余段，全失败才非 0；仅支持 Android 10+ 字段格式 |

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
| `RECORD_PATH` | path | `--record`（仅 `scrcpy-start`）：投屏同时录制视音频流并写入该文件，关窗/停止即完成；容器格式默认按扩展名推断 |
| `RECORD_FORMAT` | text | `--record-format`（仅 `scrcpy-start`）：路径无已知扩展名时显式指定容器（`mp4`/`mkv`/`m4a`/`mka`/`aac`/`opus`/`flac`/`wav`）；留空则按 `RECORD_PATH` 扩展名推断 |

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

### 拉起 Activity（重复 flag）

`adb-debug-activity` 保留普通 `PACKAGE` / `ACTIVITY` 字段；`ARGS` 为 `arguments` 类型。默认拉起 DebugActivity 并传入 `--es exec_button 展示语音链路悬框`；显式的 `DebugActivity` 预设保持这一效果，`MainActivity` 预设将 `ACTIVITY` 改为 `com.baidu.che.codriver.ui.MainActivity`、`ARGS` 改为 `'[]'`。例如另加多个参数时：

```yaml
params:
  - { id: PACKAGE, label: 包名, type: text, default: com.baidu.che.codriver }
  - { id: ACTIVITY, label: Activity, type: text, default: com.baidu.che.codriver.ui.DebugActivity }
  - id: ARGS
    label: 启动参数
    type: arguments
    default: '[{"flag":"--es","values":["exec_button","展示语音链路悬框"]},{"flag":"--es","values":["note","hello world"]}]'
```

该动作的 `command.run` 需要本机 `jq`；运行前校验 `ARGS`，用 `jq @sh` 为设备侧 shell 逐参数引用，再用 Bash 位置参数构造本地 `adb` argv（`adb "$@"`）。缺少 `jq` 或 JSON 非法时直接报错，不会启动 Activity；有设备 serial 时只用所选设备执行，ADB 失败不会改用默认设备重试。

### 最简动作

```yaml
id: hello
title: 打个招呼
icon: 👋
command:
  run: echo "Hello, World!"
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
  run: adb shell input keyevent "${KEYCODE}"
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
  run: |
    args="--window-title=Scrcpy"
    if [ "${RECORD}" = "true" ] && [ -n "${RECORD_PATH}" ]; then
      args="$args --record=${RECORD_PATH}/scrcpy-$(date +%Y%m%d_%H%M%S).mp4"
    fi
    eval scrcpy $args
  timeout: 24h
```

## 作为调度目标

动作可以被 `schedules.yaml` 定时运行（目标键 `action`）。调度的 `params` 是这次运行的输入，保存与加载时按目标校验：

- 值可以是标量，或 `{ $literal: 文本 }`（字面值：运行时**不做**变量与 shell 展开，当成什么就是什么；字面值不能再插进内联的 `run` 命令，请改在脚本里读环境变量）
- 已声明参数的取值按声明类型校验：`select` 须在 `options` 内，`bool` 须是布尔或 `true` / `false`，`list` / `arguments` 须是合法的 JSON 字符串
- 未声明的键是允许的——它们作为额外变量源进入 `${VAR}` 查找，可以给命令里引用、但没有声明成参数的变量传值
- 没给的必填参数不在保存时报错：它的值可以来自 `config.yaml` 的同名键，到点运行时才见分晓

到点时目标正在运行则跳过（不排队、不算失败），每次运行都留运行记录，见 [运行记录与应用日志](runs.md)。

调度到点与「立即运行」不跑在应用进程里，而是交给独立执行器：应用退出后它照常跑完，重启后应用按心跳认领它，运行详情里也能停它。动作正在被别的运行占着时，工作流里引用它的步骤同样立即失败（目标锁跨进程成立）。

调度另有可选的 `catch_up`（默认 `false`）：应用没在运行时溜走的到点留一条 `missed` 记录；开了补跑，应用恢复后为最近一个错过的时刻补跑一次。

## 校验规则

加载时由 `registry.Validate` 校验，不合法的文件会被跳过并记录错误：

- `id` 必须匹配 `^[a-z0-9-]+$`
- `title` 必填
- `run` 与 `script` 与 `adb.operation` **三选一、互斥**
- `command.shell` 只允许搭配 `run`/`script` 形态；值必须是内置名（`bash`/`sh`/`pwsh`/`powershell`/`python`/`node`/`cmd`）或含 `{0}` 的自定义模板
- `script` 必须带受支持的扩展名（`.sh` / `.ps1` / `.py` / `.js`）；显式写了 `command.shell` 时不校验扩展名
- `params[].type` 只允许 `text` / `bool` / `select` / `path` / `file` / `textarea` / `list` / `arguments`
- `select` 类型必须提供 `options`
- `stream` 只允许空 或 `"logcat"`
- 同一目录下 id 不可重复

## 生效方式

新增 YAML 文件，或在外部编辑器里改完后，需要**重启 exe** 生效（启动时扫描 `actions/*.yaml`）。在内置 YAML 编辑器里保存已有的动作会立即重载，不用重启。

## 相关文档

- [Workflow 工作流定义指南](workflow.md) — 动作被工作流引用时的编排层
- [AI 任务定义指南](ai.md) — 调用 Agent CLI 的任务写在 `ai/`，不属于动作
- [运行记录与应用日志](runs.md) — 动作每次运行留下的记录与日志；动作也可被 `schedules.yaml` 定时运行
