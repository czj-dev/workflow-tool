package runner

import (
	"fmt"
	"path/filepath"
	"strings"
)

// ShellSpec 描述一个逻辑 shell 的执行模板（GitHub Actions shell 语义移植）。
// Template 是 argv 模板，"{0}" 占位符在构造 exec.Cmd 时替换为脚本文件路径。
type ShellSpec struct {
	Template []string // argv 模板；cmd 模板的 {0} 元素自带引号包裹
	Ext      string   // 内联 run 落临时脚本的扩展名；自定义模板默认 .sh
	WrapHead string   // 写入脚本内容前的包装行（pwsh 错误语义）
	WrapTail string   // 追加到脚本内容后的包装行（pwsh 退出码传播）
}

// scriptPlaceholder 是脚本路径占位符（自定义模板必须包含它）。
const scriptPlaceholder = "{0}"

// DefaultShellName 是 YAML 不写 shell: 时的默认解释器——统一 bash，
// 两个平台语义一致（Windows 依赖 Git Bash，见 resolveInterpreter）。
const DefaultShellName = "bash"

// pwshWrap* 是 PowerShell 的 GHA 同款包装：cmdlet 错误即中断（ErrorActionPreference）
// + 原生命令退出码传播（PowerShell 默认不把 adb/gradlew 等原生命令的非零码当脚本退出码）。
const (
	pwshWrapHead = "$ErrorActionPreference = 'stop'"
	pwshWrapTail = "if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }"
)

// builtinShellSpecs 内置逻辑 shell 注册表。Template[0] 是逻辑可执行名，
// 构造 exec.Cmd 时经 resolveInterpreter 解析为实际路径（Git Bash / pwsh 回退等）。
var builtinShellSpecs = map[string]ShellSpec{
	"bash":       {Template: []string{"bash", "--noprofile", "--norc", "-eo", "pipefail", scriptPlaceholder}, Ext: ".sh"},
	"sh":         {Template: []string{"sh", "-e", scriptPlaceholder}, Ext: ".sh"},
	"pwsh":       {Template: []string{"pwsh", "-NoProfile", "-Command", scriptPlaceholder}, Ext: ".ps1", WrapHead: pwshWrapHead, WrapTail: pwshWrapTail},
	"powershell": {Template: []string{"powershell", "-NoProfile", "-Command", scriptPlaceholder}, Ext: ".ps1", WrapHead: pwshWrapHead, WrapTail: pwshWrapTail},
	"python":     {Template: []string{"python", "-u", scriptPlaceholder}, Ext: ".py"}, // -u 无缓冲 stdout，保 ##[progress] 流式
	"node":       {Template: []string{"node", scriptPlaceholder}, Ext: ".js"},
	"cmd":        {Template: []string{"cmd", "/D", "/Q", "/V:ON", "/C", "\"" + scriptPlaceholder + "\""}, Ext: ".cmd"},
}

// LookupShellSpec 按名字解析 ShellSpec：空名 → 默认 bash；内置名直接命中；
// 其余视为自定义模板（按空白分词，与 GHA 一致不支持引号分组，必须含 {0}）。
func LookupShellSpec(name string) (ShellSpec, error) {
	if name == "" {
		name = DefaultShellName
	}
	if spec, ok := builtinShellSpecs[name]; ok {
		return spec, nil
	}
	words := strings.Fields(name)
	has := false
	for _, w := range words {
		if w == scriptPlaceholder {
			has = true
		}
	}
	if !has {
		return ShellSpec{}, fmt.Errorf("command.shell 非法 %q：应为 %s 之一或含 {0} 的自定义模板", name, KnownShellNames())
	}
	return ShellSpec{Template: words, Ext: ".sh"}, nil
}

// IsBuiltinShellName 判断是否内置 shell 名。
func IsBuiltinShellName(name string) bool {
	_, ok := builtinShellSpecs[name]
	return ok
}

// IsValidShellName 校验 shell 值合法性（空/内置名/含 {0} 的自定义模板）。
func IsValidShellName(name string) bool {
	_, err := LookupShellSpec(name)
	return err == nil
}

// KnownShellNames 返回内置名列表（错误信息用）。
func KnownShellNames() string {
	return "bash/sh/pwsh/powershell/python/node/cmd"
}

// extToShellName 是 script 扩展名 → 逻辑 shell 的路由表。
var extToShellName = map[string]string{
	".sh":  "bash",
	".ps1": "pwsh", // pwsh 未装时由 resolveInterpreter 回退 powershell 5
	".py":  "python",
	".js":  "node",
}

// ShellNameByScript 按脚本路径扩展名推断逻辑 shell 名（script 形态的默认解释器）。
func ShellNameByScript(script string) (string, error) {
	name, ok := extToShellName[strings.ToLower(filepath.Ext(script))]
	if !ok {
		return "", fmt.Errorf("script 扩展名不受支持 %q（支持 .sh/.ps1/.py/.js）", script)
	}
	return name, nil
}
