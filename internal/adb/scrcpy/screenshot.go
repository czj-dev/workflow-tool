package scrcpy

import (
	"os"
	"strings"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// pngMagic 是 PNG 文件签名（8 字节）。screencap 在多 display 设备上会把
// "[Warning] Multiple displays were found..." 这类提示打到 stdout，混在 PNG 字节前面，
// 直接落盘会污染文件头导致图片无法解析。落盘前定位魔数、剥掉前置噪声即可。
const pngMagic = "\x89PNG\r\n\x1a\n"

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

	// DISPLAY_ID 可选：多 display 设备用 -d 指定截哪块屏，避免默认屏不确定 + 警告噪声。
	args := []string{"exec-out", "screencap", "-p"}
	if displayID := op.ParamStr("DISPLAY_ID"); displayID != "" {
		args = append(args, "-d", displayID)
	}

	res, err := adbcore.RunCommand(op.Ctx, op.Adb(args...))
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

	// 剥掉 PNG 魔数之前的任何噪声（多 display 警告等）；找不到魔数说明输出根本不是 PNG。
	png, noise, ok := stripPNGPrefix(res.Stdout)
	if !ok {
		return adb.OpResult{ExitCode: -1, Stderr: res.Stderr, Err: adbcore.NewOperationError("screenshot", "screencap output is not a valid PNG", res.Stderr, true)}
	}
	if noise != "" {
		op.EmitStderr(noise) // 把被剥掉的警告透传给前端，便于排查
	}

	if err := os.WriteFile(outputPath, []byte(png), 0o644); err != nil {
		return adb.OpResult{ExitCode: -1, Err: adbcore.NewOperationError("screenshot", "Failed to write screenshot file", err.Error(), true), Stderr: err.Error()}
	}

	op.EmitStdout(outputPath)
	return adb.OpResult{ExitCode: 0, Stdout: outputPath}
}

// stripPNGPrefix 定位 PNG 魔数、剥掉其前的噪声。
// 返回 (纯 PNG 字节, 被剥掉的前缀噪声, 是否含合法 PNG 魔数)。
func stripPNGPrefix(raw string) (png, noise string, ok bool) {
	idx := strings.Index(raw, pngMagic)
	if idx < 0 {
		return "", "", false
	}
	return raw[idx:], raw[:idx], true
}
