package packagemgr

import (
	"fmt"
	"path/filepath"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// handleInstall 对应 install-package：校验 .apk 后执行 `adb install [flags] <apk>`。
// 默认仅 -r（覆盖安装）；可选 ALLOW_TEST(-t，允许测试包)/ALLOW_DOWNGRADE(-d，允许降级)，
// 默认均 false，向后兼容。
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

	res, fail := runOrFail(op, "install-package", "Failed to install APK", op.Adb(flags...), true)
	if fail != nil {
		return *fail
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
