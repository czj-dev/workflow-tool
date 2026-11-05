// Package cli 是 workflow-tool 的 headless 子命令入口（list/describe/run），
// 供外部 Agent 从 shell 发现、描述、运行 action/workflow 并拿到输出。
// 它逐字镜像执行核心的 emit（零解码、零状态），复用 registry/workflow/actionrun/runner，
// 绝不 import Wails。
package cli

import (
	"fmt"
	"os"
)

// Run 是 CLI 子命令入口。args[0] 是子命令，返回进程退出码：
// 命令退出码透传；CLI 级错误固定返回 2。
func Run(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "用法: workflow-tool <list|describe|run> ...")
		return exitCLIError
	}
	switch args[0] {
	case "list":
		return cmdList(args[1:])
	case "describe":
		return cmdDescribe(args[1:])
	case "run":
		return cmdRun(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "未知子命令 %q（支持 list/describe/run）\n", args[0])
		return exitCLIError
	}
}
