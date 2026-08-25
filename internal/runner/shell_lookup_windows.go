//go:build windows

package runner

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
)

// resolveInterpreter 把 argv[0] 逻辑可执行名解析为实际路径（Windows）。
// bash/sh 走级联（BASH_PATH → PATH 排除 WSL → 常见安装目录）；pwsh 未装回退
// powershell 5；python 固定 "python"；其余名字原样交 exec（PATH 解析）。
func resolveInterpreter(name, bashOverride string) (string, error) {
	switch name {
	case "bash", "sh":
		return lookupPosixShell(name, bashOverride, posixShellLookup{
			lookPath: exec.LookPath,
			validate: func(p string) error {
				_, err := exec.LookPath(p)
				return err
			},
			dirs: commonPosixDirs(),
		})
	case "pwsh":
		if p, err := exec.LookPath("pwsh"); err == nil {
			return p, nil
		}
		if p, err := exec.LookPath("powershell"); err == nil {
			return p, nil
		}
		return "", fmt.Errorf("未找到 pwsh（回退 powershell 也失败）：请安装 PowerShell 7+")
	case "python":
		return "python", nil // Windows 惯例：python.org 安装名为 python.exe
	default:
		// powershell/node/cmd/自定义模板首元素：原样交 exec
		return name, nil
	}
}

// posixShellLookup 收拢 Windows bash/sh 探测的外部依赖，便于单测注入。
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

// commonPosixDirs 返回常见 Git for Windows / MSYS2 安装目录（bash 与 sh 同目录存在）。
func commonPosixDirs() []string {
	return []string{
		`C:\Program Files\Git\bin`,
		`C:\Program Files\Git\usr\bin`,
		`C:\Program Files (x86)\Git\bin`,
		`C:\msys64\usr\bin`,
		`C:\msys64\bin`,
	}
}
