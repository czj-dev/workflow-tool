# 输入文本 action 支持中文 — 设计文档

日期：2026-08-15
状态：已确认（方案 C 混合）

## 背景

`actions/adb-input-text.yaml` 目前直接 `adb shell input text`，而 Android 的
`input text` 命令不支持非 ASCII 字符（中文直接丢失）。使用场景以**手动工具**为主，
设备是否可装第三方输入法（ADBKeyboard）不确定。

## 方案选型

| 方案 | 说明 | 结论 |
|------|------|------|
| A 纯剪贴板桥 | `cmd clipboard set` + `input keyevent 279` 粘贴，零安装 | 被 C 包含 |
| B ADBKeyboard | 装 `com.android.adbkeyboard` + 切 IME + broadcast 注入 | 依赖装 APK、运行时顶掉用户输入法，暂不做 |
| **C 混合（选定）** | ASCII 走原生 `input text`，非 ASCII 自动剪贴板桥，失败时明示建议 | 无感升级，90% 场景零依赖 |

## 架构

新建 `internal/adb/input` 域子包（与 package/scrcpy 同构，`init()` 自注册）：

```
internal/adb/input/
  input.go      // RegisterOperation("input-text", handleInputText) + ASCII/非 ASCII 路由
  clipboard.go  // 剪贴板桥（get 备份 / set / paste / 可选恢复）
  input_test.go // 纯 Go 单测
```

- `actions/adb-input-text.yaml` 从 `command.shell` 改为 `command.adb.operation: input-text`。
- `main.go` 增加 blank import 触发自注册（一行），不改 `internal/adb/runner.go`。
- 27 个 operation 变 28 个。

## handleInputText 逻辑

params：

| key | 类型 | 必填 | 说明 |
|-----|------|------|------|
| `TEXT` | string | 是 | 待输入文本 |
| `RESTORE_CLIPBOARD` | bool | 否 | 默认 false；true 时粘贴后恢复设备原剪贴板 |

路由：

```
TEXT 为空       → 报错 exit 2（对齐 clipboard-set 的参数错误风格）
TEXT 纯 ASCII   → adb shell input text <text>（空格转 %s，行为与今天一致）
TEXT 含非 ASCII → 剪贴板桥：
                  a. RESTORE_CLIPBOARD=true 时先 cmd clipboard get 备份
                  b. cmd clipboard set <text>
                  c. input keyevent 279（KEYCODE_PASTE）
                  d. RESTORE_CLIPBOARD=true 时恢复备份
                  任一步失败 → 结构化报错 + 提示「需 Android 10+；若 App 拦截粘贴键，可安装 ADBKeyboard」
```

注意：`input keyevent 279` 在 App 不响应粘贴时 adb 仍 exit 0，无法可靠检测。
action 的 description 会写明「个别 App 可能不响应粘贴」。

## 数据流与错误处理

- 全程 `op.Adb(...)` 构造请求（自动带 `-s serial`）、`adbcore.RunCommand` 执行，
  复用 package 域 `runOrFail` 风格的结构化 `OperationError`。
- 每步 `op.EmitStdout` 输出走了哪条路径（如 `路径: input text（ASCII）`、
  `剪贴板桥: set → paste`），手动场景下输出面板可见。
- `cmd clipboard` 失败（如 Android < 10）→ `Retryable: false`，stderr 带建议文案。

## 测试

- 纯 Go 单测（不依赖设备/不依赖 Wails）：
  - ASCII / 非 ASCII / 空 TEXT 的路由与报错
  - 空格转 `%s` 转义
  - 剪贴板桥失败时的错误信息断言
- 粘贴在真机上是否生效：手动验证（单测只覆盖 argv 构造与分支选择层）。

## 文档

- `docs/action.md` 增补 `input-text` operation 的 params 契约与剪贴板桥说明。
- `actions/adb-input-text.yaml` 的 description 同步更新（去掉「不支持中文」）。

## 非目标（YAGNI）

- 不实现 ADBKeyboard 模式（`--ime` 参数留给未来增强）。
- 不做 emoji 特判（剪贴板桥天然支持）。
- 不恢复/清理 ASCII 路径的任何行为。
