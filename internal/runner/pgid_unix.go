//go:build !windows

package runner

import (
	"os/exec"
	"syscall"
)

// setPgid 让子进程成为新进程组的 leader，以便 kill 时杀整组。
func setPgid(cmd *exec.Cmd) {
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
