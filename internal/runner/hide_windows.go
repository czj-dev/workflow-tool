//go:build windows

package runner

import (
	"os/exec"
	"syscall"
)

// hideWindow 让子进程不弹出控制台窗口。
// Windows 上 exec 一个控制台程序（如 powershell）默认会弹黑框，需显式隐藏：
// CREATE_NO_WINDOW(0x08000000) 不为新进程分配控制台，HideWindow 再兜底隐藏窗口。
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
}
