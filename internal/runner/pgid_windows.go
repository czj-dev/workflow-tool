//go:build windows

package runner

import "os/exec"

// setPgid 在 Windows 上是空操作——hideWindow 已经设置了 SysProcAttr。
// Windows 的 Job Object 机制由 CREATE_NO_WINDOW 和 Process.Kill() 覆盖。
func setPgid(cmd *exec.Cmd) {}

// killGroup 在 Windows 上直接 kill 进程（Windows cmd.Process.Kill 会终止进程树）。
func killGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
