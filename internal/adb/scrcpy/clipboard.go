package scrcpy

import (
	"strings"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// handleClipboardSet pushes TEXT onto the device clipboard via
// `adb shell cmd clipboard set`. Ported from ADBKit clipboard.go PushClipboard.
func handleClipboardSet(op *adb.OpContext) adb.OpResult {
	text := op.ParamStr("TEXT")
	if text == "" {
		return adb.OpResult{ExitCode: 2, Err: adbcore.NewOperationError("clipboard-set", "TEXT is required", "", false)}
	}

	res, err := adbcore.RunCommand(op.Ctx, op.Adb("shell", "cmd", "clipboard", "set", text))
	if err != nil {
		return adb.OpResult{ExitCode: -1, Err: err, Stderr: err.Error()}
	}
	if res.ExitCode != 0 {
		op.EmitStderr(res.Stderr)
		return adb.OpResult{
			ExitCode: res.ExitCode,
			Stderr:   res.Stderr,
			Err:      adbcore.NewOperationError("clipboard-set", "Failed to set device clipboard", res.Stderr, true),
		}
	}
	op.EmitStdout("Clipboard set")
	return adb.OpResult{ExitCode: 0, Stdout: "Clipboard set"}
}

// handleClipboardGet reads the device clipboard via `adb shell cmd clipboard
// get` and emits the text through EmitStdout. Ported from ADBKit clipboard.go
// GetClipboard.
func handleClipboardGet(op *adb.OpContext) adb.OpResult {
	res, err := adbcore.RunCommand(op.Ctx, op.Adb("shell", "cmd", "clipboard", "get"))
	if err != nil {
		return adb.OpResult{ExitCode: -1, Err: err, Stderr: err.Error()}
	}
	if res.ExitCode != 0 {
		op.EmitStderr(res.Stderr)
		return adb.OpResult{
			ExitCode: res.ExitCode,
			Stderr:   res.Stderr,
			Err:      adbcore.NewOperationError("clipboard-get", "Failed to read device clipboard", res.Stderr, true),
		}
	}
	text := strings.TrimRight(res.Stdout, "\r\n")
	op.EmitStdout(text)
	return adb.OpResult{ExitCode: 0, Stdout: text}
}
