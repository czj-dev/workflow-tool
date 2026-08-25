//go:build !windows

package runner

import (
	"fmt"
	"os/exec"
)

// resolveInterpreter 把 argv[0] 逻辑可执行名解析为实际路径（macOS/Linux）。
// bash/sh 走 PATH（BASH_PATH 显式覆盖优先）；pwsh 同样回退 powershell；
// python 按 macOS/Linux 惯例 python3 优先回退 python。
func resolveInterpreter(name, bashOverride string) (string, error) {
	switch name {
	case "bash", "sh":
		if bashOverride != "" {
			return bashOverride, nil
		}
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
		return "", fmt.Errorf("未找到 %s（PATH）", name)
	case "pwsh":
		if p, err := exec.LookPath("pwsh"); err == nil {
			return p, nil
		}
		if p, err := exec.LookPath("powershell"); err == nil {
			return p, nil
		}
		return "", fmt.Errorf("未找到 pwsh/powershell")
	case "python":
		if p, err := exec.LookPath("python3"); err == nil {
			return p, nil
		}
		if p, err := exec.LookPath("python"); err == nil {
			return p, nil
		}
		return "", fmt.Errorf("未找到 python3/python")
	default:
		return name, nil
	}
}
