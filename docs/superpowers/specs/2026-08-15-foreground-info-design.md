# 前台信息 operation（foreground-info）设计

日期：2026-08-15
状态：已与用户逐节确认

## 背景与目标

现有「前台 Activity」动作（`actions/adb-foreground-activity.yaml`）是粗粝的 shell 形态：`dumpsys activity activities | grep ResumedActivity`，只输出一行。用户需要增强为一份完整的「屏幕当前状态」报告：

1. 前台 Activity
2. 前台（焦点）窗口
3. View 树
4. 格式化展示

调研确认：参考项目 ADBKit（`Documents/ADBKit`）没有此块实现（dumpsys 仅用于 battery/package），全新编写解析器。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 组织形态 | 单个综合 operation `foreground-info`，param 勾选要哪些段 |
| View 树来源 | `uiautomator dump`（无障碍树 XML，Go 端解析成缩进树）——定位可交互控件视角 |
| 窗口范围 | 焦点窗口摘要（非完整窗口列表）；**不做旧版 Android 兼容**（仅 Android 10+ 字段格式） |
| 展示形式 | Go 端格式化纯文本，走现有 stdout 通道 + OutputConsole 渲染；**零前端改动** |

## 后端：internal/adb/foreground/ 域包

新域包，`init()` 调 `adb.RegisterOperation("foreground-info", handler)` 自登记（与 package/logcat/file/scrcpy/input 同模式，不动 `runner.go`）。

### params

| param | type | 默认 | 说明 |
|---|---|---|---|
| `ACTIVITY` | bool | true | 输出前台 Activity 段 |
| `WINDOWS` | bool | true | 输出焦点窗口段 |
| `VIEW_TREE` | bool | true | 输出 View 树段 |
| `TREE_MAX_DEPTH` | text | 空=不限 | 树缩进深度上限，防爆屏；非正整数值视为不限并附 warning |

公共 `ADB_SERIAL` 与其他 operation 一致。

### 执行链

顺序执行（均走 `OpContext.Adb()`，总超时沿用 action `timeout`），三段彼此独立：

1. **前台 Activity**：`dumpsys activity activities` → 逐行匹配 `topResumedActivity=`（Android 10+ 字段；实测 Android 14 上旧字段 `ResumedActivity:` 与之并存，只取 `topResumedActivity`，多命中取首个）。解析出组件串（`pkg/.ShortName`）、包名、短名、task id（`tNNN`）。
2. **焦点窗口**：`dumpsys window displays` → **按 `Display N` 块分组**解析（真机实测为多屏车机，4 个 display 各一组焦点字段），每块提取 `mCurrentFocus` / `mFocusedApp` / `mTopFullscreenOpaqueWindowState` / `mInputMethodTarget`（正则逐行匹配；null 值原样显示；匹配不到的键整行省略）。
3. **View 树**：`adb shell uiautomator dump /sdcard/window_dump.xml` → `adb shell cat /sdcard/window_dump.xml` → Go 端 `encoding/xml` 解析 `hierarchy/node` 树。走文件中转而非 `exec-out /dev/tty`（后者部分 ROM 不稳，实测文件中转可用）。

### 容错原则

某段命令失败（典型：uiautomator dump 被无障碍服务占用）只在该段位置输出一行 warning（`warning: ...` 经 stdout），其余段照常；三段全失败才返回非 0 + `adbcore.NewOperationError`。未勾选的段整段跳过（不发命令）。

### 文件结构

```
internal/adb/foreground/
  register.go    init() 注册 + handler（执行链编排、容错）
  collect.go     三条命令的采集函数（activity/windows/view tree）
  parse.go       纯函数解析：activity 行、display 分组、uiautomator XML → 结构体
  format.go      结构体 → 格式化文本（对齐、树形缩进、深度截断）
  parse_test.go  解析单测（fixture 取自真机实测输出）
  format_test.go 排版快照单测
```

## 输出排版

等宽纯文本，逐行 `EmitStdout`：

```
── 前台 Activity ──────────────────────────────
  组件      com.example.app/.MainActivity
  短名      MainActivity
  包名      com.example.app
  Task      #123

── 焦点窗口 ───────────────────────────────────
  [Display 0]
    mCurrentFocus              Window{72a7495 u0 com.tinnove.wecarnavi}
    mFocusedApp                null
  [Display 2]
    mCurrentFocus              Window{635c825 u0 com.tinnove.aiassistant}
    mFocusedApp                ActivityRecord{868ec37 u0 com.tinnove.launcher/...}
    mTopFullscreenOpaqueWindow Window{2c3a40d u0 com.tinnove.launcher/...}

── View 树 · uiautomator · 共 N 节点 ───────────
  android.widget.FrameLayout [0,0][1080,2400]
  └─ android.widget.LinearLayout [0,0][1080,2340]
     └─ android.widget.Button "登录" id=com.example.app:id/login
        [clickable] [100,800][300,880]
```

- 段落标题 `── … ──` 分隔线；key/value 固定宽度对齐。
- 树每层缩进 2 格；末位子节点 `└─`、其余 `├─`。
- 树节点属性顺序：class → text（>40 字符截断）→ resource-id（全量保留）→ `[clickable]`（仅 true）→ bounds。
- `TREE_MAX_DEPTH` 生效时被截断的子树收成 `└─ … (+N 子节点)`（N 为被折叠的后代总数）。
- 未勾选的段整体不出现。

## action 替换

改写 `actions/adb-foreground-activity.yaml`：

- **id 保留** `adb-foreground-activity`（兼容已有 workflow 引用）
- `command.shell` → `command.adb.operation: foreground-info`，`timeout: 30s`
- title 改「前台信息」，description 更新为三段说明
- params 换为上表 4 个；presets 两个：「全部」（默认三段）、「仅 View 树」

## 登记与收尾

- `main.go`：blank import `_ "workflow-tool/internal/adb/foreground"`
- `internal/adb/registration_test.go`：blank import、数量断言 28→29、want 列表加 `foreground-info`
- `docs/action.md`：operation 契约表新增「前台信息（1）」小节；adb 域形态概述的域列举同步
- `CLAUDE.md`：「28 个 operation」等两处数字同步为 29，域子包列举加 foreground

## 测试与验证

1. **纯函数单测**（不依赖设备）：activity 解析（标准行、多命中取首个、无匹配）、display 分组解析（多块、null 值、缺失键容忍）、XML 树解析（嵌套、属性提取、深度截断计数、文件未生成路径）、排版快照。
   fixture 用真机实测输出（Android 14 车机 DP8678GRP，裁剪脱敏）。
2. **真机实际验证**（adb 已连通）：本机 adb `C:\Users\ASUS\AppData\Local\Android\Sdk\platform-tools\adb.exe`，serial `07ab9620cb257222_ANDROID`。构建后运行该 action，确认：三段输出排版正常、多 display 分组正确、View 树深度截断生效、uiautomator 失败路径 warning 不影响其他段。

## 不做的事（YAGNI）

- 不做旧版 Android（<10）字段兼容
- 不做完整窗口列表（所有 WindowState）
- 不做前端专门视图 / 结构化 stream 类型
- 不做 `dumpsys activity top` 的 View Hierarchy 来源（用户明确选 uiautomator 视角）
