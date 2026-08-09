package scrcpy

import (
	"os"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// handleScreenshot captures a PNG via `adb exec-out screencap -p` and writes the
// raw bytes to OUTPUT_PATH. Ported from ADBKit recording.go TakeScreenshot.
//
// The binary PNG bytes flow through adbcore's string buffer untouched (Go strings
// are arbitrary byte sequences), then os.WriteFile restores them to disk. The
// resolved path is emitted via EmitStdout (the upstream save dialog is out of
// scope in this framework).
func handleScreenshot(op *adb.OpContext) adb.OpResult {
	outputPath := op.ParamStr("OUTPUT_PATH")
	if outputPath == "" {
		return adb.OpResult{ExitCode: 2, Err: adbcore.NewOperationError("screenshot", "OUTPUT_PATH is required", "", false)}
	}

	res, err := adbcore.RunCommand(op.Ctx, op.Adb("exec-out", "screencap", "-p"))
	if err != nil {
		return adb.OpResult{ExitCode: -1, Err: err, Stderr: err.Error()}
	}
	if res.ExitCode != 0 {
		op.EmitStderr(res.Stderr)
		return adb.OpResult{
			ExitCode: res.ExitCode,
			Stderr:   res.Stderr,
			Err:      adbcore.NewOperationError("screenshot", "Failed to capture screenshot", res.Stderr, true),
		}
	}

	if err := os.WriteFile(outputPath, []byte(res.Stdout), 0o644); err != nil {
		return adb.OpResult{ExitCode: -1, Err: adbcore.NewOperationError("screenshot", "Failed to write screenshot file", err.Error(), true), Stderr: err.Error()}
	}

	op.EmitStdout(outputPath)
	return adb.OpResult{ExitCode: 0, Stdout: outputPath}
}
