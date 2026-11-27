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

// UserDir 返回用户级配置目录：环境变量 WORKFLOW_TOOL_USER_HOME > ~/.workflow-tool。
// 与 exe 侧 baseDir（WORKFLOW_TOOL_HOME）是两条独立的轴：baseDir 装可执行文件同级、
// 可随包分发的内容（actions/、config.yaml…），UserDir 装不该随包走的用户数据
// （auth.json——Agent 三键）。HomeDir 不可用时回退 "."（与 ExeDir 的容错一致）。
func UserDir() string {
	if v := os.Getenv("WORKFLOW_TOOL_USER_HOME"); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return filepath.Join(home, ".workflow-tool")
}

// AuthPath 返回 Agent 三键（AI_BASE_URL / AI_AUTH_KEY / AI_MODEL）的存取位置：
// <UserDir>/auth.json。用户级文件，不随可执行文件分发，密钥不进 exe 同级目录。
func AuthPath() string {
	return filepath.Join(UserDir(), "auth.json")
}
