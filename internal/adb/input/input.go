// Package input 是 adb 输入域：input-text operation 按 ASCII / 非 ASCII 路由，
// 含中文等非 ASCII 文本经 ADBKeyboard 输入法广播输入（input text 命令不支持非 ASCII）。
package input

import (
	"strings"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// inputPlan 是 planInput 的路由结果。
type inputPlan struct {
	UseKeyboard bool
}

// planInput 决定输入路径：含非 ASCII（中文/emoji）或控制字符（换行/制表）走
// ADBKeyboard 输入法广播，其余走原生 input text（与历史行为一致）。
func planInput(text string) inputPlan {
	for _, r := range text {
		if r > 127 || r == '\n' || r == '\r' || r == '\t' {
			return inputPlan{UseKeyboard: true}
		}
	}
	return inputPlan{}
}

// escapeForInputText 把空格转为 %s（input text 无法直接输入字面空格）。
func escapeForInputText(s string) string {
	return strings.ReplaceAll(s, " ", "%s")
}

func init() {
	adb.RegisterOperation("input-text", handleInputText)
}

// handleInputText 按 planInput 路由：纯 ASCII 走原生 input text（空格转 %s），
// 含非 ASCII 走 ADBKeyboard 输入法广播。
func handleInputText(op *adb.OpContext) adb.OpResult {
	text := op.ParamStr("TEXT")
	if text == "" {
		return adb.OpResult{ExitCode: 2, Err: adbcore.NewOperationError("input-text", "TEXT is required", "", false)}
	}
	if planInput(text).UseKeyboard {
		return runViaKeyboard(op, text)
	}
	return runDirect(op, text)
}

// runDirect 原生路径：adb shell input text <escaped>。
func runDirect(op *adb.OpContext, text string) adb.OpResult {
	op.EmitStdout("路径: input text（ASCII）")
	if _, fail := runOrFail(op, "input-text", "input text 执行失败", op.Adb("shell", "input", "text", escapeForInputText(text)), false); fail != nil {
		return *fail
	}
	op.EmitStdout("已输入")
	return adb.OpResult{ExitCode: 0, Stdout: "已输入"}
}

// runOrFail 执行一次 adb ExecRequest（与 package 域同款约定）：
// 非零退出时推送 stderr 并构造结构化 OperationError。
func runOrFail(op *adb.OpContext, opName, failMsg string, req adbcore.ExecRequest, retryable bool) (*adbcore.ExecResult, *adb.OpResult) {
	res, err := adbcore.RunCommand(op.Ctx, req)
	if res == nil {
		return nil, &adb.OpResult{ExitCode: -1, Err: err, Stderr: err.Error()}
	}
	if res.ExitCode != 0 {
		op.EmitStderr(res.Stderr)
		return nil, &adb.OpResult{
			ExitCode: res.ExitCode,
			Stderr:   res.Stderr,
			Err:      adbcore.NewOperationError(opName, failMsg, strings.TrimSpace(res.Stderr), retryable),
		}
	}
	return res, nil
}
