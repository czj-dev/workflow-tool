//go:build windows

package adbcore

import (
	"os/exec"
	"strconv"
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

// killGroup 在 Windows 上递归终止进程树：Process.Kill 只杀直接子进程，
// adb 起的子进程（shell 里的管道/脚本）会残留，故先 taskkill /T /F 按树
// 强杀，再 Kill 兜底。taskkill 自身也隐藏窗口（GUI 下杀进程不弹黑框）。
func killGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	kill := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
	kill.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
	_ = kill.Run() // 进程已退出时 taskkill 报错，忽略
	_ = cmd.Process.Kill()
}
