package packagemgr

import (
	"fmt"
	"os"
	"path/filepath"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// handlePull 对应 pull-apk：`pm path <pkg>` 解析远端路径后 `adb pull` 到临时目录，
// 并通过 EmitStdout 推送本地结果路径（不弹保存对话框，超出本域范围）。
func handlePull(op *adb.OpContext) adb.OpResult {
	pkg, fail := requireSinglePackage(op, "pull-apk")
	if fail != nil {
		return *fail
	}

	// 1. 解析远端 APK 路径。
	pathRes, fail := runOrFail(op, "pull-apk", "Failed to resolve APK path",
		op.Adb("shell", "pm", "path", pkg), true)
	if fail != nil {
		return *fail
	}
	remotePath, err := parsePackagePathOutput(pathRes.Stdout)
	if err != nil {
		op.EmitStderr(err.Error())
		return adb.OpResult{ExitCode: 2, Err: adbcore.NewOperationError("pull-apk", "Failed to resolve APK path", err.Error(), false)}
	}

	// 2. 选定本地落盘路径：OUTPUT_PATH 指定目录（备份用），否则临时目录。
	outDir := op.ParamStr("OUTPUT_PATH")
	if outDir == "" {
		tmp, err := os.MkdirTemp("", "workflow-tool-apk-*")
		if err != nil {
			op.EmitStderr(err.Error())
			return adb.OpResult{ExitCode: -1, Err: adbcore.NewOperationError("pull-apk", "Failed to create temp directory", err.Error(), true)}
		}
		outDir = tmp
	} else if err := os.MkdirAll(outDir, 0o755); err != nil {
		op.EmitStderr(err.Error())
		return adb.OpResult{ExitCode: -1, Err: adbcore.NewOperationError("pull-apk", "Failed to create output directory", err.Error(), true)}
	}
	localPath := filepath.Join(outDir, pkg+".apk")

	// 3. adb pull。
	pullRes, fail := runOrFail(op, "pull-apk", "Failed to export APK",
		op.Adb("pull", remotePath, localPath), true)
	if fail != nil {
		return *fail
	}

	message := fallbackMessage(pullRes.Stdout, fmt.Sprintf("Saved APK to %s", localPath))
	// 始终把本地路径单独推送一行，便于上层直接取用。
	op.EmitStdout(localPath)
	op.EmitStdout(message)
	return adb.OpResult{ExitCode: 0, Stdout: localPath + "\n" + message}
}
