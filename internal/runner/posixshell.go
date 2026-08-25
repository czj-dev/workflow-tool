package runner

import (
	"fmt"
	"path/filepath"
	"strings"
)

// posixShellLookup 收拢 bash/sh 探测的外部依赖（PATH 查找、可执行校验、候选目录），
// 便于单测注入。级联逻辑本身与平台无关——纯字符串与路径判断——所以这里不带
// build tag：带了的话注入式设计在 macOS/Linux 上一条用例都跑不到，等于白做
// （design 第 177 行要求「探测函数接受候选注入，单测不依赖真实机器状态」）。
// 真正与平台相关的部分（谁来调它、候选目录取值）留在 shell_lookup_windows.go。
type posixShellLookup struct {
	lookPath func(string) (string, error) // PATH 查找
	validate func(string) error           // 路径可执行性校验
	dirs     []string                     // 常见安装目录（在其中找 <name>.exe）
}

// lookupPosixShell Windows bash/sh 级联：显式覆盖 → PATH（排除 System32 的 WSL 入口）
// → 常见 Git Bash/MSYS2 目录。找不到报错并给安装指引，绝不静默回退 PowerShell。
func lookupPosixShell(name, override string, lk posixShellLookup) (string, error) {
	if override != "" {
		if lk.validate(override) == nil {
			return override, nil
		}
		return "", fmt.Errorf("BASH_PATH 指定的 %q 不可执行", override)
	}
	if p, err := lk.lookPath(name); err == nil && !isWSLBash(p) {
		return p, nil
	}
	for _, dir := range lk.dirs {
		cand := filepath.Join(dir, name+".exe")
		if lk.validate(cand) == nil {
			return cand, nil
		}
	}
	return "", fmt.Errorf("未找到 %s：请安装 Git for Windows，或在 config.yaml 设置 BASH_PATH 指向 bash.exe", name)
}

// isWSLBash 判断路径是否 System32 的 WSL bash/sh——它们以 Linux 视角解释路径与
// 脚本，与 Git Bash 语义完全不同，混入即隐秘坑。
func isWSLBash(p string) bool {
	return strings.Contains(strings.ToLower(filepath.Clean(p)), `\system32\`)
}
