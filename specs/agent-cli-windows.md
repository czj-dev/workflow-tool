# Agent CLI — Windows 支持 Spec（延后实现）

mac/Linux Agent CLI 已实现（见 `specs/agent-cli.md`）。本文件是 **Windows 支持的 TODO 与具体实现方案**，待单独实现。

## 问题

发布版 Windows 以 `-H windowsgui` 构建（`deploy/backend.sh`），PE subsystem 标记为 GUI → Windows **不分配控制台**。该二进制跑 CLI 子命令时，若 `os.Stdout` 无有效句柄，输出静默丢弃。

## 关键事实：多数场景无需处理

`-H windowsgui` 只改「是否自动分配控制台」，**不影响标准句柄的继承**。

- **Agent 用管道捕获**（`exec.Command` + 捕获 stdout / `subprocess.PIPE`）：父进程经 STARTUPINFO 传入 pipe 句柄，windowsgui 二进制照常往 pipe 写，**无需任何改动**。这是 Agent CLI 的主场景。
- **人在已有控制台手敲、且不重定向**：无继承句柄、无控制台 → 输出丢。**只有这个场景需要 `AttachConsole`。**

因此 Windows 支持是**交互式控制台**的增强，不是 Agent 可用性的前提。

## 实现方案：AttachConsole

### 入口接线
在 `cli.Run` 开头调用 `attachParentConsole()`，用 build tag 分平台：
- `internal/cli/console_windows.go`（`//go:build windows`）：真实实现。
- `internal/cli/console_other.go`（`//go:build !windows`）：空函数 no-op。

这样 `main.go` 与 `cli.Run` 主体不含平台分支。

### Windows 实现要点（`console_windows.go`）
```go
//go:build windows

package cli

import (
	"os"
	"syscall"

	"golang.org/x/sys/windows"
)

// attachParentConsole 把 windowsgui 进程挂到父进程的控制台，使交互式直跑可见输出。
// 管道捕获场景下父进程无控制台，AttachConsole 失败即忽略（句柄已是继承的 pipe）。
func attachParentConsole() {
	if err := windows.AttachConsole(windows.ATTACH_PARENT_PROCESS); err != nil {
		// ERROR_ACCESS_DENIED：本进程已有控制台（从 cmd 跑非 windowsgui 构建）；
		// ERROR_INVALID_HANDLE：父进程无控制台（被 GUI/服务拉起）——两者都无需 attach。
		return
	}
	reopen("CONOUT$", &os.Stdout)
	reopen("CONOUT$", &os.Stderr)
	reopen("CONIN$", &os.Stdin)
}

// reopen 把控制台设备重新打开并替换 Go 的包级 std 文件（原句柄在 windowsgui 下无效）。
func reopen(name string, f **os.File) {
	h, err := syscall.Open(name, os.O_RDWR, 0)
	if err != nil {
		return
	}
	*f = os.NewFile(uintptr(h), name)
}
```

### 必须验证的 gotcha
1. **包级变量替换时机**：`os.Stdout`/`Stderr`/`Stdin` 在 Go 运行时启动时固定，必须在任何输出前（`cli.Run` 第一行）替换；晚于首次写入无效。
2. **`SetStdHandle` 是否需要**：若 CLI 还会 fork 子进程（action 的 shell/adb）且要求子进程输出也落父控制台，可能需 `windows.SetStdHandle(STD_*_HANDLE, handle)` 让子进程继承。实现时实测：子进程输出是否已随 AttachConsole 正确落控制台，不行再补 SetStdHandle。
3. **cmd.exe 提示符交错**：cmd 把 GUI 子系统程序当「后台 GUI」，启动后立刻返回提示符，输出会与新提示符交错。对 Agent（管道捕获）无影响；交互式仅视觉问题，文档注明即可，不强求解决。
4. **依赖**：确认 `go.mod` 已（经 Wails）间接含 `golang.org/x/sys`；缺则 `go get golang.org/x/sys/windows`。

## 构建与验证

- 构建仍走 `deploy/backend.sh`（`-H windowsgui`），不改构建方式。
- 验收用例（真 Windows 环境）：
  1. **管道捕获**：PowerShell `(& .\workflow-tool.exe list) ` 或 `cmd /c workflow-tool.exe run <id> > out.txt`——输出完整、退出码正确。**这一项当前即应通过（无需 AttachConsole）**，是 Agent 场景的真正验收。
  2. **交互式直跑**：`cmd` 里 `workflow-tool.exe list` 直接可见 JSON（AttachConsole 生效后）。
  3. `run --json` 的 NDJSON 不被 CRLF/编码破坏（Windows 换行按 `\n` 输出，不强制 `\r\n`）。

## 验收标准

- [ ] 管道捕获场景在 Windows 发布版（windowsgui）下输出完整、退出码正确。
- [ ] 交互式 `cmd`/PowerShell 直跑可见输出（AttachConsole）。
- [ ] `console_other.go` 在 mac/Linux 为 no-op，现有行为不变。
- [ ] `go build`（各平台）与 `go test ./internal/cli` 通过。
