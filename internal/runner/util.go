package runner

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// ansiRe 匹配 ANSI CSI 转义序列（颜色/样式控制码，如 \x1b[31;1m、\x1b[0m）。
var ansiRe = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)

// stripANSI 去除 ANSI 转义序列。PowerShell 的错误流、部分 CLI（如 adb、claude）
// 会输出彩色控制码，前端按纯文本渲染时会显示成可见乱码（如 [31;1m）。
func stripANSI(s string) string {
	return ansiRe.ReplaceAllString(s, "")
}

// resolveScript 把无扩展名脚本路径解析为完整路径（加 ext），相对路径基于 baseDir。
func resolveScript(script, ext, baseDir string) (string, error) {
	p := script
	if !filepath.IsAbs(p) {
		p = filepath.Join(baseDir, p)
	}
	p += ext
	if _, err := os.Stat(p); err != nil {
		return "", fmt.Errorf("脚本不存在: %s", p)
	}
	return p, nil
}
