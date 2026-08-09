package packagemgr

import (
	"fmt"
	"strings"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// handleUninstall 对应 uninstall-package。
// 优先用 PACKAGES（换行/逗号分隔）做批量卸载；否则对单个 PACKAGE 执行 `pm uninstall`。
func handleUninstall(op *adb.OpContext) adb.OpResult {
	if names := parsePackagesList(op.ParamStr("PACKAGES")); len(names) > 0 {
		return runBatch(op, "uninstall-package", "uninstalled", names, uninstallOne)
	}
	pkg, fail := requireSinglePackage(op, "uninstall-package")
	if fail != nil {
		return *fail
	}
	return uninstallOne(op, pkg)
}

func uninstallOne(op *adb.OpContext, pkg string) adb.OpResult {
	res, fail := runOrFail(op, "uninstall-package", "Failed to uninstall package",
		op.Adb("shell", "pm", "uninstall", pkg), true)
	if fail != nil {
		return *fail
	}
	message := fallbackMessage(res.Stdout, fmt.Sprintf("Uninstalled %s", pkg))
	op.EmitStdout(message)
	return adb.OpResult{ExitCode: 0, Stdout: message}
}

// handleDisable 对应 disable-package。
// 优先用 PACKAGES 做批量禁用；否则对单个 PACKAGE 执行 `pm disable-user --user 0`。
func handleDisable(op *adb.OpContext) adb.OpResult {
	if names := parsePackagesList(op.ParamStr("PACKAGES")); len(names) > 0 {
		return runBatch(op, "disable-package", "disabled", names, disableOne)
	}
	pkg, fail := requireSinglePackage(op, "disable-package")
	if fail != nil {
		return *fail
	}
	return disableOne(op, pkg)
}

func disableOne(op *adb.OpContext, pkg string) adb.OpResult {
	res, fail := runOrFail(op, "disable-package", "Failed to disable package",
		op.Adb("shell", "pm", "disable-user", "--user", "0", pkg), true)
	if fail != nil {
		return *fail
	}
	message := fallbackMessage(res.Stdout, fmt.Sprintf("Disabled %s", pkg))
	op.EmitStdout(message)
	return adb.OpResult{ExitCode: 0, Stdout: message}
}

// handleEnable 对应 enable-package。
// 优先用 PACKAGES 做批量启用（保留 ADBKit 的批量能力）；否则对单个 PACKAGE 执行 `pm enable --user 0`。
func handleEnable(op *adb.OpContext) adb.OpResult {
	if names := parsePackagesList(op.ParamStr("PACKAGES")); len(names) > 0 {
		return runBatch(op, "enable-package", "enabled", names, enableOne)
	}
	pkg, fail := requireSinglePackage(op, "enable-package")
	if fail != nil {
		return *fail
	}
	return enableOne(op, pkg)
}

func enableOne(op *adb.OpContext, pkg string) adb.OpResult {
	res, fail := runOrFail(op, "enable-package", "Failed to enable package",
		op.Adb("shell", "pm", "enable", "--user", "0", pkg), true)
	if fail != nil {
		return *fail
	}
	message := fallbackMessage(res.Stdout, fmt.Sprintf("Enabled %s", pkg))
	op.EmitStdout(message)
	return adb.OpResult{ExitCode: 0, Stdout: message}
}

// handleClearData 对应 clear-data：执行 `pm clear <pkg>`。
func handleClearData(op *adb.OpContext) adb.OpResult {
	pkg, fail := requireSinglePackage(op, "clear-data")
	if fail != nil {
		return *fail
	}
	res, fail := runOrFail(op, "clear-data", "Failed to clear package data",
		op.Adb("shell", "pm", "clear", pkg), true)
	if fail != nil {
		return *fail
	}
	message := fallbackMessage(res.Stdout, fmt.Sprintf("Cleared data for %s", pkg))
	op.EmitStdout(message)
	return adb.OpResult{ExitCode: 0, Stdout: message}
}

// handleForceStop 对应 force-stop：执行 `am force-stop <pkg>`。
func handleForceStop(op *adb.OpContext) adb.OpResult {
	pkg, fail := requireSinglePackage(op, "force-stop")
	if fail != nil {
		return *fail
	}
	res, fail := runOrFail(op, "force-stop", "Failed to stop package",
		op.Adb("shell", "am", "force-stop", pkg), true)
	if fail != nil {
		return *fail
	}
	message := fallbackMessage(res.Stdout, fmt.Sprintf("Stopped %s", pkg))
	op.EmitStdout(message)
	return adb.OpResult{ExitCode: 0, Stdout: message}
}

// singleFunc 是单个包操作的签名。
type singleFunc func(op *adb.OpContext, pkg string) adb.OpResult

// runBatch 移植自 ADBKit runBatchOperation：逐个执行，统计成功/失败，逐项推送明细。
// 任何单项失败不影响其余项；最终 ExitCode=0（部分成功）或 2（全失败/空列表）。
func runBatch(op *adb.OpContext, opName, action string, names []string, operation singleFunc) adb.OpResult {
	trimmedNames := make([]string, 0, len(names))
	for _, name := range names {
		trimmed := strings.TrimSpace(name)
		if trimmed != "" {
			trimmedNames = append(trimmedNames, trimmed)
		}
	}

	if len(trimmedNames) == 0 {
		err := adbcore.NewOperationError(opName, "No packages were selected", "package list must not be empty", false)
		return adb.OpResult{ExitCode: 2, Err: err, Stderr: err.Error()}
	}

	successCount := 0
	failures := make([]string, 0)
	for _, name := range trimmedNames {
		op.EmitProgress(fmt.Sprintf("%s %s ...", action, name))
		item := operation(op, name)
		if item.ExitCode != 0 || item.Err != nil {
			detail := item.Stderr
			if detail == "" && item.Err != nil {
				detail = item.Err.Error()
			}
			line := fmt.Sprintf("%s: %s", name, strings.TrimSpace(detail))
			failures = append(failures, line)
			op.EmitStderr(line)
			continue
		}
		successCount++
	}

	summary := fmt.Sprintf("Successfully %s %d package(s)", action, successCount)
	if len(failures) == 0 {
		op.EmitStdout(summary)
		return adb.OpResult{ExitCode: 0, Stdout: summary}
	}

	summary = fmt.Sprintf("%s. Failed: %d. Details: %s", summary, len(failures), strings.Join(failures, " | "))
	op.EmitStdout(summary)
	return adb.OpResult{ExitCode: 0, Stdout: summary, Stderr: strings.Join(failures, "\n")}
}
