package input

import (
	"strings"
	"time"

	"workflow-tool/internal/adb"
)

// pasteHint 是剪贴板桥失败时给用户的原因与出路。
const pasteHint = "剪贴板桥需 Android 10+；若目标 App 不响应粘贴键，可安装 ADBKeyboard 输入法替代"

// runViaClipboard 剪贴板桥：cmd clipboard set → input keyevent 279 粘贴 →
// RESTORE_CLIPBOARD=true 时延迟 ~500ms 后恢复原剪贴板（防恢复竞态覆盖粘贴内容）。
func runViaClipboard(op *adb.OpContext, text string) adb.OpResult {
	op.EmitStdout("路径: 剪贴板桥（含非 ASCII）")
	restore := op.ParamBool("RESTORE_CLIPBOARD")

	var backup string
	if restore {
		res, fail := runOrFail(op, "input-text", "读取原剪贴板失败", op.Adb("shell", "cmd", "clipboard", "get"), false)
		if fail != nil {
			return *fail
		}
		backup = strings.TrimRight(res.Stdout, "\r\n")
	}

	if _, fail := runOrFail(op, "input-text", "设置剪贴板失败（"+pasteHint+"）", op.Adb("shell", "cmd", "clipboard", "set", text), false); fail != nil {
		return *fail
	}
	if _, fail := runOrFail(op, "input-text", "触发粘贴失败（"+pasteHint+"）", op.Adb("shell", "input", "keyevent", "279"), false); fail != nil {
		return *fail
	}

	if restore {
		select {
		case <-op.Ctx.Done():
		case <-time.After(500 * time.Millisecond):
		}
		if _, fail := runOrFail(op, "input-text", "恢复剪贴板失败", op.Adb("shell", "cmd", "clipboard", "set", backup), false); fail != nil {
			// 恢复失败不影响输入结果，仅告警。
			op.EmitStderr("警告: 恢复原剪贴板失败（不影响已输入内容）")
		}
	}
	op.EmitStdout("已通过剪贴板输入")
	return adb.OpResult{ExitCode: 0, Stdout: "已通过剪贴板输入"}
}
