package foreground

import (
	"strings"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// runOrFail 执行一次 adb ExecRequest，非零退出时返回带上下文的 error
// （handler 对段级失败只发 warning、继续其余段，故这里返回 error 而非 OpResult）。
func runOrFail(op *adb.OpContext, req adbcore.ExecRequest) (*adbcore.ExecResult, error) {
	res, err := adbcore.RunCommand(op.Ctx, req)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, adbcore.NewOperationError("foreground-info", "adb command failed", strings.TrimSpace(res.Stderr), false)
	}
	return res, nil
}

// collectActivity 采集 dumpsys activity activities 全文（前台 Activity 解析输入）。
func collectActivity(op *adb.OpContext) (string, error) {
	res, err := runOrFail(op, op.Adb("shell", "dumpsys", "activity", "activities"))
	if err != nil {
		return "", err
	}
	return res.Stdout, nil
}

// collectWindows 采集 dumpsys window displays 全文（焦点窗口解析输入）。
func collectWindows(op *adb.OpContext) (string, error) {
	res, err := runOrFail(op, op.Adb("shell", "dumpsys", "window", "displays"))
	if err != nil {
		return "", err
	}
	return res.Stdout, nil
}

// uiDumpPath 是 uiautomator dump 的设备端中转文件。走文件中转而非
// exec-out /dev/tty：后者在部分 ROM 上不落盘、行为不稳（实测文件中转可靠）。
const uiDumpPath = "/sdcard/window_dump.xml"

// collectUITree 执行 uiautomator dump 并 cat 拉回 XML。
// 注意：dump 失败（如无障碍服务占用）时 exit code 可能为 0、错误信息走 stdout，
// 故必须校验 cat 结果含 <hierarchy 才算成功。
func collectUITree(op *adb.OpContext) (string, error) {
	if _, err := runOrFail(op, op.Adb("shell", "uiautomator", "dump", uiDumpPath)); err != nil {
		return "", err
	}
	res, err := runOrFail(op, op.Adb("shell", "cat", uiDumpPath))
	if err != nil {
		return "", err
	}
	if !strings.Contains(res.Stdout, "<hierarchy") {
		return "", adbcore.NewOperationError("foreground-info", "uiautomator dump produced no hierarchy xml", strings.TrimSpace(res.Stdout), true)
	}
	return res.Stdout, nil
}
