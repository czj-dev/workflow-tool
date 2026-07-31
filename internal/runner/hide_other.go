//go:build !windows

package runner

import "os/exec"

// hideWindow 在非 Windows 平台是空操作（无控制台窗口问题）。
func hideWindow(cmd *exec.Cmd) {}
