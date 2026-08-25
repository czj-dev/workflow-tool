//go:build windows

package runner

import (
	"fmt"
	"os/exec"
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
