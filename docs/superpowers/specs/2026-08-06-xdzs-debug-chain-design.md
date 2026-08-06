# xdzs-speech 调试链路一键化 — 设计文档

日期: 2026-08-06
状态: 已批准

## 1. 背景与目标

xdzs-speech(车机语音项目)日常调试链路靠手工敲脚本完成:

- `wt_debug.sh` — 设备初始化(adb root/remount/setenforce + 权限授予)
- `tinnove_debug.sh` — `gradlew vr-app:assembleDebug` → `adb install -r` → `am start`

目标是把这些步骤封装为 workflow-tool 的按钮动作:一个按钮跑通「设备初始化 → 编译 → 安装 → 拉起测试页」全链路;其中各步骤单独可点按、可复用。

## 2. 现状与约束(关键事实)

### workflow-tool 侧

- **多步骤 workflow 已支持**(Phase 2 完成):step 支持 `action`(引用已有动作,可覆盖参数)/ `sleep` / `shell`(可带 `timeout`),支持 `retry`、`continue_on_error`,默认**失败即停**
- **inline shell step 没有 `cwd` 字段**,只有引用 action 时才有 cwd(action 的 YAML `command.cwd`)→ 编译必须做成 action 才能定位项目目录
- 变量替换用 `os.Expand`(**单趟替换**),值为 `${VAR}`:运行参数 > 全局配置(config.yaml)> 环境变量;三者皆无则保留原样 + warning → **step params 的值不支持嵌套 `${}` 展开**,只能传字面值
- 已有通用 action:`adb-install`(从 `${VOICE_DEBUG_OUTPUT}` 目录取第一个 APK 安装)、`adb-debug-activity`(拉起 DebugActivity)、`adb-debug-log` 等
- 全局配置 `config.yaml` 已有 `VOICE_DEBUG_OUTPUT: .../apk/debug`(正好指向 debug 产物目录)

### xdzs-speech 侧

- 编译任务:`./gradlew vr-app:assembleDebug|assembleRelease`(须在项目根执行)
- APK 产物:`app-vui/vr-app/build/outputs/apk/{debug,release}/*.apk`
- 启动页面:已有 `adb-debug-activity` 拉起 `com.baidu.che.codriver/.ui.DebugActivity`(测试页面),无需再写
- 设备初始化语义(源自 `wt_debug.sh`):`adb root` → `remount` → `setenforce 0` → `disable-verify 99` → `setprop vecentek.model 1`,再对 2 个包各授予 9 项权限(共 18 条 `pm grant`)

## 3. 设计

### 3.1 `actions/xdzs-device-init.yaml` — 设备初始化(新 action)

搬运 `wt_debug.sh` 语义,参数无关,cwd 无需指定:

```yaml
id: xdzs-device-init
title: 设备初始化
icon: hi:tool
description: adb root/remount/setprop + 授予 codriver 权限
command:
  shell: |
    adb root && adb remount && adb shell setenforce 0
    adb shell disable-verify 99
    adb shell setprop vecentek.model 1
    # 18 条 pm grant: 下方权限清单 × 两个包名,逐条展开(照抄 wt_debug.sh)
    sleep 2  # 等 adbd 重启恢复连接
  timeout: 60s
```

权限清单(9 项,每个包各授予一遍):`RECORD_AUDIO`、`READ_EXTERNAL_STORAGE`、`WRITE_EXTERNAL_STORAGE`、`CALL_PHONE`、`SYSTEM_ALERT_WINDOW`、`ACCESS_FINE_LOCATION`、`WRITE_SECURE_SETTINGS`、`READ_CONTACTS`、`WRITE_CONTACTS`。

### 3.2 `actions/xdzs-build-app.yaml` — 编译(新 action,cwd 定位)

```yaml
id: xdzs-build-app
title: 编译 vr-app
icon: hi:build
params:
  - id: VARIANT
    label: 版本
    type: select
    options: [debug, release]
    default: debug
command:
  shell: ./gradlew vr-app:assemble${VARIANT}
  cwd: ${XDZS_SPEECH_DIR}    # 新增全局配置,与 VOICE_DEBUG_OUTPUT 同惯例
  timeout: 10m
```

可单独点按:选择 release 编译发布包。

### 3.3 `workflows/xdzs-debug-debug-chain.yaml` — 全链路(新 workflow,全部复用)

```yaml
id: xdzs-debug-chain
title: 调试一键链
icon: hi:workflow
steps:
  - action: xdzs-device-init             # 1. 设备初始化
  - action: xdzs-build-app
    params: { VARIANT: debug }           # 2. 编译 debug(字面参数,见 3.4)
  - action: adb-install                  # 3. 复用: 安装 VOICE_DEBUG_OUTPUT 下的 APK
  - action: adb-debug-activity           # 4. 复用: 拉起测试页面
```

**不做 release 全链路**:`adb-install` 固定在 `VOICE_DEBUG_OUTPUT`(debug 目录),无法随变体切换(step 参数值不支持嵌套 `${}` 动态拼接,见上)。release 需求单独使用 `xdzs-build-app`(选 release)编译,安装手动处理,后续有需求再加。

### 3.4 参数贯通说明

- `workflow.RunWorkflow(params)` → 与全局配置合并 → 各 step 执行时替换
- step 2 传字面 `params: {VARIANT: debug}`(合并后以 step 参数优先)——无嵌套引用,展开正确
- inline shell step 也拿同一份合并参数,若将来有 inline 步骤可直接用 `${VARIANT}`

### 3.5 错误处理与失败语义

- 保持 executor 默认:步骤失败即终止(编译失败则不会进入 install),每个步骤 exit code 展示在 UI
- init 无需幂等处理(重复执行无害:setenforce/grant 幂等)
- `adb root` 后 adbd 重启可能短暂 device offline → init 末尾加 `sleep 2` 缓冲

### 3.6 验证

| 项 | 方式 |
|----|------|
| 工具回归 | `go test ./internal/...`(registry / workflow / runner / api 单测全绿) |
| YAML 合法性 | 加载时校验(checkout 新文件后重启 exe 观察前侧无加载错误) |
| 参数贯通 | 运行 `xdzs-build-app`(debug/release 各一次)确认 gradle 任务名;workflow 运行时确认 install 步骤找到 APK |
| 真机全链路 | 点击 `xdzs-debug-chain`,观察四步均 done,DebugActivity 拉起 |

## 4. 改动范围(均在 workflow-tool 仓库)

1. `actions/xdzs-device-init.yaml`
2. `actions/xdzs-build-app.yaml`
3. `workflows/xdzs-debug-chain.yaml`
4. `config.yaml` 新增 `XDZS_SPEECH_DIR` (项目根绝对路径)

不改 Go 代码、不改前端、不动现有 action。

## 5. 不做(YAGNI)

- 协议测试 / 主题包 / 对时 / 多仓库 sync 的封装
- release 全链路(见 3.3)
- 多设备 `-s` 选择(单设备调试)
- workflow step 级 cwd 扩展(给工具加能力,受益可延后)