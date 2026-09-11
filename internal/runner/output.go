package runner

import "strings"

// ReservedOutputKeys 是通用 Layer 1 outputs 的保留 key，脚本协议行命中会覆盖并触发 warning。
var ReservedOutputKeys = map[string]bool{
	"exit_code": true,
	"stdout":    true,
	"stderr":    true,
	"success":   true,
}

// parseOutputLine 解析一行是否匹配 ##[output key=value] 协议。
// 匹配成功返回 (key, value, true)；key 为空或格式不符返回 (_, _, false)。
func parseOutputLine(line string) (key, value string, ok bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "##[output ") || !strings.HasSuffix(line, "]") {
		return "", "", false
	}
	body := line[len("##[output ") : len(line)-1]
	idx := strings.Index(body, "=")
	if idx <= 0 {
		return "", "", false
	}
	return body[:idx], body[idx+1:], true
}

// parseProgressLine 解析一行是否匹配 ##[progress text] 协议。
// 命中的行不进 stdout 捕获、改以 "progress" 流 emit——前端对该流做原地覆盖
// （见 frontend/src/lib/outputFold.ts），是 shell/script 动作唯一能刷新单行进度的途径
// （\r 已被 splitLines 切成独立行，只会追加不会覆盖）。
func parseProgressLine(line string) (text string, ok bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "##[progress ") || !strings.HasSuffix(line, "]") {
		return "", false
	}
	return line[len("##[progress ") : len(line)-1], true
}

// parseTreeLine 解析一行是否匹配 ##[tree <json>] 协议（树帧，schema 见
// docs/action.md 输出协议：顶层 {title?, nodes:[TreeNode]}，仅 label 必填）。
// 命中的行不进 stdout 捕获、不以文本行显示（同 ##[progress] 待遇），改以 "tree"
// 流 emit——payload 为树 JSON 原文，前端 JSON.parse 后在输出控制台原地渲染
// 内联树块；解析失败由前端降级为单行错误节点，不炸渲染。Go 域（internal/adb）
// 不走本文本协议，直接 OpContext.EmitTree 发同一 "tree" 流。
func parseTreeLine(line string) (jsonStr string, ok bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "##[tree ") || !strings.HasSuffix(line, "]") {
		return "", false
	}
	body := line[len("##[tree ") : len(line)-1]
	if !strings.HasPrefix(body, "{") {
		return "", false
	}
	return body, true
}
