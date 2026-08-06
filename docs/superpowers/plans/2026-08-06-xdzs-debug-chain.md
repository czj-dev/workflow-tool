# xdzs-speech 调试链路一键化 — 实现计划

日期: 2026-08-06
状态: 待执行
设计文档: [2026-08-06-xdzs-debug-chain-design.md](../specs/2026-08-06-xdzs-debug-chain-design.md)

## 概述

纯 YAML 配置，不改 Go 代码、不改前端。新增 2 个 action + 1 个 workflow + 1 条全局变量。

## 任务

### Task 1: 新增全局变量 `XDZS_SPEECH_DIR`

**文件**: `config.yaml`

**步骤**:
1. 在 `config.yaml` 末尾新增一行：`XDZS_SPEECH_DIR: /Users/v_chenzhaojun/Documents/Project/baidu/asd-edc/xdzs-speech`
2. 确认路径真实存在（`ls` 检查）

**验证**: 路径存在、`config.yaml` 格式正确

---

### Task 2: 新增 `actions/xdzs-device-init.yaml`

**文件**: `actions/xdzs-device-init.yaml`

**步骤**:
1. 创建文件，内容按 spec §3.1：
   - id: `xdzs-device-init`
   - shell：`adb root && adb remount`、`setenforce 0`、`disable-verify 99`、`setprop vecentek.model 1`、`sleep 2`
   - 然后对 2 个包（`com.baidu.che.codriver`、`com.baidu.che.codriver.speechapi`）各授予 9 项权限（共 18 条 `pm grant`）
   - timeout: `60s`
2. 运行 `go test ./internal/registry` 确认加载无报错

**验证**: `go test ./internal/registry` 通过

---

### Task 3: 新增 `actions/xdzs-build-app.yaml`

**文件**: `actions/xdzs-build-app.yaml`

**步骤**:
1. 创建文件，内容按 spec §3.2：
   - id: `xdzs-build-app`
   - params: VARIANT (select: debug/release, default: debug)
   - shell: `./gradlew vr-app:assemble${VARIANT}`
   - cwd: `${XDZS_SPEECH_DIR}`
   - timeout: `10m`
2. 运行 `go test ./internal/registry` 确认加载无报错

**验证**: `go test ./internal/registry` 通过

---

### Task 4: 新增 `workflows/xdzs-debug-chain.yaml`

**文件**: `workflows/xdzs-debug-chain.yaml`

**步骤**:
1. 创建文件，内容按 spec §3.3：
   - id: `xdzs-debug-chain`
   - title: 调试一键链
   - icon: `hi:workflow`
   - description: "设备初始化 → 编译 debug → 安装 → 拉起测试页"
   - steps:
     1. `action: xdzs-device-init`
     2. `action: xdzs-build-app` + `params: {VARIANT: debug}`
     3. `action: adb-install`
     4. `action: adb-debug-activity`
2. 运行 `go test ./internal/workflow` 确认加载无报错

**验证**: `go test ./internal/workflow` 通过

---

### Task 5: 全量测试回归

**步骤**:
1. `go test ./internal/...` 全部通过
2. `cd frontend && npm run typecheck` 通过（确认无意外破坏）

**验证**: 全绿

---

## 不做

- 不改 Go 代码
- 不改前端
- 不动现有 action/workflow
- 不做 release 全链路
- 不做 git commit（等用户指示）
