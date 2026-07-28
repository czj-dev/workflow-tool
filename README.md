# Workflow Tool

一键触发命令/脚本的桌面 workflow 工具，基于 Wails v3。Phase 1：YAML 定义动作，按钮触发，实时流式输出，跨 macOS/Windows 单二进制分发。

## 状态

Phase 1（MVP）开发中。核心包（runner/registry）代码已就位，待装 Go 后验证 + 接入 Wails 骨架。

- 设计文档：`docs/specs/2026-07-28-phase1-design.md`
- 实现计划：`docs/superpowers/plans/2026-07-28-phase1.md`

## 前置条件

- Go 1.22+
- Wails v3 CLI：`go install github.com/wailsapp/wails/v3/cmd/wails3@latest`
- Node.js（前端构建）

## 快速开始（装好 Go 后）

```bash
# 1. 验证核心包
go mod tidy
go test ./internal/...

# 2. 生成 Wails 骨架（main.go/前端/wails.json）—— 见实现计划 Task 1
#    wails3 init 在临时目录生成后把骨架文件拷入，避免覆盖 docs/

# 3. 运行
wails3 dev

# 4. 构建
wails3 build
```

## 目录

```
internal/runner/    执行单元（Runner 接口 + ShellRunner），纯 Go
internal/registry/  YAML 动作加载与校验，纯 Go
internal/api/       Wails service 绑定（待接入）
actions/            动作定义（使用者可编辑）
scripts/            script 字段引用的脚本（.sh / .ps1）
```

## 加一个动作

在 `actions/` 放一个 YAML：

```yaml
id: my-action
title: 我的动作
icon: 🚀
command:
  shell: echo hello
```

重启即出现在按钮列表。

更多见设计文档 §3.3。
