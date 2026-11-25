//go:build windows

package procinfo

import (
	"fmt"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// processStartedAt 向系统查询 pid 的启动时刻。进程不存在时 ok=false。
// Windows 没有 ps，经 PowerShell 的 Get-Process 取 StartTime（统一转成 UTC 再输出，
// 不受系统时区与语言环境影响）。
func processStartedAt(pid int) (time.Time, bool) {
	script := fmt.Sprintf(
		"(Get-Process -Id %d -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString('o')", pid)
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	// 调用方可能是无控制台的 GUI 进程：必须隐藏窗口，否则每次核对都闪一个 PowerShell 窗口。
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	out, _ := cmd.Output()
	started, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(string(out)))
	if err != nil {
		return time.Time{}, false
	}
	return started, true
}
