// apphome 集中维护 exe 目录约定与 baseDir 解析——main（GUI 组装根）与
// internal/cli（headless 子命令）共用的单一真相源，不依赖 Wails。
// exe-dir 约定：exe 同级目录（有 actions/ 则用之），dev 时回退当前工作目录。
package apphome

import (
	"os"
	"path/filepath"
)

// ExeDir 返回 exe 所在目录（同级有 actions/ 时用之），dev 模式回退当前工作目录。
func ExeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	dir := filepath.Dir(exe)
	if _, err := os.Stat(filepath.Join(dir, "actions")); err != nil {
		return "." // dev 时 actions/ 在项目根
	}
	return dir
}

// ResolveBaseDir 解析 CLI 的 baseDir：--base-dir > 环境变量 WORKFLOW_TOOL_HOME > exeDir 约定。
func ResolveBaseDir(flagVal string) string {
	if flagVal != "" {
		return flagVal
	}
	if v := os.Getenv("WORKFLOW_TOOL_HOME"); v != "" {
		return v
	}
	return ExeDir()
}
