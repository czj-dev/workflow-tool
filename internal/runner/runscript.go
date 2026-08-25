package runner

import (
	"os"
	"strings"
)

// writeRunScript 把内联 run 内容写入临时脚本文件，返回路径与清理函数（调用方 defer）。
// 行尾强制 LF——bash 遇 CRLF 报 $'\r': command not found；spec 有 WrapHead/WrapTail 时
// 按 头 + 内容 + 尾 拼接（pwsh 错误语义与退出码传播，见 shellspec.go）。
func writeRunScript(spec ShellSpec, content string) (string, func(), error) {
	f, err := os.CreateTemp("", "wf-run-*"+spec.Ext)
	if err != nil {
		return "", nil, err
	}
	path := f.Name()
	cleanup := func() { os.Remove(path) }

	var b strings.Builder
	if spec.WrapHead != "" {
		b.WriteString(spec.WrapHead)
		b.WriteString("\n")
	}
	b.WriteString(strings.ReplaceAll(content, "\r\n", "\n"))
	if !strings.HasSuffix(b.String(), "\n") {
		b.WriteString("\n")
	}
	if spec.WrapTail != "" {
		b.WriteString(spec.WrapTail)
		b.WriteString("\n")
	}
	if _, err := f.WriteString(b.String()); err != nil {
		f.Close()
		cleanup()
		return "", nil, err
	}
	if err := f.Close(); err != nil {
		cleanup()
		return "", nil, err
	}
	return path, cleanup, nil
}
