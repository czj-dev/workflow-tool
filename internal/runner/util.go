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

// resolveScriptPath 把 script 路径解析为绝对路径（不加后缀），相对路径基于 baseDir。
func resolveScriptPath(script, baseDir string) (string, error) {
	p := script
	if !filepath.IsAbs(p) {
		p = filepath.Join(baseDir, p)
	}
	if _, err := os.Stat(p); err != nil {
		return "", fmt.Errorf("脚本不存在: %s", p)
	}
	return p, nil
}

// maxCaptureBytes 是 Stdout/Stderr 累积的软上限：超出只保留尾部，
// 防长跑输出（如误开 capture_output 的持续输出 action）撑爆内存。
// contains/matches 场景通常只关心最近输出，保留尾部足够。
const maxCaptureBytes = 256 * 1024

// capBuffer 是带总量上限的行累积器，超限保留尾部（丢弃最旧内容）。
type capBuffer struct {
	limit int
	buf   []byte
}

func newCapBuffer(limit int) *capBuffer {
	return &capBuffer{limit: limit}
}

// WriteLine 追加一行（自动补 \n）；超过 limit 时从头部截断，只留尾部。
func (c *capBuffer) WriteLine(line string) {
	if c == nil {
		return
	}
	c.buf = append(c.buf, line...)
	c.buf = append(c.buf, '\n')
	if len(c.buf) > c.limit {
		c.buf = c.buf[len(c.buf)-c.limit:]
	}
}

// String 返回累积内容；c 为 nil（capture_output=false）时返回空字符串。
func (c *capBuffer) String() string {
	if c == nil {
		return ""
	}
	return string(c.buf)
}
