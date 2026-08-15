package packagemgr

import (
	"fmt"
	"path/filepath"
	"strings"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// handleInstall 对应 install-package：校验 .apk 后执行 `adb install [flags] <apk>`。
// 默认仅 -r（覆盖安装）；可选 ALLOW_TEST(-t，允许测试包)/ALLOW_DOWNGRADE(-d，允许降级)，
// 默认均 false，向后兼容。
// 使用 PTY 流式模式以捕获安装进度百分比（adb install 在 stdout 为 TTY 时才输出 [NN%]）。
func handleInstall(op *adb.OpContext) adb.OpResult {
	apk := op.ParamStr("APK_PATH")
	if apk == "" {
		return adb.OpResult{ExitCode: 2, Err: adbcore.NewOperationError("install-package", "APK_PATH is required", "", false)}
	}
	if err := adbcore.ValidateAPKFile(apk); err != nil {
		return adb.OpResult{ExitCode: 2, Err: err, Stderr: err.Error()}
	}

	// 构造 install 标志：-r 始终带；-t/-d 按可选 param。
	flags := []string{"install", "-r"}
	if op.ParamBool("ALLOW_TEST") {
		flags = append(flags, "-t")
	}
	if op.ParamBool("ALLOW_DOWNGRADE") {
		flags = append(flags, "-d")
	}
	flags = append(flags, apk)

	var stderrBuf strings.Builder
	onLine := func(stream, line string) {
		if stream == "stderr" {
			if trimmed := strings.TrimSpace(line); trimmed != "" {
				stderrBuf.WriteString(trimmed)
				stderrBuf.WriteByte('\n')
			}
			return
		}
		// stdout: 进度行直接转发给前端
		op.EmitProgress(strings.TrimSpace(line))
	}

	res, err := adbcore.RunStreaming(op.Ctx, op.AdbStreamPTY(true, onLine, flags...))
	if err != nil {
		detail := stderrBuf.String()
		if detail == "" && err != nil {
			detail = err.Error()
		}
		op.EmitStderr(detail)
		return adb.OpResult{ExitCode: -1, Err: adbcore.NewOperationError("install-package", "Failed to install APK", detail, true), Stderr: detail}
	}
	if res.ExitCode != 0 {
		detail := strings.TrimSpace(stderrBuf.String())
		if detail == "" {
			detail = strings.TrimSpace(res.Stderr)
		}
		op.EmitStderr(detail)
		return adb.OpResult{
			ExitCode: res.ExitCode,
			Stderr:   detail,
			Err:      adbcore.NewOperationError("install-package", "Failed to install APK", detail, true),
		}
	}

	message := extractFirstLine(res.Stdout)
	if message == "" {
		message = fmt.Sprintf("Installed APK from %s", filepath.Base(apk))
	}
	op.EmitStdout(message)
	return adb.OpResult{ExitCode: 0, Stdout: message}
}

// requireSinglePackage 解析 PACKAGE 入参，缺失时返回结构化错误 OpResult（调用方直接返回）。
func requireSinglePackage(op *adb.OpContext, opName string) (string, *adb.OpResult) {
	pkg := op.ParamStr("PACKAGE")
	if pkg == "" {
		return "", &adb.OpResult{
			ExitCode: 2,
			Err:      adbcore.NewOperationError(opName, "PACKAGE is required", "", false),
		}
	}
	trimmed, err := validatePackageName(pkg)
	if err != nil {
		return "", &adb.OpResult{ExitCode: 2, Err: err, Stderr: err.Error()}
	}
	return trimmed, nil
}
