package runner

import (
	"fmt"
	"os"
	"path/filepath"
)

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
