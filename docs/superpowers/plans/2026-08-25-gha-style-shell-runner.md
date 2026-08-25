# GHA 风格 ShellRunner 改造实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ShellRunner 改造成 GitHub Actions 模型——`command.run`（内联命令落临时脚本文件执行）+ `command.shell`（显式解释器指定，默认 bash/Windows Git Bash）+ 统一错误语义（`-eo pipefail`）+ `script:` 按扩展名路由解释器（.sh/.py/.js/.ps1）。

**Architecture:** runner 包新增 ShellSpec argv 模板注册表（每逻辑 shell 一条记录）+ 平台解释器解析（Windows bash 级联探测、排除 WSL）+ 临时脚本写入器；registry/workflow 的 `shell` 字段从「内联命令」改为「工具名」、内联命令改名 `run`；actionrun/api 适配传递；全部 YAML 一次性迁移（无兼容层）；新增验收动作与工作流。

**Tech Stack:** Go（Wails v3 alpha2.119 桌面项目）、gopkg.in/yaml.v3、Git Bash（Windows bash 来源）。

**Spec:** [docs/superpowers/specs/2026-08-25-gha-style-shell-runner-design.md](../specs/2026-08-25-gha-style-shell-runner-design.md)

## Global Constraints

- 锁定 Wails `v3.0.0-alpha2.119`，不升 alpha.3（绑定机制损坏）
- 所有注释、commit message、错误信息用中文（仓库既有风格：conventional prefix + 中文描述）
- 改 `internal/api` Service 方法/绑定类型签名后必须 `wails3 generate bindings` → `npm run build` → `go build`（或 `bash deploy/build.sh` 一条龙）
- 每条多步 Bash 命令显式 `cd /c/Users/ASUS/Documents/workflow-tool`（Git Bash 路径）；exe 被占用先 `taskkill //IM workflow-tool.exe //F`（本任务不产 exe，一般不需要）
- 测试命令：`go test ./internal/<pkg> -run <TestName> -v`（项目根执行）
- 修改 action/workflow YAML schema 后必须同步 `docs/action.md`、`docs/workflow.md`（Task 11 承载）
- 临时脚本文件行尾强制 LF（bash 遇 CRLF 报 `$'\r': command not found`）
- Windows 上绝不把 `C:\Windows\System32\bash.exe`（WSL 入口）当 bash/sh 用
- 找不到 bash 时报错提示（装 Git for Windows / 设 BASH_PATH），不静默回退 PowerShell

---

### Task 1: ShellSpec 注册表与解析

**Files:**
- Create: `internal/runner/shellspec.go`
- Test: `internal/runner/shellspec_test.go`

**Interfaces:**
- Produces:
  - `type ShellSpec struct { Template []string; Ext string; WrapHead string; WrapTail string }`
  - `const scriptPlaceholder = "{0}"`、`const DefaultShellName = "bash"`
  - `func LookupShellSpec(name string) (ShellSpec, error)`——空名返回 bash spec；内置名命中；其余按自定义模板解析（空白分词，必须含 `{0}`）
  - `func IsBuiltinShellName(name string) bool`、`func IsValidShellName(name string) bool`、`func KnownShellNames() string`
  - `func ShellNameByScript(script string) (string, error)`——`.sh`→bash、`.ps1`→pwsh、`.py`→python、`.js`→node；未知扩展名报错

- [ ] **Step 1: 写失败测试**

```go
// internal/runner/shellspec_test.go
package runner

import (
	"reflect"
	"strings"
	"testing"
)

func TestLookupShellSpec_BuiltinBash(t *testing.T) {
	spec, err := LookupShellSpec("bash")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"bash", "--noprofile", "--norc", "-eo", "pipefail", "{0}"}
	if !reflect.DeepEqual(spec.Template, want) {
		t.Fatalf("Template = %v, want %v", spec.Template, want)
	}
	if spec.Ext != ".sh" {
		t.Fatalf("Ext = %q, want .sh", spec.Ext)
	}
}

func TestLookupShellSpec_EmptyDefaultsToBash(t *testing.T) {
	spec, err := LookupShellSpec("")
	if err != nil {
		t.Fatal(err)
	}
	bashSpec, _ := LookupShellSpec("bash")
	if !reflect.DeepEqual(spec, bashSpec) {
		t.Fatalf("空名应等于 bash spec: %+v vs %+v", spec, bashSpec)
	}
}

func TestLookupShellSpec_PwshWrapping(t *testing.T) {
	spec, err := LookupShellSpec("pwsh")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(spec.WrapHead, "$ErrorActionPreference") {
		t.Fatalf("WrapHead 缺 ErrorActionPreference: %q", spec.WrapHead)
	}
	if !strings.Contains(spec.WrapTail, "LASTEXITCODE") {
		t.Fatalf("WrapTail 缺 LASTEXITCODE 传播: %q", spec.WrapTail)
	}
	if spec.Ext != ".ps1" {
		t.Fatalf("Ext = %q, want .ps1", spec.Ext)
	}
}

func TestLookupShellSpec_CmdQuotedPlaceholder(t *testing.T) {
	spec, err := LookupShellSpec("cmd")
	if err != nil {
		t.Fatal(err)
	}
	last := spec.Template[len(spec.Template)-1]
	if !strings.HasPrefix(last, `"`) || !strings.HasSuffix(last, `"`) {
		t.Fatalf("cmd 模板末元素应带引号包裹 {0}: %q", last)
	}
	if !strings.Contains(last, "{0}") {
		t.Fatalf("cmd 模板末元素应含 {0}: %q", last)
	}
}

func TestLookupShellSpec_CustomTemplate(t *testing.T) {
	spec, err := LookupShellSpec("perl -e {0}")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"perl", "-e", "{0}"}
	if !reflect.DeepEqual(spec.Template, want) {
		t.Fatalf("Template = %v, want %v", spec.Template, want)
	}
	if spec.Ext != ".sh" {
		t.Fatalf("自定义模板 Ext 默认 .sh, got %q", spec.Ext)
	}
}

func TestLookupShellSpec_CustomTemplateMissingPlaceholder(t *testing.T) {
	if _, err := LookupShellSpec("perl -e print"); err == nil {
		t.Fatal("不含 {0} 的自定义模板应报错")
	}
}

func TestIsValidShellName(t *testing.T) {
	for _, ok := range []string{"", "bash", "sh", "pwsh", "powershell", "python", "node", "cmd", "perl {0}"} {
		if !IsValidShellName(ok) {
			t.Errorf("IsValidShellName(%q) = false, want true", ok)
		}
	}
	for _, bad := range []string{"zsh", "perl", "{1}"} {
		if IsValidShellName(bad) {
			t.Errorf("IsValidShellName(%q) = true, want false", bad)
		}
	}
}

func TestShellNameByScript(t *testing.T) {
	cases := map[string]string{
		"foo.sh":        "bash",
		"foo.ps1":       "pwsh",
		"foo.py":        "python",
		"foo.js":        "node",
		"foo.PY":        "python", // 扩展名大小写不敏感
		"./x/foo.sh":    "bash",
	}
	for script, want := range cases {
		got, err := ShellNameByScript(script)
		if err != nil {
			t.Errorf("ShellNameByScript(%q) err: %v", script, err)
			continue
		}
		if got != want {
			t.Errorf("ShellNameByScript(%q) = %q, want %q", script, got, want)
		}
	}
	if _, err := ShellNameByScript("foo.rb"); err == nil {
		t.Fatal("未知扩展名应报错")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/runner -run 'TestLookupShellSpec|TestIsValidShellName|TestShellNameByScript' -v
```

期望：FAIL（`LookupShellSpec` 未定义，编译错误）。

- [ ] **Step 3: 实现 shellspec.go**

```go
// internal/runner/shellspec.go
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
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/runner -run 'TestLookupShellSpec|TestIsValidShellName|TestShellNameByScript' -v
```

期望：全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add internal/runner/shellspec.go internal/runner/shellspec_test.go && git commit -m "feat(runner): ShellSpec argv 模板注册表（GHA shell 语义）"
```

---

### Task 2: 解释器路径解析（Windows bash 级联 + pwsh 回退）

**Files:**
- Create: `internal/runner/shell_lookup_windows.go`（`//go:build windows`）
- Create: `internal/runner/shell_lookup_other.go`（`//go:build !windows`）
- Test: `internal/runner/shell_lookup_test.go`（`//go:build windows`——级联逻辑只在 Windows 编译；非 Windows 分支太薄，靠集成测试覆盖）

**Interfaces:**
- Consumes: Task 1 无依赖（本任务独立）
- Produces: `func resolveInterpreter(name, bashOverride string) (string, error)`——把 argv[0] 逻辑名解析为实际可执行路径；`bashOverride` 是 config.yaml `BASH_PATH` 显式覆盖（空则级联）

- [ ] **Step 1: 写失败测试**

```go
// internal/runner/shell_lookup_test.go
//go:build windows

package runner

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// fakeLookup 构造可控的 PATH 查找：hits 命中返回路径，其余报错。
func fakeLookup(hits map[string]string) func(string) (string, error) {
	return func(name string) (string, error) {
		if p, ok := hits[name]; ok {
			return p, nil
		}
		return "", fmt.Errorf("not found: %s", name)
	}
}

func TestLookupPosixShell_OverrideWins(t *testing.T) {
	dir := t.TempDir()
	override := filepath.Join(dir, "mybash.exe")
	if err := writeFile(override); err != nil {
		t.Fatal(err)
	}
	lookup := posixShellLookup{
		lookPath: fakeLookup(nil), // PATH 什么都找不到，也不该被用到
		validate: func(p string) error { return nil },
		dirs:     nil,
	}
	got, err := lookupPosixShell("bash", override, lookup)
	if err != nil {
		t.Fatal(err)
	}
	if got != override {
		t.Fatalf("got %q, want override %q", got, override)
	}
}

func TestLookupPosixShell_WSLBashExcluded(t *testing.T) {
	lookup := posixShellLookup{
		lookPath: fakeLookup(map[string]string{
			"bash": `C:\Windows\System32\bash.exe`, // PATH 命中的是 WSL 入口，必须跳过
		}),
		validate: func(p string) error { return nil },
		dirs:     []string{`C:\Program Files\Git\bin`},
	}
	got, err := lookupPosixShell("bash", "", lookup)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, `Git\bin\bash.exe`) {
		t.Fatalf("应回退到常见路径, got %q", got)
	}
}

func TestLookupPosixShell_NotFound(t *testing.T) {
	lookup := posixShellLookup{
		lookPath: fakeLookup(nil),
		validate: func(p string) error { return nil },
		dirs:     []string{`X:\nowhere`},
	}
	_, err := lookupPosixShell("bash", "", lookup)
	if err == nil {
		t.Fatal("全找不到应报错")
	}
	if !strings.Contains(err.Error(), "Git for Windows") {
		t.Fatalf("报错应含安装指引: %v", err)
	}
}

func TestResolveInterpreter_PwshFallsBackToPowerShell(t *testing.T) {
	// 本机环境无关性：直接测 resolveInterpreter 的 powershell 分支（Windows 必有）
	got, err := resolveInterpreter("powershell", "")
	if err != nil {
		t.Fatal(err)
	}
	if got != "powershell" {
		t.Fatalf("powershell 名应原样返回, got %q", got)
	}
}

// writeFile 写一个空文件（fake exe 用）。
func writeFile(p string) error {
	return osWriteFile(p)
}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/runner -run 'TestLookupPosixShell|TestResolveInterpreter' -v
```

期望：FAIL（`posixShellLookup`、`lookupPosixShell`、`resolveInterpreter` 未定义，编译错误）。

- [ ] **Step 3: 实现两个平台文件**

```go
// internal/runner/shell_lookup_windows.go
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
			validate: exec.LookPath,
			dirs:     commonPosixDirs(),
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
```

```go
// internal/runner/shell_lookup_other.go
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
```

注意：`shell_lookup_test.go` 里的 `osWriteFile` 辅助也需要定义。在同一测试文件底部加：

```go
func osWriteFile(p string) error {
	return os.WriteFile(p, []byte(""), 0755)
}
```

并在文件头 import 中加 `"os"`。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/runner -run 'TestLookupPosixShell|TestResolveInterpreter' -v
```

期望：全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add internal/runner/shell_lookup_windows.go internal/runner/shell_lookup_other.go internal/runner/shell_lookup_test.go && git commit -m "feat(runner): 解释器路径解析——Windows bash 级联探测排除 WSL"
```

---

### Task 3: 内联 run 临时脚本写入器

**Files:**
- Create: `internal/runner/runscript.go`
- Test: `internal/runner/runscript_test.go`

**Interfaces:**
- Consumes: Task 1 的 `ShellSpec`
- Produces: `func writeRunScript(spec ShellSpec, content string) (path string, cleanup func(), err error)`——写临时脚本（LF 强制 + WrapHead/WrapTail 拼接），返回路径与删除函数

- [ ] **Step 1: 写失败测试**

```go
// internal/runner/runscript_test.go
package runner

import (
	"os"
	"strings"
	"testing"
)

func TestWriteRunScript_ForcesLF(t *testing.T) {
	spec, _ := LookupShellSpec("bash")
	path, cleanup, err := writeRunScript(spec, "echo a\r\necho b\r\n")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "\r") {
		t.Fatalf("临时脚本必须 LF 行尾, got %q", data)
	}
	if !strings.HasSuffix(string(data), "echo b\n") {
		t.Fatalf("内容异常: %q", data)
	}
}

func TestWriteRunScript_PwshWrapping(t *testing.T) {
	spec, _ := LookupShellSpec("pwsh")
	path, cleanup, err := writeRunScript(spec, "Write-Output hi")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	lines := strings.Split(strings.TrimSuffix(s, "\n"), "\n")
	if lines[0] != pwshWrapHead {
		t.Fatalf("首行应为 WrapHead: %q", lines[0])
	}
	if lines[len(lines)-1] != pwshWrapTail {
		t.Fatalf("末行应为 WrapTail: %q", lines[len(lines)-1])
	}
	if !strings.Contains(s, "Write-Output hi") {
		t.Fatalf("原始内容丢失: %q", s)
	}
}

func TestWriteRunScript_CleanupRemovesFile(t *testing.T) {
	spec, _ := LookupShellSpec("bash")
	path, cleanup, err := writeRunScript(spec, "echo hi")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	cleanup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("cleanup 应删除临时文件 %s", path)
	}
}

func TestWriteRunScript_ExtSuffix(t *testing.T) {
	for _, name := range []string{"bash", "python", "node", "pwsh"} {
		spec, _ := LookupShellSpec(name)
		path, cleanup, err := writeRunScript(spec, "x")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasSuffix(path, spec.Ext) {
			t.Errorf("%s 临时文件应以 %s 结尾: %s", name, spec.Ext, path)
		}
		cleanup()
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/runner -run 'TestWriteRunScript' -v
```

期望：FAIL（`writeRunScript` 未定义，编译错误）。

- [ ] **Step 3: 实现 runscript.go**

```go
// internal/runner/runscript.go
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
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/runner -run 'TestWriteRunScript' -v
```

期望：全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add internal/runner/runscript.go internal/runner/runscript_test.go && git commit -m "feat(runner): 内联 run 临时脚本写入器——LF 强制 + pwsh 头尾包装"
```

---

### Task 4: ShellRunner 重构（spec 驱动 + 临时文件执行）

**Files:**
- Modify: `internal/runner/shell_runner.go`
- Modify: `internal/runner/util.go:19-30`（`resolveScript` → `resolveScriptPath`，去掉扩展名拼接）
- Modify: `internal/runner/shell_runner_test.go`（全量适配）

**Interfaces:**
- Consumes: Task 1 `LookupShellSpec`/`ShellNameByScript`、Task 2 `resolveInterpreter`、Task 3 `writeRunScript`
- Produces:
  - `ShellConfig` 字段变更：`Run string`（内联命令，原 `Shell` 改名）+ `Shell string`（解释器逻辑名，空=bash）+ `Script string`（带扩展名）+ `BashPath string`（config BASH_PATH 覆盖）；其余字段（Cwd/Timeout/Env/BaseDir/CaptureOutput/Builtins）不变
  - `buildCommandFromCfg(cfg ShellConfig) (*exec.Cmd, func(), error)`——第二个返回值是临时文件清理函数（script 形态为 no-op）

- [ ] **Step 1: 改造现有测试（失败态）**

对 `internal/runner/shell_runner_test.go` 做以下修改（先改测试再改实现，期间编译失败即「失败态」）：

1. 删除 `skipWindows` 函数及其所有调用处的调用（bash 默认让这些测试在 Windows 也真实执行——跨平台统一正是本次改造的核心；bash 不可用的环境由 `requireBash` 兜底跳过）。
2. 文件顶部加辅助函数：

```go
// requireBash 保证本机可解析 bash（Git Bash/MSYS2），否则跳过——
// 真实执行类测试依赖 bash 存在。
func requireBash(t *testing.T) {
	t.Helper()
	if _, err := resolveInterpreter("bash", ""); err != nil {
		t.Skipf("bash 不可用: %v", err)
	}
}
```

3. 所有 `ShellConfig{Shell: "..."}`（内联命令语义）改为 `ShellConfig{Run: "..."}`，并在每个真实执行测试开头加 `requireBash(t)`。
4. `TestShellRunner_MissingCommand` 改为断言 `Run/Script 都空` 的错误信息（实现里的错误文案改为「command: run 和 script 必须二选一」）：

```go
func TestShellRunner_MissingCommand(t *testing.T) {
	r := &ShellRunner{Cfg: ShellConfig{Timeout: time.Second}}
	res := r.Run(context.Background(), nil, func(s, l string) {})
	if res.Err == nil {
		t.Fatalf("run/script 都空时应报错")
	}
}
```

5. 删除 `TestBuildCommandWindowsShellUsesPowerShell`（断言已失效），替换为：

```go
// TestBuildCommand_WindowsDefaultBash 验证 Windows 下默认（不写 shell）走 bash
// 且 argv 含 -eo pipefail 错误语义、run 内容落临时文件（.sh 后缀）。
func TestBuildCommand_WindowsDefaultBash(t *testing.T) {
	requireBash(t)
	cmd, cleanup, err := buildCommandFromCfg(ShellConfig{Run: `echo "hi"`})
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	joined := strings.Join(cmd.Args, " ")
	if !strings.Contains(joined, "bash") {
		t.Fatalf("默认应走 bash: %s", joined)
	}
	if !strings.Contains(joined, "-eo") || !strings.Contains(joined, "pipefail") {
		t.Fatalf("bash 应带 -eo pipefail: %s", joined)
	}
	script := cmd.Args[len(cmd.Args)-1]
	if !strings.HasSuffix(script, ".sh") {
		t.Fatalf("run 内容应落 .sh 临时文件: %s", script)
	}
}
```

6. `TestShellRunner_CaptureOutput_DefaultOn` 删除 Windows PowerShell 分支（`[Console]::Error.WriteLine`），统一 bash 语法：

```go
func TestShellRunner_CaptureOutput_DefaultOn(t *testing.T) {
	requireBash(t)
	r := &ShellRunner{Cfg: ShellConfig{
		Run:     `echo "hello"; echo "err" >&2`,
		Timeout: 5 * time.Second,
	}}
	res := r.Run(context.Background(), nil, func(string, string) {})
	if res.ExitCode != 0 {
		t.Fatalf("exit code = %d, want 0", res.ExitCode)
	}
	if res.Stdout != "hello\n" {
		t.Fatalf("stdout = %q, want %q", res.Stdout, "hello\n")
	}
	if res.Stderr != "err\n" {
		t.Fatalf("stderr = %q, want %q", res.Stderr, "err\n")
	}
	if res.Outputs["exit_code"] != "0" || res.Outputs["success"] != "true" {
		t.Fatalf("outputs = %+v, want exit_code=0 success=true", res.Outputs)
	}
}
```

7. 其余引用 `Shell:` 字段的测试（`TestShellRunnerUsesParams`、`TestShellRunnerUsesStepEnvInText`、`TestShellRunner_CaptureOutput_ExplicitOff`、`TestShellRunner_CaptureOutput_ProtocolLine`、`TestShellRunner_ProgressLine`、`TestShellRunner_CaptureOutput_ReservedKeyOverride`、`TestShellRunner_StdoutCapped`、`TestShellRunner_Success`、`TestShellRunner_NonZeroExit`、`TestShellRunner_Timeout`、`TestShellRunner_Cancel`、`TestShellRunner_Stderr`）只做字段改名 `Shell:` → `Run:` + 开头加 `requireBash(t)`，内容不动。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/runner -v 2>&1 | head -30
```

期望：编译失败（`ShellConfig` 无 `Run` 字段 / `buildCommandFromCfg` 签名不符）。

- [ ] **Step 3: 重构 shell_runner.go**

对 `internal/runner/shell_runner.go` 做以下修改：

1. `ShellConfig`（[shell_runner.go:15-24](../../internal/runner/shell_runner.go#L15)）改为：

```go
// ShellConfig 是已解析、待执行的命令配置。
type ShellConfig struct {
	Run           string                // 内联命令（与 Script 二选一），执行时落临时脚本文件
	Shell         string                // 解释器逻辑名（空 = bash；内置名或含 {0} 的自定义模板）
	Script        string                // 脚本路径带扩展名（与 Run 二选一），按扩展名路由解释器
	Cwd           string                // 工作目录（必须存在）
	Timeout       time.Duration         // 超时
	Env           map[string]string     // 额外环境变量
	BaseDir       string                // exe 目录，用于解析相对 script 路径
	CaptureOutput *bool                 // nil 或指向 true = 捕获全量 stdout/stderr 供 outputs 使用；指向 false = 关闭（长跑/持续输出 action 用）
	Builtins      *builtinvars.Registry // 内置变量注册表（CURRENT_DATE/CURRENT_TIME/ADB_SERIAL），nil 时跳过该层查找
	BashPath      string                // config.yaml BASH_PATH 覆盖（bash/sh 解析级联第一优先），空则级联探测
}
```

2. `Run()` 中变量展开段（[shell_runner.go:51-53](../../internal/runner/shell_runner.go#L51)）`cfg.Shell = Expand(...)` 行改为 `cfg.Run`（`cfg.Shell` 是工具名，不做 `${VAR}` 展开）：

```go
	cfg.Run = Expand(ctx, cfg.Run, lookup, cfg.Builtins)
	cfg.Script = Expand(ctx, cfg.Script, lookup, cfg.Builtins)
	cfg.Cwd = Expand(ctx, cfg.Cwd, lookup, cfg.Builtins)
```

3. `Run()` 中构造命令处（[shell_runner.go:55-58](../../internal/runner/shell_runner.go#L55)）改为三返回值 + defer 清理：

```go
	cmd, cleanup, err := buildCommandFromCfg(cfg)
	if err != nil {
		return Result{Err: err, Duration: time.Since(start)}
	}
	defer cleanup()
```

4. `buildCommandFromCfg`（[shell_runner.go:101-134](../../internal/runner/shell_runner.go#L101)）整体替换为：

```go
// buildCommandFromCfg 按 Run/Script 与 ShellSpec 构造 exec.Cmd（GHA 语义）。
// Run 落临时脚本文件（返回 cleanup 供调用方 defer 删除）；Script 直接用真实路径，
// 解释器默认按扩展名路由、cfg.Shell 显式指定时以指定为准。
func buildCommandFromCfg(cfg ShellConfig) (*exec.Cmd, func(), error) {
	if cfg.Run == "" && cfg.Script == "" {
		return nil, nil, fmt.Errorf("command: run 和 script 必须二选一")
	}
	if cfg.Run != "" && cfg.Script != "" {
		return nil, nil, fmt.Errorf("command: run 和 script 互斥")
	}
	var spec ShellSpec
	var scriptPath string
	cleanup := func() {}
	if cfg.Run != "" {
		var err error
		spec, err = LookupShellSpec(cfg.Shell)
		if err != nil {
			return nil, nil, err
		}
		scriptPath, cleanup, err = writeRunScript(spec, cfg.Run)
		if err != nil {
			return nil, nil, err
		}
	} else {
		name := cfg.Shell
		if name == "" {
			var err error
			if name, err = ShellNameByScript(cfg.Script); err != nil {
				return nil, nil, err
			}
		}
		var err error
		if spec, err = LookupShellSpec(name); err != nil {
			return nil, nil, err
		}
		if scriptPath, err = resolveScriptPath(cfg.Script, cfg.BaseDir); err != nil {
			return nil, nil, err
		}
	}
	argv := expandTemplate(spec.Template, scriptPath)
	exe, err := resolveInterpreter(argv[0], cfg.BashPath)
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	return exec.Command(exe, argv[1:]...), cleanup, nil
}

// expandTemplate 把 argv 模板里的 {0} 替换为脚本路径（每个元素至多替换一次）。
func expandTemplate(template []string, scriptPath string) []string {
	argv := make([]string, len(template))
	for i, a := range template {
		argv[i] = strings.Replace(a, scriptPlaceholder, scriptPath, 1)
	}
	return argv
}
```

import 块加 `"strings"`。

5. `internal/runner/util.go` 的 `resolveScript`（[util.go:19-30](../../internal/runner/util.go#L19)）替换为（去掉 ext 参数与拼接——script 现在自带扩展名）：

```go
// resolveScriptPath 把 script 路径解析为绝对路径（不加后缀），相对路径基于 baseDir。
func resolveScriptPath(script, baseDir string) (string, error) {
	p := script
	if !filepath.IsAbs(p) {
		p = filepath.Join(baseDir, p)
	}
	if _, err := os.Stat(p); err != nil {
		return "", fmt.Errorf("脚本不存在: %s", p)
	}
	return p, nil
}
```

- [ ] **Step 4: 跑 runner 全量测试确认通过**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/runner -v
```

期望：全部 PASS（本机有 Git Bash，requireBash 不触发 skip）。此时 `internal/actionrun`、`internal/api` 会编译失败（引用旧 `Command.Shell`）——属预期，Task 5/6/8 修复；本步只跑 runner 包。

- [ ] **Step 5: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add internal/runner/shell_runner.go internal/runner/util.go internal/runner/shell_runner_test.go && git commit -m "feat(runner): ShellRunner 改 GHA 语义——run 落临时脚本 + shell 工具指定 + 默认 bash"
```

---

### Task 5: registry schema 改造（run/script/adb/llm 四选一）

**Files:**
- Modify: `internal/registry/registry.go:45-61`（Command struct）、`registry.go:155-213`（Validate）
- Modify: `internal/registry/registry_test.go`（现有用例的 `shell:` 字面量与断言适配）

**Interfaces:**
- Consumes: Task 1 `runner.IsValidShellName`、`runner.ShellNameByScript`、`runner.KnownShellNames`（registry 新增对 runner 的依赖；runner 不依赖 registry，无循环）
- Produces: `Command.Run`（原 `Command.Shell` 改名）+ `Command.Shell`（新语义：解释器修饰字段）

- [ ] **Step 1: 适配并新增测试**

对 `internal/registry/registry_test.go`：

1. 全部 YAML 字面量里 `command:` 块的 `shell: xxx` 键改为 `run: xxx`（值不动）。
2. `Command{Shell: "echo"}` 这类 Go 结构体字面量改为 `Command{Run: "echo"}`（如 [registry_test.go:357](../../internal/registry/registry_test.go#L357)）。
3. `TestLoad_ShellScriptMutex` 改名 `TestLoad_RunScriptMutex`，字段同步改。
4. 新增用例：

```go
// TestValidate_ShellModifier 校验 shell 修饰字段：非法值报错、配 adb/llm 形态报错。
func TestValidate_ShellModifier(t *testing.T) {
	cases := []struct {
		name    string
		yaml    string
		wantErr string
	}{
		{"合法内置名", "id: a\ntitle: A\ncommand:\n  run: echo\n  shell: pwsh\n", ""},
		{"合法自定义模板", "id: a\ntitle: A\ncommand:\n  run: echo\n  shell: \"perl {0}\"\n", ""},
		{"非法工具名", "id: a\ntitle: A\ncommand:\n  run: echo\n  shell: zsh\n", "command.shell 非法"},
		{"自定义模板缺占位符", "id: a\ntitle: A\ncommand:\n  run: echo\n  shell: perl\n", "command.shell 非法"},
		{"shell 配 adb 形态", "id: a\ntitle: A\ncommand:\n  adb:\n    operation: list-packages\n  shell: bash\n", "只能搭配 run/script"},
		{"shell 配 llm 形态", "id: a\ntitle: A\nparams:\n  - id: p\n    type: text\ncommand:\n  llm:\n    prompt: p\n  shell: bash\n", "只能搭配 run/script"},
	}
	for _, c := range cases {
		def, err := ParseAction([]byte(c.yaml))
		if err != nil {
			t.Fatalf("%s: parse: %v", c.name, err)
		}
		err = Validate(def)
		if c.wantErr == "" {
			if err != nil {
				t.Errorf("%s: 不应报错, got %v", c.name, err)
			}
		} else if err == nil || !strings.Contains(err.Error(), c.wantErr) {
			t.Errorf("%s: 应报含 %q 的错误, got %v", c.name, c.wantErr, err)
		}
	}
}

// TestValidate_ScriptExtension 校验 script 扩展名受支持。
func TestValidate_ScriptExtension(t *testing.T) {
	ok := &ActionDef{ID: "a", Title: "A", Command: Command{Script: "./s/hello.py"}}
	if err := Validate(ok); err != nil {
		t.Fatalf(".py 应合法: %v", err)
	}
	bad := &ActionDef{ID: "a", Title: "A", Command: Command{Script: "./s/hello.rb"}}
	if err := Validate(bad); err == nil {
		t.Fatal(".rb 扩展名应报错")
	}
}
```

（`registry_test.go` 头部 import 加 `"strings"`，若未有。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/registry -run 'TestValidate_ShellModifier|TestValidate_ScriptExtension|TestLoad_RunScriptMutex' -v
```

期望：FAIL（`Command` 无 `Run` 字段，编译错误）。

- [ ] **Step 3: 改 registry.go**

1. `Command` struct（[registry.go:45-61](../../internal/registry/registry.go#L45)）：

```go
// Command 是动作的执行块。
type Command struct {
	Run    string `yaml:"run"`    // 形态 A：内联命令（GHA run，落临时脚本执行）
	Script string `yaml:"script"` // 形态 B：脚本文件路径（带扩展名，按扩展名路由解释器）
	// Shell 是 run/script 形态的可选修饰字段：解释器逻辑名（默认 bash），
	// 或含 {0} 的自定义模板。只允许搭配 run/script。
	Shell   string            `yaml:"shell"`
	Cwd     string            `yaml:"cwd"`
	Timeout string            `yaml:"timeout"`
	Env     map[string]string `yaml:"env"`
	Stream  string            `yaml:"stream"` // "" 普通逐行；"logcat" 前端走结构化日志视图
	// nil/true=默认捕获；false=关闭（scrcpy/logcat 等长跑用）
	CaptureOutput *bool `yaml:"capture_output"`
	// Adb 是第三种执行形态：调用内置 ADBRunner 按 operation 分发到 adb 域服务。
	// 与 run/script/llm 四选一互斥。
	Adb AdbCommand `yaml:"adb"`
	// LLM 是第四种执行形态：调用内置 LLMRunner，按 System/Prompt 指向的 param 拼装 CLI 调用。
	// 与 run/script/adb 四选一互斥。
	LLM LLMCommand `yaml:"llm"`
}
```

2. `Validate`（[registry.go:162-181](../../internal/registry/registry.go#L162)）的四选一段替换为：

```go
	// command 四选一互斥：run / script / adb.operation / llm.prompt
	commandForms := 0
	if def.Command.Run != "" {
		commandForms++
	}
	if def.Command.Script != "" {
		commandForms++
	}
	if def.Command.Adb.Operation != "" {
		commandForms++
	}
	if def.Command.LLM.Prompt != "" {
		commandForms++
	}
	if commandForms == 0 {
		return fmt.Errorf("command 必须指定 run/script/adb/llm 之一")
	}
	if commandForms > 1 {
		return fmt.Errorf("command.run/script/adb/llm 四选一互斥")
	}
	// shell 是 run/script 形态的修饰字段
	if def.Command.Shell != "" {
		if def.Command.Adb.Operation != "" || def.Command.LLM.Prompt != "" {
			return fmt.Errorf("command.shell 只能搭配 run/script 形态")
		}
		if !runner.IsValidShellName(def.Command.Shell) {
			return fmt.Errorf("command.shell 非法 %q：应为 %s 之一或含 {0} 的自定义模板", def.Command.Shell, runner.KnownShellNames())
		}
	}
	// script 必须带受支持的扩展名（.sh/.ps1/.py/.js）
	if def.Command.Script != "" {
		if _, err := runner.ShellNameByScript(def.Command.Script); err != nil {
			return err
		}
	}
```

import 块加 `"workflow-tool/internal/runner"`。

- [ ] **Step 4: 跑 registry 全量测试确认通过**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/registry -v
```

期望：全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add internal/registry/registry.go internal/registry/registry_test.go && git commit -m "feat(registry): command 四选一改 run/script/adb/llm + shell 修饰字段校验"
```

---

### Task 6: actionrun Build 适配 + BASH_PATH 注入

**Files:**
- Modify: `internal/actionrun/build.go:28-33`（Deps）、`build.go:70-82`（default 分支）
- Modify: `internal/actionrun/build_test.go`

**Interfaces:**
- Consumes: Task 4 `ShellConfig{Run, Shell, Script, BashPath}`、Task 5 `Command.Run/Shell/Script`
- Produces: `Deps.BashPath func() string`——config.yaml BASH_PATH 的惰性读取（nil 安全，返回空串）；api 层在 Task 8 注入唯一实现

- [ ] **Step 1: 适配测试**

`internal/actionrun/build_test.go` 现有用例（`Command{Shell: "echo hi"}` 等）改 `Run:`，并新增：

```go
// TestBuildPassesShellFields 验证 Run/Shell/Script/BashPath 透传到 ShellConfig。
func TestBuildPassesShellFields(t *testing.T) {
	la := registry.LoadedAction{Def: registry.ActionDef{
		ID: "a", Title: "A",
		Command: registry.Command{Run: "echo hi", Shell: "pwsh"},
	}}
	deps := Deps{BashPath: func() string { return `C:\custom\bash.exe` }}
	sr := Build(context.Background(), la, deps, Options{}).(*runner.ShellRunner)
	if sr.Cfg.Run != "echo hi" || sr.Cfg.Shell != "pwsh" {
		t.Fatalf("Run/Shell 未透传: %+v", sr.Cfg)
	}
	if sr.Cfg.BashPath != `C:\custom\bash.exe` {
		t.Fatalf("BashPath 未透传: %q", sr.Cfg.BashPath)
	}
	// BashPath 为 nil deps 时不 panic、为空串
	sr2 := Build(context.Background(), la, Deps{}, Options{}).(*runner.ShellRunner)
	if sr2.Cfg.BashPath != "" {
		t.Fatalf("nil Deps.BashPath 应兜底空串: %q", sr2.Cfg.BashPath)
	}
}
```

（import 确认有 `context`、`runner`、`registry`——build_test.go 已有。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/actionrun -run TestBuildPassesShellFields -v
```

期望：FAIL（`Deps` 无 `BashPath` 字段，编译错误）。

- [ ] **Step 3: 改 build.go**

1. `Deps`（[build.go:27-33](../../internal/actionrun/build.go#L27)）加字段：

```go
type Deps struct {
	BaseDir   string                 // exe 目录，解析相对 script 路径
	ADBPaths  func() binary.Paths    // 二进制路径解析（config 覆盖 → PATH → 常见路径），唯一实现是 api.binPaths
	ADBDevice DeviceResolver         // 设备解析（serial 校验与回退）
	Builtins  *builtinvars.Registry  // 内置变量注册表（CURRENT_DATE/CURRENT_TIME/ADB_SERIAL）
	BashPath  func() string          // config.yaml BASH_PATH 惰性读取（bash/sh 解析级联第一优先），nil = 无覆盖
}
```

2. `Build` default 分支（[build.go:70-82](../../internal/actionrun/build.go#L70)）替换为：

```go
	default:
		return &runner.ShellRunner{Cfg: runner.ShellConfig{
			Run:           la.Def.Command.Run,
			Script:        la.Def.Command.Script,
			Shell:         la.Def.Command.Shell,
			BashPath:      bashPathOf(deps),
			Cwd:           la.Cwd, // raw，由 ShellRunner 用 params 替换
			Timeout:       la.Timeout,
			Env:           mergeEnv(la.Def.Command.Env, opts.ExtraEnv),
			BaseDir:       deps.BaseDir,
			CaptureOutput: capture,
			Builtins:      deps.Builtins,
		}}
```

3. 文件底部加：

```go
// bashPathOf 安全读取 deps.BashPath（nil 返回空串）。
func bashPathOf(deps Deps) string {
	if deps.BashPath == nil {
		return ""
	}
	return deps.BashPath()
}
```

- [ ] **Step 4: 跑 actionrun 全量测试确认通过**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/actionrun -v
```

期望：全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add internal/actionrun/build.go internal/actionrun/build_test.go && git commit -m "feat(actionrun): Build 透传 run/shell/script + BASH_PATH 注入"
```

---

### Task 7: workflow schema 与 executor 适配

**Files:**
- Modify: `internal/workflow/schema.go:36-49`（Step struct）、`schema.go:82-116`（Validate 的 step 循环）
- Modify: `internal/workflow/executor.go:26-38`（ShellRequest）、`executor.go:152-162`（dispatch 的 shell 分支）
- Modify: `internal/workflow/executor_test.go`、`internal/workflow/loader_test.go`（`Steps: []Step{{Shell: "echo hi"}}` 等 → `Run:`）

**Interfaces:**
- Consumes: Task 1 `runner.IsValidShellName`、`runner.KnownShellNames`
- Produces:
  - `Step.Run string`（原 `Step.Shell` 改名，yaml `run`）+ `Step.Shell string`（新语义：解释器，yaml `shell`）
  - `ShellRequest{Run string; Shell string; ...}`（其余字段 Ctx/Timeout/Env/CaptureOutput/Params/Emit 不变）

- [ ] **Step 1: 适配测试并新增校验用例**

`internal/workflow/executor_test.go` 与 `loader_test.go` 里所有 `Shell:` 字段字面量改 `Run:`（如 [executor_test.go:106](../../internal/workflow/executor_test.go#L106) `Steps: []Step{{Shell: "echo hi"}}` → `Steps: []Step{{Run: "echo hi"}}`；`req.Shell` 断言改 `req.Run`，如 [executor_test.go:95](../../internal/workflow/executor_test.go#L95)）。

`schema` 校验新增用例（加进 `expr_test.go` 或新建 `schema_test.go` 均可，放 `loader_test.go`）：

```go
// TestValidate_StepShellModifier 校验 step.shell 修饰字段：只搭配 run 形态、值合法。
func TestValidate_StepShellModifier(t *testing.T) {
	base := func(mutate func(*Step)) *WorkflowDef {
		def := &WorkflowDef{ID: "w", Title: "W", Steps: []Step{{Run: "echo hi"}}}
		mutate(&def.Steps[0])
		return def
	}
	if err := Validate(base(func(s *Step) { s.Shell = "pwsh" })); err != nil {
		t.Fatalf("run + shell:pwsh 应合法: %v", err)
	}
	if err := Validate(base(func(s *Step) { s.Shell = "zsh" })); err == nil {
		t.Fatal("非法工具名应报错")
	}
	if err := Validate(base(func(s *Step) { s.Shell = "perl {0}" })); err != nil {
		t.Fatalf("自定义模板应合法: %v", err)
	}
	// shell 配 action 形态应报错
	def := &WorkflowDef{ID: "w", Title: "W", Steps: []Step{{Action: "demo-echo", Shell: "bash"}}}
	if err := Validate(def); err == nil {
		t.Fatal("action step 配 shell 应报错")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/workflow -run 'TestValidate_StepShellModifier' -v
```

期望：FAIL（Step 无 `Run` 字段 / 校验未实现）。

- [ ] **Step 3: 改 schema.go 与 executor.go**

1. `Step` struct（[schema.go:36-49](../../internal/workflow/schema.go#L36)）的 `Shell` 行替换：

```go
	Run            string            `yaml:"run"`              // 直接执行的内联命令（GHA run）
	Shell          string            `yaml:"shell"`            // 可选修饰：解释器（默认 bash），只搭配 run
```

2. `Validate` step 循环（[schema.go:84-99](../../internal/workflow/schema.go#L84)）三选一段后追加：

```go
		if s.Run != "" {
			count++
		}
```

（替换原 `if s.Shell != ""` 计数），错误文案 `必须指定 action、sleep 或 shell 之一` 改 `必须指定 action、run 或 sleep 之一`、`action、sleep、shell 三者互斥` 改 `action、run、sleep 三者互斥`。循环末尾（`if s.If` 块后）加：

```go
		if s.Shell != "" {
			if s.Run == "" {
				return fmt.Errorf("steps[%d]: shell 只能搭配 run 形态", i)
			}
			if !runner.IsValidShellName(s.Shell) {
				return fmt.Errorf("steps[%d].shell 非法 %q：应为 %s 之一或含 {0} 的自定义模板", i, s.Shell, runner.KnownShellNames())
			}
		}
```

schema.go import 块加 `"workflow-tool/internal/runner"`。

3. `ShellRequest`（[executor.go:26-35](../../internal/workflow/executor.go#L26)）：

```go
// ShellRequest 是 executor 对单个 inline run step 的执行请求。
type ShellRequest struct {
	Ctx           context.Context
	Run           string // 已 ${{ }} 替换的内联命令
	Shell         string // 解释器逻辑名（空 = bash）
	Timeout       string // 原始字符串，回调方解析（缺省 60s）
	Env           map[string]string
	CaptureOutput *bool
	Params        map[string]any // 变量源（=StepCtx.Params）
	Emit          runner.EmitFunc
}
```

4. `dispatch` 的 shell 分支（[executor.go:152-162](../../internal/workflow/executor.go#L152)）替换为：

```go
	case step.Run != "":
		substituted, err := Substitute(step.Run, stepCtx)
		if err != nil {
			emit("stderr", err.Error())
			return runner.Result{ExitCode: -1, Err: err}
		}
		return shellRun(ShellRequest{
			Ctx: ctx, Run: substituted, Shell: step.Shell, Timeout: step.Timeout,
			Env: stepEnv, CaptureOutput: step.CaptureOutput,
			Params: stepCtx.Params, Emit: emit,
		})
```

- [ ] **Step 4: 跑 workflow 全量测试确认通过**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/workflow -v
```

期望：全部 PASS（`internal/api` 此时编译失败属预期，Task 8 修复）。

- [ ] **Step 5: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add internal/workflow/schema.go internal/workflow/executor.go internal/workflow/executor_test.go internal/workflow/loader_test.go && git commit -m "feat(workflow): step shell→run 改名 + shell 工具修饰字段"
```

---

### Task 8: api 层适配 + bindings 重新生成

**Files:**
- Modify: `internal/api/api.go:70`（runDeps 注入 BashPath）+ 新增 `bashOverride` 方法
- Modify: `internal/api/workflows.go:74-80`（buildStepInfos）、`workflows.go:196-203`（makeShellRun）
- Modify: `internal/api/actions.go:181`（GetVarReferenceCounts）、`actions.go:200`、`actions.go:219-236`（readScriptBytes）

**Interfaces:**
- Consumes: Task 5 `Command.Run`、Task 6 `Deps.BashPath`、Task 7 `Step.Run`/`ShellRequest.Run/Shell`
- Produces: bindings 重新生成（`frontend/bindings/`，前端零源码改动）

- [ ] **Step 1: 改 api.go——runDeps 注入 BASH_PATH**

[api.go:70](../../internal/api/api.go#L70) 的 runDeps 行改为：

```go
	svc.runDeps = actionrun.Deps{BaseDir: baseDir, ADBPaths: svc.binPaths, ADBDevice: svc.dev, Builtins: svc.builtins, BashPath: svc.bashOverride}
```

[api.go:88](../../internal/api/api.go#L88)（`adbOverrides` 后）加：

```go
// bashOverride 返回 config.yaml 的 BASH_PATH（bash/sh 探测级联第一优先）；未配置为空。
func (s *Service) bashOverride() string {
	s.gMu.Lock()
	defer s.gMu.Unlock()
	return s.global["BASH_PATH"]
}
```

- [ ] **Step 2: 改 workflows.go**

1. `buildStepInfos`（[workflows.go:74-80](../../internal/api/workflows.go#L74)）`case s.Shell != ""` 改：

```go
		case s.Run != "":
			label := s.Run
			if len(label) > 40 {
				label = label[:37] + "..."
			}
			info.Kind = "run"
			info.Label = label
```

（`WorkflowStepInfo.Kind` 的 `"shell"` 值改 `"run"`——[workflows.go:18](../../internal/api/workflows.go#L18) 注释同步；前端若按 kind 判断，见 Step 5 的说明。）

2. `makeShellRun`（[workflows.go:196-203](../../internal/api/workflows.go#L196)）的 ShellRunner 构造改：

```go
		r := &runner.ShellRunner{Cfg: runner.ShellConfig{
			Run:           req.Run,
			Shell:         req.Shell,
			BashPath:      s.bashOverride(),
			Timeout:       parseShellTimeout(req.Timeout),
			Env:           expandedEnv,
			CaptureOutput: req.CaptureOutput,
			Builtins:      s.builtins,
		}}
```

- [ ] **Step 3: 改 actions.go**

1. [actions.go:181](../../internal/api/actions.go#L181) `add(la.Def.Command.Shell)` → `add(la.Def.Command.Run)`。
2. [actions.go:200](../../internal/api/actions.go#L200) `add(step.Shell)` → `add(step.Run)`。
3. `readScriptBytes`（[actions.go:219-236](../../internal/api/actions.go#L219)）整体替换（script 现在带扩展名，直接读单文件）：

```go
// readScriptBytes 读取 script 脚本内容（路径自带扩展名），相对路径基于 baseDir。
// 读不到（路径含变量、文件缺失）返回 false——统计场景容忍缺文件。
func readScriptBytes(script, baseDir string) ([]byte, bool) {
	p := script
	if !filepath.IsAbs(p) {
		p = filepath.Join(baseDir, p)
	}
	d, err := os.ReadFile(p)
	return d, err == nil
}
```

- [ ] **Step 4: 检查前端 kind 消费 + bindings 重新生成**

前端检索（确认 `"shell"` kind 字符串的消费点）：

```bash
cd /c/Users/ASUS/Documents/workflow-tool && grep -rn '"shell"' frontend/src --include='*.tsx' --include='*.ts'
```

若有组件按 `kind === "shell"` 渲染（如 WorkflowStepInfo 展示），把该比较改为 `"run"`（同时改 i18n 文案 key 若涉及）。改动后跑 `cd frontend && npm run typecheck`。

bindings 重新生成 + 全量构建：

```bash
cd /c/Users/ASUS/Documents/workflow-tool && bash deploy/build.sh
```

期望：构建成功，产出 workflow-tool.exe。

- [ ] **Step 5: 全量 Go 测试**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/... 
```

期望：全部 PASS（此时 YAML 还没迁移，registry 对 `actions/` 真实目录的加载错误不在单测覆盖内——exe 启动后 UI 会显示加载错误，Task 9 修复）。

- [ ] **Step 6: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add internal/api frontend/bindings frontend/src && git commit -m "feat(api): run/shell 适配 + BASH_PATH 注入 + bindings 重生成"
```

---

### Task 9: YAML 全量迁移 + spm-download 薄壳消灭

**Files:**
- Modify: `actions/*.yaml` ×16（`shell:` → `run:`；1 个加 `set +e`；1 个 script 改 `.py`）
- Modify: `workflows/demo-all-features.yaml`、`workflows/xdzs-clean-reinstall.yaml`、`workflows/xdzs-install-broadcast.yaml`、`workflows/xdzs-debug-chain.yaml`、`workflows/xdzs-package-and-verify-res.yaml`（`shell:` → `run:`）
- Modify: `scripts/spm-download.py`（argv 空时从 env 读）
- Delete: `scripts/spm-download.sh`、`scripts/spm-download.ps1`
- 临时验证文件：`tmp_check.go`（验证后删除）

**Interfaces:**
- Consumes: Task 5/7 的校验规则（迁移后必须通过 registry/workflow 加载校验）
- Produces: 迁移完成的 YAML 集（Task 10 验收资产的前置）

- [ ] **Step 1: 机械改名 shell: → run:**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && sed -i 's/^\([[:space:]]*\)shell:/\1run:/' actions/*.yaml workflows/*.yaml && git diff --stat
```

期望 diff：16 个 action 文件 + 5 个 workflow 文件（`adb-device-snapshot.yaml` 无 shell step 不变）。sed 只动键行（行首空白 + `shell:`），块内容（如 `adb shell ...`）不受影响——用 `git diff` 抽查 2-3 个文件确认。

- [ ] **Step 2: 特例 1——xdzs-device-init.yaml 加 set +e**

该动作作者注释明确要求容错逐条执行（默认 `-e` 会改变其行为，显式保真）。把 `run: |` 块内容开头（第一行注释前）插入两行，迁移后的 command 块：

```yaml
command:
  run: |
    # ponytail: 逐条尽力执行（disable-verify/setenforce 等命令会返回非零码 + stderr 提示，
    # 但都是无害的，照抄 wt_debug.sh 的容错行为）。默认 -eo pipefail 下必须显式关闭 -e。
    set +e
    echo "[init] adb root & remount"
    adb root
    adb shell disable-verify 99
    adb remount
    adb shell setenforce 0
    adb shell setprop vecentek.model 1
    sleep 2

    echo "[init] 授予权限"
    for pkg in com.baidu.che.codriver com.baidu.che.codriver.voicesetting.demo; do
      for perm in RECORD_AUDIO READ_EXTERNAL_STORAGE WRITE_EXTERNAL_STORAGE CALL_PHONE SYSTEM_ALERT_WINDOW ACCESS_FINE_LOCATION WRITE_SECURE_SETTINGS ; do
        adb shell pm grant "$pkg" "android.permission.$perm" || true
      done
    done

    adb shell pm grant com.tinnove.aispace1 android.permission.WRITE_SECURE_SETTINGS || true
    adb shell pm grant com.tinnove.aispace android.permission.WRITE_SECURE_SETTINGS || true
    adb shell pm grant com.tinnove.aispace1 android.permission.SYSTEM_ALERT_WINDOW || true
    adb shell pm grant com.tinnove.aispace android.permission.SYSTEM_ALERT_WINDOW || true

    echo "[init] 完成"
  timeout: 60s
```

- [ ] **Step 3: 特例 2——log-spm-download.yaml 直挂 python + 删薄壳**

1. `actions/log-spm-download.yaml` 的 `script: ./scripts/spm-download` 改为 `script: ./scripts/spm-download.py`。
2. `scripts/spm-download.py` 的 `main()` 开头（[spm-download.py:35-39](../../scripts/spm-download.py#L35)）替换为（吸收薄壳的 env→argv 桥接职责；`OUT_DIR` 为空省略的语义保留）：

```python
def main() -> None:
    if len(sys.argv) not in (3, 4):
        # script 形态直挂时无薄壳传参：参数从环境变量读（action params 会注入子进程 env）
        if len(sys.argv) == 1 and os.environ.get("ZIP_NAME") and os.environ.get("INNER_PATH"):
            args = [os.environ["ZIP_NAME"], os.environ["INNER_PATH"]]
            out_dir = os.environ.get("OUT_DIR", "")
            if out_dir:
                args.append(out_dir)
            sys.argv.extend(args)
        else:
            sys.exit(__doc__)
    zip_name, inner = sys.argv[1], sys.argv[2].lstrip("/")
    out_dir = sys.argv[3] if len(sys.argv) == 4 else os.getcwd()
```

（`os` 已 import——脚本内 `os.makedirs`/`os.getcwd` 在用；确认文件头 import 有 `os`、`sys`。）
3. 删薄壳：

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git rm scripts/spm-download.sh scripts/spm-download.ps1
```

- [ ] **Step 4: 特例 3——demo-all-features.yaml 的 PowerShell 步骤改 bash**

[workflows/demo-all-features.yaml:90-94](../../workflows/demo-all-features.yaml#L90)（sed 已把键改为 `run:`）整步替换为：

```yaml
  # 10. 故意失败（stderr + 非零退出，且不 continue_on_error）—— 验证 error 态 + stderr 分层，作为整条 workflow 的终止点
  - id: fail-demo
    name: 演示失败
    run: |
      echo "演示失败：这是一条 stderr 输出" >&2
      exit 1
```

- [ ] **Step 5: 加载校验验证（临时检查程序）**

创建 `tmp_check.go`（项目根，验证后删）：

```go
//go:build ignore

package main

import (
	"fmt"

	"workflow-tool/internal/registry"
	"workflow-tool/internal/workflow"
)

func main() {
	reg := registry.Load("actions", ".")
	for _, e := range reg.Errors {
		fmt.Println("ACTION ERR:", e.File, e.Error)
	}
	fmt.Println("actions loaded:", len(reg.Actions))
	wf := workflow.Load("workflows")
	for _, e := range wf.Errors {
		fmt.Println("WF ERR:", e.File, e.Error)
	}
	fmt.Println("workflows loaded:", len(wf.Workflows))
}
```

```bash
cd /c/Users/ASUS/Documents/workflow-tool && go run tmp_check.go && rm tmp_check.go
```

期望输出：`actions loaded: 34`、`workflows loaded: 6`、无任何 ERR 行。有 ERR 则按提示修复对应 YAML 后重跑。

- [ ] **Step 6: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add actions workflows scripts/spm-download.py && git commit -m "refactor(yaml): 全量迁移 shell→run + spm-download 直挂 python 消灭薄壳"
```

---

### Task 10: 验收资产（5 action + 1 workflow + 2 脚本）

**Files:**
- Create: `actions/test-shell-bash.yaml`、`actions/test-shell-failfast.yaml`、`actions/test-shell-pwsh.yaml`、`actions/test-script-python.yaml`、`actions/test-script-node.yaml`
- Create: `scripts/test/hello.py`、`scripts/test/hello.js`
- Create: `workflows/test-shell-acceptance.yaml`

**Interfaces:**
- Consumes: Task 9 后的 schema（run/shell/script 扩展名）
- Produces: 验收资产全套（Task 12 真机验收的对象）

- [ ] **Step 1: 创建 5 个验收动作 + 2 个脚本**

```yaml
# actions/test-shell-bash.yaml
id: test-shell-bash
title: "验收: bash 默认形态"
icon: hi:test
description: "验证默认 bash：多行块 + ${VAR} 展开 + ##[output] 协议 + 退出码 0（预期成功）"
params:
  - id: NAME
    label: 名字
    type: text
    default: workflow-tool
command:
  run: |
    echo "hello ${NAME}"
    echo "多行第二行"
    echo "##[output verified=yes]"
  timeout: 30s
```

```yaml
# actions/test-shell-failfast.yaml
id: test-shell-failfast
title: "验收: -eo pipefail 快速失败"
icon: hi:test
description: "预期失败：第 2 行 exit 3，-e 生效后续行不执行、exit_code=3（用于验证错误处理语义统一）"
command:
  run: |
    echo "first"
    exit 3
    echo "不应出现此行"
  timeout: 30s
```

```yaml
# actions/test-shell-pwsh.yaml
id: test-shell-pwsh
title: "验收: pwsh 退出码传播"
icon: hi:test
description: "显式 shell: pwsh；原生命令(cmd /c exit 5)非零退出码应经 WrapTail 传播为脚本退出码（预期 exit_code=5；无 pwsh 的环境会报错属预期）"
command:
  shell: pwsh
  run: |
    Write-Output "before"
    cmd /c exit 5
    Write-Output "原生命令非零不中断 PS 脚本，但退出码应传播"
  timeout: 30s
```

```yaml
# actions/test-script-python.yaml
id: test-script-python
title: "验收: script .py 路由"
icon: hi:test
description: "script: ./scripts/test/hello.py——按 .py 扩展名路由到 python（-u 无缓冲）"
command:
  script: ./scripts/test/hello.py
  timeout: 30s
```

```yaml
# actions/test-script-node.yaml
id: test-script-node
title: "验收: script .js 路由"
icon: hi:test
description: "script: ./scripts/test/hello.js——按 .js 扩展名路由到 node"
command:
  script: ./scripts/test/hello.js
  timeout: 30s
```

```python
# scripts/test/hello.py
import sys

print(f"hello from python {sys.version_info.major}.{sys.version_info.minor}")
print(f"##[output py_major={sys.version_info.major}]")
```

```js
// scripts/test/hello.js
console.log("hello from node " + process.version);
console.log("##[output node_major=" + process.version.slice(1).split(".")[0] + "]");
```

- [ ] **Step 2: 创建验收 workflow**

```yaml
# workflows/test-shell-acceptance.yaml
id: test-shell-acceptance
title: "验收: GHA shell 端到端"
icon: hi:workflow
description: "run(bash)+output → pwsh 退出码传播(continue_on_error 容错无 pwsh 环境) → if 引用 outputs → script python action → sleep → 收尾"

steps:
  - id: produce
    name: 生产数据
    run: |
      echo "start"
      echo "##[output build_id=42]"

  - id: pwsh-code
    name: "pwsh 退出码传播（预期失败不中断）"
    shell: pwsh
    run: |
      Write-Output "native fail next"
      cmd /c exit 5
    continue_on_error: true

  - id: consume
    name: 消费 outputs
    if: steps.produce.outputs.build_id == '42'
    run: echo "build_id=${{ steps.produce.outputs.build_id }}"

  - id: py
    name: script python action
    action: test-script-python

  - id: wait
    name: 等待 1s
    sleep: 1

  - id: done
    name: 收尾
    run: echo "all done"
```

- [ ] **Step 3: 加载校验验证（复用临时检查）**

重建 Task 9 Step 5 的 `tmp_check.go`，跑：

```bash
cd /c/Users/ASUS/Documents/workflow-tool && go run tmp_check.go && rm tmp_check.go
```

期望：`actions loaded: 39`、`workflows loaded: 7`、无 ERR。

- [ ] **Step 4: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add actions/test-*.yaml scripts/test workflows/test-shell-acceptance.yaml && git commit -m "test(assets): GHA shell 改造验收动作与工作流"
```

---

### Task 11: 文档同步（action.md / workflow.md / CLAUDE.md）

**Files:**
- Modify: `docs/action.md`（形态定义、字段表、脚本形态章节、示例）
- Modify: `docs/workflow.md`（step 三选一、shell step 字段、示例）
- Modify: `CLAUDE.md`（架构描述里的「四选一」与 shell/script 表述）

**Interfaces:**
- Consumes: Task 1-10 的最终行为
- Produces: 与 schema 一致的使用者文档

- [ ] **Step 1: 更新 docs/action.md**

1. 字段总表（[action.md:54-55](../../docs/action.md#L54) 附近）的 `shell`/`script` 行替换，并在 command 字段表加 `shell` 修饰字段行：

```markdown
| `run` | 内联命令（GHA 风格），写入临时脚本文件执行。默认 `bash`（Windows 自动探测 Git Bash）；多行块照旧支持 |
| `script` | 脚本文件路径（必须带扩展名），按扩展名路由解释器：`.sh`→bash、`.ps1`→pwsh、`.py`→python、`.js`→node |
| `shell` | 可选修饰字段：解释器逻辑名，默认 `bash`。可选 `bash`/`sh`/`pwsh`/`powershell`/`python`/`node`/`cmd`，或含 `{0}` 的自定义模板（如 `"perl {0}"`，按空白分词）。只允许搭配 `run`/`script` 形态 |
```

2. 「四选一互斥」表述（[action.md:50](../../docs/action.md#L50)、[action.md:417](../../docs/action.md#L417)）改为：`run`、`script`、`adb`、`llm` 四选一互斥。
3. 错误处理章节新增（放在「输出协议」章节前）：

```markdown
## 错误处理语义（run / script 形态）

- `bash`（默认）：`--noprofile --norc -eo pipefail`——任一命令非零即中断、管道取最右非零码
- `sh`：`-e`
- `pwsh` / `powershell`：脚本头注入 `$ErrorActionPreference = 'stop'`；尾部注入退出码传播
  （原生命令如 adb/gradlew 的非零退出码默认不会成为脚本退出码，包装行解决该 PowerShell 经典坑）
- `python` / `node`：异常与退出码自然传播（`python -u` 无缓冲 stdout，保 `##[progress]` 流式）
- `cmd`：无错误语义增强（GHA 亦然）

逃生门：脚本内 `set +e`、`|| true`、`$ErrorActionPreference = 'Continue'` 照常有效——
默认严格、显式放宽。

内联 `run` 的内容写入临时脚本文件（LF 行尾）执行，无引号/转义边界问题；`script` 直接
执行真实文件，不落副本。

## Windows bash 探测级联

`bash`/`sh` 在 Windows 按以下顺序解析（绝不静默回退 PowerShell，找不到即报错）：

1. `config.yaml` 的 `BASH_PATH`（显式覆盖）
2. `PATH` 中的 bash（排除 `C:\Windows\System32\bash.exe`——那是 WSL 入口，语义完全不同）
3. 常见安装路径：`C:\Program Files\Git\bin` → `C:\Program Files\Git\usr\bin` →
   `C:\Program Files (x86)\Git\bin` → `C:\msys64\usr\bin` → `C:\msys64\bin`

找不到时安装 Git for Windows 或设置 `BASH_PATH`。macOS/Linux 直接用 PATH。
```

4. 「脚本形态（script）」章节（[action.md:194-213](../../docs/action.md#L194)）整段重写（去掉「按 OS 自动拼接 .sh/.ps1」，改为扩展名路由 + 单份维护示例，示例用 `script: ./scripts/spm-download.py`）。
5. 全文示例里的 `shell: |` 块改 `run: |`（[action.md:361](../../docs/action.md#L361)、[action.md:383](../../docs/action.md#L383)、[action.md:402](../../docs/action.md#L402) 等处，`grep -n 'shell:' docs/action.md` 逐一处理）。

- [ ] **Step 2: 更新 docs/workflow.md**

step 三选一 `action` / `shell` / `sleep` → `action` / `run` / `sleep`；`shell` step 字段说明改为 `run`（内联命令，默认 bash）+ 新增可选 `shell` 修饰字段（语义同 action 的 `command.shell`）；全文示例 `shell:` 键改 `run:`（`grep -n 'shell:' docs/workflow.md` 逐一处理）。

- [ ] **Step 3: 更新 CLAUDE.md**

架构小节的这些表述更新：
- 「`command.shell` 与 `command.script` 与 `command.adb.operation` 与 `command.llm.prompt` 四选一互斥必选其一」→「`command.run` 与 `command.script` 与 `command.adb.operation` 与 `command.llm.prompt` 四选一互斥必选其一；`command.shell` 是 run/script 形态的可选修饰字段（解释器，默认 bash/Windows Git Bash，GHA 语义）」
- 「`script` 路径不含扩展名，按 OS 自动加 `.sh`/`.ps1`」→「`script` 路径带扩展名，按扩展名路由解释器（.sh/.ps1/.py/.js）」
- `runner.Runner` 描述里「`ShellRunner`（按 OS 构造 `exec.Cmd`，Windows 用 PowerShell/pwsh，其他用 `sh -c`…）」→「`ShellRunner`（GHA 语义：`run` 内容落临时脚本、argv 模板注册表驱动、默认 bash——Windows 级联探测 Git Bash 且排除 WSL 入口，`-eo pipefail` 错误语义）」
- workflow 小节「（action / inline shell / sleep 三选一）」→「（action / inline run / sleep 三选一，step 可选 `shell:` 修饰解释器）」

- [ ] **Step 4: 文档一致性自检**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && grep -n 'shell:' docs/action.md docs/workflow.md | grep -v 'shell: bash\|shell: pwsh\|shell: "'
```

期望：无输出（所有残留 `shell:` 键用法都是新的工具指定语义）。

- [ ] **Step 5: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add docs/action.md docs/workflow.md CLAUDE.md && git commit -m "docs: action/workflow schema 文档同步 GHA shell 语义"
```

---

### Task 12: 全量构建 + 真机验收

**Files:**
- 无新文件（构建产物 + 手动验收）

**Interfaces:**
- Consumes: Task 1-11 全部
- Produces: 验收通过的发布构建

- [ ] **Step 1: 全量测试（含前端）**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/... && cd frontend && npm test && npm run lint && npm run typecheck
```

期望：全部通过（前端 lint 若有 pre-existing 警告，与本次改动无关的不阻塞）。

- [ ] **Step 2: 全量构建**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && bash deploy/build.sh
```

期望：构建成功产出 workflow-tool.exe（frontend → bindings → go build 顺序由脚本保证）。

- [ ] **Step 3: 真机验收清单（启动 exe，逐项跑）**

exe 必须与 `actions/`、`workflows/`、`scripts/`、`config.yaml` 同级目录运行（dev 为项目根）：

| # | 资产 | 预期 |
| --- | --- | --- |
| 1 | `test-shell-bash` | 成功；输出 hello workflow-tool + 多行第二行；outputs 含 `verified=yes` |
| 2 | `test-shell-failfast` | 失败；exit_code=3；**「不应出现此行」未出现**（-e 中断生效） |
| 3 | `test-shell-pwsh` | 失败；exit_code=5（WrapTail 传播）；两行 Write-Output 均出现 |
| 4 | `test-script-python` | 成功；hello from python 3.x |
| 5 | `test-script-node` | 成功；hello from node vXX |
| 6 | `test-shell-acceptance` workflow | produce 成功 → pwsh 步失败但 continue_on_error → consume 执行（build_id=42）→ python action 成功 → sleep → all done；整体 exit_code=0 |
| 7 | `log-json-extract`（旧动作回归） | 粘贴一行含 JSON 日志，正常提取——**Windows 上首次真正可执行**（heredoc bash 语法） |
| 8 | `xdzs-device-init`（旧动作回归） | 逐条容错执行（set +e 保真），非 set -e 中断 |
| 9 | `demo-all-features` workflow（回归） | 全流程通过；fail-demo 步 stderr 出现「演示失败」中文行 |

- [ ] **Step 4: 验收结果记录 + 最终 Commit**

把验收清单结果（每项通过/失败一句话）追加到 spec 文件末尾「验收记录」小节（失败项先修复再记录）：

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add docs/superpowers/specs/2026-08-25-gha-style-shell-runner-design.md && git commit -m "docs(spec): GHA shell 改造真机验收记录"
```

---

## Self-Review 结论

- **Spec 覆盖**：spec 的决策记录 1-7、执行引擎、错误语义、迁移清单、验收资产、spm-download 薄壳消灭、孤儿脚本不动、文档更新——分别对应 Task 1-12；spec 迁移清单遗漏的 workflows/*.yaml shell step 迁移已在 Task 9 补上（5 个文件 + demo-all-features 的 PowerShell 步骤特例）。
- **占位符**：无 TBD/TODO；所有代码步骤给全量代码，机械 YAML 改名给 sed 规则 + 特例全文。
- **类型一致性**：`ShellConfig{Run/Shell/Script/BashPath}`（Task 4）与 actionrun Build（Task 6）、api makeShellRun（Task 8）字段一致；`ShellRequest{Run/Shell}`（Task 7）与 executor dispatch、api（Task 8）一致；`Deps.BashPath func() string`（Task 6）与 api.bashOverride（Task 8）签名一致；`resolveInterpreter(name, bashOverride)` 在 Task 2 定义、Task 4 消费。
