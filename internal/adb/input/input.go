// Package input 是 adb 输入域：input-text operation 按 ASCII / 非 ASCII 路由，
// 含中文等非 ASCII 文本经剪贴板桥输入（input text 命令不支持非 ASCII）。
package input

import "strings"

// inputPlan 是 planInput 的路由结果。
type inputPlan struct {
	UseClipboard bool
}

// planInput 决定输入路径：含非 ASCII（中文/emoji）或控制字符（换行/制表）走
// 剪贴板桥，其余走原生 input text（与历史行为一致）。
func planInput(text string) inputPlan {
	for _, r := range text {
		if r > 127 || r == '\n' || r == '\r' || r == '\t' {
			return inputPlan{UseClipboard: true}
		}
	}
	return inputPlan{}
}

// escapeForInputText 把空格转为 %s（input text 无法直接输入字面空格）。
func escapeForInputText(s string) string {
	return strings.ReplaceAll(s, " ", "%s")
}
