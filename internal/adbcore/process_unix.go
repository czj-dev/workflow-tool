//go:build !windows

package adbcore

import (
	"os/exec"
	"syscall"
)

// configureChild 让子进程成为新进程组 leader（cancel/超时时可杀整组）。
// 非 Windows 无控制台窗口问题，故无需 hide。
func configureChild(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// killGroup 杀死整个进程组（负 pid = 进程组 ID）。
func killGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
