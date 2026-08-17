package packagemgr

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// installProgressPattern 匹配 adb install 进度行 "[  5%] ..."（输出到 stderr）。
var installProgressPattern = regexp.MustCompile(`\[\s*(\d+)%\]\s*(.*)`)

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
	sawOutput := false
	onLine := func(stream, line string) {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			return
		}
		// 进度行 "[ NN%] ..." adb 写到 stderr（同 push/pull），转成 progress emit 原地刷新。
		if m := installProgressPattern.FindStringSubmatch(trimmed); len(m) > 1 {
			op.EmitProgress(fmt.Sprintf("install: %s%%", strings.TrimSpace(m[1])))
			return
		}
		// 状态行（Performing Streamed Install / Success / Failure [...]）：adb 视版本/PTY
		// 写 stdout 或 stderr，都实时追加显示给用户；stderr 额外入 buf 供失败详情兜底。
		if stream == "stderr" {
			stderrBuf.WriteString(trimmed)
			stderrBuf.WriteByte('\n')
		}
		op.EmitStdout(trimmed)
		sawOutput = true
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

	// exitCode==0 不足以判定成功：adb install 偶现退出码 0 但输出 "Failure [...]"
	// （PTY 下退出码语义不可靠 / 旧版 adb）。以输出里的 Success/Failure 关键字为权威判据。
	combined := res.Stdout + "\n" + res.Stderr
	if !installReportsSuccess(combined) {
		detail := extractInstallFailure(combined)
		if detail == "" {
			detail = "adb install 未返回 Success（输出无成功标记）"
		}
		op.EmitStderr(detail)
		return adb.OpResult{
			ExitCode: 1,
			Stderr:   detail,
			Err:      adbcore.NewOperationError("install-package", "Failed to install APK", detail, true),
		}
	}

	message := fmt.Sprintf("Installed APK from %s", filepath.Base(apk))
	// 仅在 adb 未打印任何过程行时补兜底 message；否则用户已看到 Success，避免冗余。
	if !sawOutput {
		op.EmitStdout(message)
	}
	return adb.OpResult{ExitCode: 0, Stdout: message}
}

// installReportsSuccess 判定 adb install 输出是否明确表示成功。
// adb 成功时输出独立的 "Success" 行；失败时输出 "Failure [...]"。
func installReportsSuccess(output string) bool {
	if strings.Contains(output, "Failure") {
		return false
	}
	for _, line := range strings.Split(output, "\n") {
		if strings.TrimSpace(line) == "Success" {
			return true
		}
	}
	return false
}

// extractInstallFailure 提取失败原因行（优先含 Failure 的行）。
func extractInstallFailure(output string) string {
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.Contains(trimmed, "Failure") {
			return trimmed
		}
	}
	return ""
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
