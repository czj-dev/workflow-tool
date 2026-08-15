//go:build windows

package runner

import (
	"os/exec"
	"strconv"
	"syscall"
)

// setPgid 在 Windows 上是空操作——hideWindow 已经设置了 SysProcAttr。
// Windows 无进程组语义，进程树终止由 killGroup 的 taskkill /T 负责。
func setPgid(cmd *exec.Cmd) {}

// killGroup 在 Windows 上递归终止进程树。Process.Kill 只杀直接子进程，
// PowerShell/shell 起的孙进程（脚本里的 adb 等）会残留，故先用
// taskkill /T /F 按树强杀，再 Kill 兜底确保主进程退出。
func killGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	kill := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
	// taskkill 是控制台程序，须同样隐藏窗口（否则 GUI 下杀进程弹黑框）
	kill.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
	_ = kill.Run() // 进程已退出时 taskkill 报错，忽略
	_ = cmd.Process.Kill()
}
