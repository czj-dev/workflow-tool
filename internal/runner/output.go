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
