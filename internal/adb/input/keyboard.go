package input

import (
	_ "embed"
	"encoding/base64"
	"os"
	"strings"
	"time"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// keyboardAPK 是随二进制内嵌的 ADBKeyboard 安装包；未安装时自动落盘并 adb install。
//
//go:embed assets/keyboardservice.apk
var keyboardAPK []byte

const (
	adbKeyboardPkg = "com.android.adbkeyboard"
	adbKeyboardIME = "com.android.adbkeyboard/.AdbIME"
	imeSettleDelay = 600 * time.Millisecond // ime set 后切换生效需少量时间
	commitDelay    = 300 * time.Millisecond // 广播后等文本提交再恢复原 IME
)

// installHint 是自动安装失败时的兜底出路。
const installHint = "自动安装 ADBKeyboard 失败，可手动执行：adb install -r -g keyboardservice.apk"

// runViaKeyboard 走 ADBKeyboard 输入法：检测安装 → 记录当前 IME →
// enable+set ADBKeyboard → am broadcast ADB_INPUT_B64（base64 规避空格/引号/$/非 ASCII 的
// shell 转义）→ 默认恢复原 IME（KEEP_IME=true 时保留 ADBKeyboard，便于连续输入）。
// 相比旧剪贴板桥（cmd clipboard set + keyevent 279 粘贴），不受 Android 10+ 后台剪贴板
// 写入限制影响，车机/手机通用。
func runViaKeyboard(op *adb.OpContext, text string) adb.OpResult {
	op.EmitStdout("路径: ADBKeyboard 输入法广播（含非 ASCII）")

	// 1. 检测 ADBKeyboard，未安装则自动安装内嵌 APK
	if fail := ensureKeyboardInstalled(op); fail != nil {
		return *fail
	}

	// 2. 记录当前 IME 以便输入后恢复
	prevIME := ""
	if r, f := runOrFail(op, "input-text", "读取当前输入法失败", op.Adb("shell", "settings", "get", "secure", "default_input_method"), false); f == nil {
		prevIME = strings.TrimSpace(r.Stdout)
	}

	// 3. 启用并切换到 ADBKeyboard
	if _, fail := runOrFail(op, "input-text", "启用 ADBKeyboard 失败", op.Adb("shell", "ime", "enable", adbKeyboardIME), false); fail != nil {
		return *fail
	}
	if _, fail := runOrFail(op, "input-text", "切换到 ADBKeyboard 失败", op.Adb("shell", "ime", "set", adbKeyboardIME), false); fail != nil {
		return *fail
	}
	sleepCtx(op, imeSettleDelay)

	// 4. base64 广播文本
	b64 := base64.StdEncoding.EncodeToString([]byte(text))
	if _, fail := runOrFail(op, "input-text", "广播输入文本失败", op.Adb("shell", "am", "broadcast", "-a", "ADB_INPUT_B64", "--es", "msg", b64), false); fail != nil {
		return *fail
	}

	// 5. 默认恢复原 IME（避免设备停留在 ADBKeyboard 导致原软键盘不可用）
	if !op.ParamBool("KEEP_IME") && prevIME != "" && prevIME != adbKeyboardIME {
		sleepCtx(op, commitDelay)
		if _, fail := runOrFail(op, "input-text", "恢复原输入法失败", op.Adb("shell", "ime", "set", prevIME), false); fail != nil {
			op.EmitStderr("警告: 恢复原输入法失败（不影响已输入内容）")
		}
	}
	op.EmitStdout("已通过 ADBKeyboard 输入")
	return adb.OpResult{ExitCode: 0, Stdout: "已通过 ADBKeyboard 输入"}
}

// sleepCtx 是可被 ctx 取消的等待。
func sleepCtx(op *adb.OpContext, d time.Duration) {
	select {
	case <-op.Ctx.Done():
	case <-time.After(d):
	}
}

// ensureKeyboardInstalled 检测 ADBKeyboard，未安装则把内嵌 APK 落盘临时文件后
// adb install。返回非 nil 表示失败（调用方直接返回该 OpResult）。
func ensureKeyboardInstalled(op *adb.OpContext) *adb.OpResult {
	res, fail := runOrFail(op, "input-text", "查询已安装输入法失败", op.Adb("shell", "pm", "list", "packages", adbKeyboardPkg), false)
	if fail != nil {
		return fail
	}
	if strings.Contains(res.Stdout, adbKeyboardPkg) {
		return nil
	}

	op.EmitStdout("未检测到 ADBKeyboard，正在自动安装...")
	tmp, err := os.CreateTemp("", "adbkeyboard-*.apk")
	if err != nil {
		return &adb.OpResult{ExitCode: -1, Err: adbcore.NewOperationError("input-text", "创建临时 APK 文件失败", err.Error(), false), Stderr: err.Error()}
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(keyboardAPK); err != nil {
		tmp.Close()
		return &adb.OpResult{ExitCode: -1, Err: adbcore.NewOperationError("input-text", "写入临时 APK 失败", err.Error(), false), Stderr: err.Error()}
	}
	tmp.Close()

	if _, fail := runOrFail(op, "input-text", "自动安装 ADBKeyboard 失败（"+installHint+"）", op.Adb("install", "-r", "-g", tmp.Name()), false); fail != nil {
		return fail
	}
	op.EmitStdout("ADBKeyboard 安装完成")
	return nil
}
