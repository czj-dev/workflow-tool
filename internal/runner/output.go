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
