//go:build windows

package adbcore

import (
	"os/exec"
	"syscall"
)

// configureChild 在 Windows 上把子进程放进新进程组，并隐藏控制台窗口
// （GUI 启动的 action 执行不再弹黑框）。
func configureChild(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags = syscall.CREATE_NEW_PROCESS_GROUP
	cmd.SysProcAttr.HideWindow = true
}

// killGroup 在 Windows 上尽力终止进程（无进程组语义）。
func killGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
