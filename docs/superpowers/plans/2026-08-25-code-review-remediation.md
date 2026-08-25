# GHA shell 改造双轴评审整改 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉 `b9d3e14...HEAD`（GHA shell 改造，15 commits）双轴代码评审查出的阻塞项、DRY/YAGNI 违规、规格缺口与前端图标回归，让核心包单测在 macOS 与 Windows 双绿。

**Architecture:** 全部是既有代码的局部修补，不引入新抽象、不动 `runner.Runner` 接口。改动集中在四处：`internal/runner`（测试 skip 判断、LF 归一、平台标签下沉、校验入口收敛）、`internal/registry` + `internal/workflow`（错误文案去重 + script 扩展名校验让位 shell 覆盖）、`frontend`（STEP_ICON 补 `run` 键 + 重生成 bindings）、`scripts/spm-download.py`（去掉 `sys.argv` 就地修改）。

**Tech Stack:** Go 1.x（标准库 `testing`，无第三方断言库）、Wails v3.0.0-alpha2.119、React 19 + TypeScript + Vitest + @testing-library/react、Python 3（标准库）。

## Global Constraints

- Wails 锁定 `v3.0.0-alpha2.119`，CLI 与库同版本，**不得升级**。
- 改 `internal/api` 包的类型/签名后必须 `wails3 generate bindings` → `cd frontend && npm run build` → `go build`，否则前端报 "method ID not found"。
- Go 测试只用标准库 `testing` + 表驱动，不引入 testify 等断言库。
- 前端测试用 vitest + @testing-library/react；i18n 已由 `frontend/src/test/setup.ts` 全局初始化，组件测试无需自建 Provider。
- 注释与测试失败文案一律中文（与现有代码库一致）。
- 提交信息格式 `<type>: <description>`，type ∈ feat/fix/refactor/docs/test/chore/perf/ci。**不做任何分支操作、不 push**。
- 改 action / workflow 的 YAML schema 或校验语义后必须同步 `docs/action.md` / `docs/workflow.md`。
- 文件 ≤800 行、函数 ≤50 行、无深嵌套（>4 层）、不可变优先（禁止就地改共享结构）。

---

## 文件结构

| 文件 | 责任 | 本计划的动作 |
|---|---|---|
| `internal/runner/shellspec.go` | 逻辑 shell → argv 模板注册表；扩展名路由 | 删 `IsBuiltinShellName` / `IsValidShellName` 两个薄壳 |
| `internal/runner/shellspec_test.go` | 注册表与路由单测 | 修 pwsh 端到端用例的 skip 判断；`IsValidShellName` 用例改测 `LookupShellSpec` |
| `internal/runner/runscript.go` | 内联 run 落临时脚本（LF 强制 + pwsh 包装） | 行尾归一补孤立 `\r` |
| `internal/runner/runscript_test.go` | 临时脚本写入单测 | 加孤立 `\r` 用例 |
| `internal/runner/posixshell.go`（新建） | Windows bash/sh 探测的**纯逻辑**（可注入、无平台标签） | 从 `shell_lookup_windows.go` 平移 |
| `internal/runner/shell_lookup_windows.go` | Windows `resolveInterpreter` + 常见安装目录数据 | 移出纯逻辑，只留平台相关部分 |
| `internal/runner/shell_lookup_test.go` | bash 探测级联单测 | 去 `//go:build windows`，改分隔符敏感断言 |
| `internal/runner/shell_runner_test.go` | ShellRunner 与 `buildCommandFromCfg` 单测 | 补 script + 显式 shell 覆盖用例 |
| `internal/registry/registry.go` | action YAML 校验 | shell 校验直接复用 `LookupShellSpec`；script 扩展名校验让位显式 shell |
| `internal/workflow/schema.go` | workflow YAML 校验 | step shell 校验直接复用 `LookupShellSpec` |
| `frontend/src/components/WorkflowStepsOverview.tsx` | 配置态管线预览 | 导出 `STEP_ICON`，`shell` 键改 `run` |
| `frontend/src/components/WorkflowStepsOverview.test.tsx`（新建） | 图标表覆盖度回归 | 新建 |
| `scripts/spm-download.py` | SPM 包下载脚本 | 抽纯函数 `resolve_args`，不再 `sys.argv.extend` |
| `scripts/test_spm_download.py`（新建） | `resolve_args` assert 自查 | 新建 |
| `docs/action.md` | 使用者字段参考 | 补「显式 shell 时扩展名推断让位」 |
| `docs/superpowers/specs/2026-08-25-gha-style-shell-runner-design.md` | 规格正本 | pwsh 表格 `-Command` → `-File` 收口 |

## 已评估、本计划不做（附理由）

- **POSIX 侧 `resolveInterpreter` 的 pwsh→powershell / python3→python 回退无单测**：需要为 4 行 `exec.LookPath` 建第二套注入骨架，收益不抵复杂度（YAGNI）。Task 6 已让 Windows 侧探测逻辑在所有平台可测，缺口收窄到「本机 PATH 查找」这一层。
- **`ShellConfig` 的 Run/Script/Shell/BashPath 数据泥团**：抽 `prepareScript()` 是零行为变更的纯重构，当前 `buildCommandFromCfg` 43 行、嵌套 2 层，未越线。等下次真要加第五种形态时再动。
- **`cmd` 模板末元素自带引号 + `exec.Command` 二次转义**：仅 Windows 可验证，本机（darwin）无法给出可信结论；`cmd` 是 7 个内置名里唯一无仓库内使用者的。留作真机验收待办，不盲改。
- **`frontend/src/test/setup.ts` 内存 Storage polyfill**（评审记为范围蔓延）：它修的是 Node 26 下 91 例真实失败，删掉即红。予以接受。
- **`workflows/demo-all-features.yaml` fail-demo 由 PS 改 bash**（评审记为范围蔓延）：默认解释器已改 bash，PS 的 `Write-Error` 在 bash 下无意义，改写是迁移的必然结果。予以接受。

---

### Task 1: 修复 pwsh 端到端用例的 skip 前置判断（唯一阻塞项）

`TestPwshExitCodePropagation` 用 `LookupShellSpec("pwsh")` 判断「本机有没有 pwsh」，但那只是查内置模板表、对 `"pwsh"` 永远返回 nil，所以 skip 分支永不触发：在没装 PowerShell 的 macOS/Linux 上进程根本没起来，`res.ExitCode` 为 0，用例直接 FAIL。同 diff 里的 `requireBash`（`shell_runner_test.go:11`）已经给出正确做法——用 `resolveInterpreter`。

顺带两处硬伤：断言只看 `res.ExitCode` 丢掉 `res.Err`（进程起不来也只报「退出码不对」，误导排查）；用例正文写死 `cmd /c exit 5`，在 macOS 装了 pwsh 的机器上会因 `cmd` 不存在而假失败。

**Files:**
- Modify: `internal/runner/shellspec_test.go:1-9`（imports 加 `runtime`）
- Modify: `internal/runner/shellspec_test.go:67-83`（`TestPwshExitCodePropagation`）

**Interfaces:**
- Consumes: `resolveInterpreter(name, bashOverride string) (string, error)`（`shell_lookup_other.go:13` / `shell_lookup_windows.go:15`）
- Produces: 无（纯测试修复，不改生产代码）

- [ ] **Step 1: 复现失败**

Run: `go test ./internal/runner -run TestPwshExitCodePropagation -v`

Expected: `--- FAIL: TestPwshExitCodePropagation` + `exit = 0, want 5`（在无 pwsh/powershell 的机器上）

- [ ] **Step 2: 改 skip 判断 + 补 `res.Err` 断言 + 原生命令跨平台化**

把 `internal/runner/shellspec_test.go:67-83` 整段替换为：

```go
// TestPwshExitCodePropagation 端到端验证 pwsh WrapTail 的退出码传播
//（原生命令返回 5 应传播为脚本退出码 5；本机无 pwsh/powershell 时跳过）。
func TestPwshExitCodePropagation(t *testing.T) {
	// 必须用 resolveInterpreter 判断解释器是否真实可用：LookupShellSpec 只查内置
	// 模板表，对 "pwsh" 永远返回 nil，拿它做 skip 前置判断等于没判断（与
	// shell_runner_test.go 的 requireBash 同形）。
	if _, err := resolveInterpreter("pwsh", ""); err != nil {
		t.Skipf("本机无 pwsh/powershell: %v", err)
	}
	// 原生（非 cmdlet）命令返回非零码才是 WrapTail 要证明的场景：PowerShell 默认
	// 不把原生命令的退出码当脚本退出码。命令本身按平台取，否则装了 pwsh 的 macOS
	// 会因为找不到 cmd 而假失败。
	native := "cmd /c exit 5"
	if runtime.GOOS != "windows" {
		native = "sh -c 'exit 5'"
	}
	r := &ShellRunner{Cfg: ShellConfig{
		Run:     "Write-Output \"native fail next\"\n" + native,
		Shell:   "pwsh",
		Timeout: 30 * time.Second,
	}}
	res := r.Run(context.Background(), map[string]any{}, func(string, string) {})
	if res.Err != nil {
		t.Fatalf("执行失败（进程未起来，退出码无意义）: %v", res.Err)
	}
	if res.ExitCode != 5 {
		t.Fatalf("exit = %d, want 5（LASTEXITCODE 传播失败；若本机回退 powershell 5，语义应一致）", res.ExitCode)
	}
}
```

再把文件头 imports（`internal/runner/shellspec_test.go:3-9`）替换为：

```go
import (
	"context"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)
```

- [ ] **Step 3: 重跑该用例**

Run: `go test ./internal/runner -run TestPwshExitCodePropagation -v`

Expected: 本机（macOS，无 PowerShell）`--- SKIP: TestPwshExitCodePropagation` + `本机无 pwsh/powershell`；若本机装了 pwsh 则 `--- PASS`。**不允许再出现 FAIL。**

- [ ] **Step 4: 核心包全绿**

Run: `go test ./internal/runner ./internal/registry ./internal/workflow ./internal/actionrun`

Expected: 四行全 `ok`，无 `FAIL`

- [ ] **Step 5: Commit**

```bash
git add internal/runner/shellspec_test.go
git commit -m "fix(test): pwsh 端到端用例 skip 判断改用 resolveInterpreter"
```

---

### Task 2: 临时脚本行尾归一补上孤立 `\r`

规格第 109 行要求内联 run 落盘时「内容**强制 LF 行尾**」，实现只做了 `strings.ReplaceAll(content, "\r\n", "\n")`（`runscript.go:24`），孤立 `\r`（老式 Mac 行尾、手写 YAML 里粘进来的回车）原样落盘，bash 照样报 `$'\r': command not found`——正是这条规则要防的故障。

**Files:**
- Modify: `internal/runner/runscript.go:8-24`
- Test: `internal/runner/runscript_test.go`（新增用例，追加在 `TestWriteRunScript_ForcesLF` 之后，即第 26 行 `}` 之后）

**Interfaces:**
- Consumes: `writeRunScript(spec ShellSpec, content string) (string, func(), error)`（`runscript.go:11`）
- Produces: 包级私有 `lfNormalizer *strings.Replacer`（同包其它文件可用，但本计划无其它使用者）

- [ ] **Step 1: 写失败的测试**

在 `internal/runner/runscript_test.go` 第 26 行 `}` 之后插入：

```go
// TestWriteRunScript_ForcesLF_LoneCR 孤立 \r（老式 Mac 行尾 / 粘贴进 YAML 的回车）
// 也必须归一为 LF——bash 会把 \r 算进命令名，报 $'\r': command not found。
func TestWriteRunScript_ForcesLF_LoneCR(t *testing.T) {
	spec, _ := LookupShellSpec("bash")
	path, cleanup, err := writeRunScript(spec, "echo a\recho b")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "\r") {
		t.Fatalf("孤立 \\r 必须归一为 LF, got %q", data)
	}
	if string(data) != "echo a\necho b\n" {
		t.Fatalf("内容异常: %q", data)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/runner -run TestWriteRunScript_ForcesLF_LoneCR -v`

Expected: FAIL，`孤立 \r 必须归一为 LF, got "echo a\recho b\n"`

- [ ] **Step 3: 最小实现**

把 `internal/runner/runscript.go:8-10` 的注释与第 24 行的替换调用改为：

```go
// lfNormalizer 行尾归一：CRLF 与孤立 CR 一律变 LF（顺序敏感——先 \r\n 再 \r，
// strings.Replacer 按最长匹配优先，单次扫描不会把 \r\n 拆成两个 \n）。
var lfNormalizer = strings.NewReplacer("\r\n", "\n", "\r", "\n")

// writeRunScript 把内联 run 内容写入临时脚本文件，返回路径与清理函数（调用方 defer）。
// 行尾强制 LF——bash 遇 CRLF/CR 报 $'\r': command not found；spec 有 WrapHead/WrapTail 时
// 按 头 + 内容 + 尾 拼接（pwsh 错误语义与退出码传播，见 shellspec.go）。
```

第 24 行 `b.WriteString(strings.ReplaceAll(content, "\r\n", "\n"))` 改为：

```go
	b.WriteString(lfNormalizer.Replace(content))
```

- [ ] **Step 4: 运行测试确认通过**

Run: `go test ./internal/runner -run TestWriteRunScript -v`

Expected: `ForcesLF` / `ForcesLF_LoneCR` / `PwshWrapping` / `CleanupRemovesFile` / `ExtSuffix` 全 PASS

- [ ] **Step 5: Commit**

```bash
git add internal/runner/runscript.go internal/runner/runscript_test.go
git commit -m "fix(runner): 临时脚本行尾归一补齐孤立 CR"
```

---

### Task 3: 收敛 shell 校验入口——去掉三处手抄文案与两个薄壳函数

同一句错误文案在三个文件里各手抄了一遍：`shellspec.go:61`（`LookupShellSpec` 内，唯一该有的地方）、`registry/registry.go:193`、`workflow/schema.go:123`。后两处的写法是先用 `IsValidShellName` 把 `LookupShellSpec` 已经构造好的 error 丢掉，再重拼同一句话——文案漂移只是时间问题。同时 `IsBuiltinShellName`（`shellspec.go:67`）全仓零调用者。

**Files:**
- Modify: `internal/runner/shellspec.go:66-76`（删两个函数）
- Modify: `internal/registry/registry.go:192-194`
- Modify: `internal/workflow/schema.go:122-124`
- Modify: `internal/runner/shellspec_test.go:119-130`（`TestIsValidShellName` 改测 `LookupShellSpec`）

**Interfaces:**
- Consumes: `runner.LookupShellSpec(name string) (ShellSpec, error)`（`shellspec.go:46`）；`runner.KnownShellNames() string`（`shellspec.go:79`，保留——`LookupShellSpec` 的错误文案在用）
- Produces: 删除 `runner.IsBuiltinShellName`、`runner.IsValidShellName`（此后校验一律走 `LookupShellSpec`）

- [ ] **Step 1: 确认调用点，防漏改**

Run: `grep -rn "IsValidShellName\|IsBuiltinShellName" --include=*.go .`

Expected: 恰好 5 处——`internal/runner/shellspec.go:67`、`:73`（定义）、`internal/runner/shellspec_test.go:119`、`:121`、`:126`（用例）、`internal/registry/registry.go:192`、`internal/workflow/schema.go:122`。若出现其它文件，先把它也一并改到 `LookupShellSpec`，再继续。

- [ ] **Step 2: 先把测试改到目标 API（此时应仍然通过）**

`LookupShellSpec` 已存在，所以这一步是「把验收面从薄壳挪到本体」，运行即通过——不是红灯阶段。把 `internal/runner/shellspec_test.go:119-130` 整段替换为：

```go
// TestLookupShellSpec_Acceptance 覆盖 shell 值的接受面：空/内置名/含 {0} 的自定义模板
// 合法；未知工具名与缺占位符的模板报错（原 TestIsValidShellName 的验收面）。
func TestLookupShellSpec_Acceptance(t *testing.T) {
	for _, ok := range []string{"", "bash", "sh", "pwsh", "powershell", "python", "node", "cmd", "perl {0}"} {
		if _, err := LookupShellSpec(ok); err != nil {
			t.Errorf("LookupShellSpec(%q) err = %v, want nil", ok, err)
		}
	}
	for _, bad := range []string{"zsh", "perl", "{1}"} {
		if _, err := LookupShellSpec(bad); err == nil {
			t.Errorf("LookupShellSpec(%q) err = nil, want error", bad)
		}
	}
}
```

Run: `go test ./internal/runner -run TestLookupShellSpec -v`

Expected: `Acceptance` 与其余 `TestLookupShellSpec_*` 全 PASS

- [ ] **Step 3: 两处调用点改用 `LookupShellSpec` 的 error**

`internal/registry/registry.go:192-194`（`if !runner.IsValidShellName(...) { return fmt.Errorf(...) }`）替换为：

```go
		if _, err := runner.LookupShellSpec(def.Command.Shell); err != nil {
			return err
		}
```

`internal/workflow/schema.go:122-124` 替换为：

```go
			if _, err := runner.LookupShellSpec(s.Shell); err != nil {
				return fmt.Errorf("steps[%d]: %w", i, err)
			}
```

- [ ] **Step 4: 删掉两个薄壳函数**

删除 `internal/runner/shellspec.go:66-76` 这一整段（`IsBuiltinShellName` 与 `IsValidShellName` 及其注释），`KnownShellNames`（第 78 行起）保留不动。

- [ ] **Step 5: 编译 + 三包回归**

Run: `go build ./... && go test ./internal/runner ./internal/registry ./internal/workflow`

Expected: 编译无错；三行 `ok`。注意 `registry_test.go:514` 断言错误含 `command.shell 非法`——`LookupShellSpec` 的文案本就是 `command.shell 非法 %q：...`，断言继续成立；`workflow/loader_test.go:197` 只断言 `err != nil`，也继续成立。

- [ ] **Step 6: Commit**

```bash
git add internal/runner/shellspec.go internal/runner/shellspec_test.go internal/registry/registry.go internal/workflow/schema.go
git commit -m "refactor(runner): shell 校验统一走 LookupShellSpec，删除两个薄壳函数"
```

---

### Task 4: script 扩展名校验让位显式 `shell`

规格第 53 行写明「`shell:` 字段可显式覆盖扩展名推断」，第 112 行重申 script 形态「spec 默认按扩展名推断、`shell:` 字段可覆盖」。runner 侧确实照做了（`shell_runner.go:128-134`：`cfg.Shell` 非空就不查扩展名），但加载期校验（`registry.go:197-201`）无条件调 `ShellNameByScript`——于是 `script: ./x.pl` + `shell: "perl {0}"` 在加载阶段就被拒，校验比引擎更严，堵死了规格明确允许的组合。

**Files:**
- Modify: `internal/registry/registry.go:196-201`
- Modify: `docs/action.md:198`、`docs/action.md:448`（使用者文档同步）
- Test: `internal/registry/registry_test.go:535-545`（扩展 `TestValidate_ScriptExtension`）

**Interfaces:**
- Consumes: `runner.ShellNameByScript(script string) (string, error)`（`shellspec.go:92`）；`registry.Validate(def *ActionDef) error`（`registry.go:160`）
- Produces: 无新增导出符号（仅放宽既有校验分支）

- [ ] **Step 1: 写失败的测试**

把 `internal/registry/registry_test.go:535-545` 的 `TestValidate_ScriptExtension` 整段替换为：

```go
// TestValidate_ScriptExtension 校验 script 扩展名受支持；显式写 shell 时扩展名推断让位
//（design 第 53 行「shell: 字段可显式覆盖扩展名推断」，runner 侧本就支持）。
func TestValidate_ScriptExtension(t *testing.T) {
	ok := &ActionDef{ID: "a", Title: "A", Command: Command{Script: "./s/hello.py"}}
	if err := Validate(ok); err != nil {
		t.Fatalf(".py 应合法: %v", err)
	}
	bad := &ActionDef{ID: "a", Title: "A", Command: Command{Script: "./s/hello.rb"}}
	if err := Validate(bad); err == nil {
		t.Fatal(".rb 扩展名应报错")
	}
	override := &ActionDef{ID: "a", Title: "A", Command: Command{Script: "./s/hello.pl", Shell: "perl {0}"}}
	if err := Validate(override); err != nil {
		t.Fatalf("script + 显式 shell 应合法（校验不该比引擎更严）: %v", err)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/registry -run TestValidate_ScriptExtension -v`

Expected: FAIL，`script + 显式 shell 应合法（校验不该比引擎更严）: script 扩展名不受支持 "./s/hello.pl"（支持 .sh/.ps1/.py/.js）`

- [ ] **Step 3: 最小实现**

把 `internal/registry/registry.go:196-201` 替换为：

```go
	// script 必须带受支持的扩展名（.sh/.ps1/.py/.js）；显式写了 shell 时由它决定
	// 解释器，扩展名推断让位——与 runner.buildCommandFromCfg 同语义，校验不得更严。
	if def.Command.Script != "" && def.Command.Shell == "" {
		if _, err := runner.ShellNameByScript(def.Command.Script); err != nil {
			return err
		}
	}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `go test ./internal/registry`

Expected: `ok  	workflow-tool/internal/registry`

- [ ] **Step 5: 同步使用者文档**

`docs/action.md:198` 那句「`script` 字段指向脚本文件路径（**必须带扩展名**），按扩展名路由解释器：」后面的四项列表末尾，追加一行：

```markdown
- 显式写了 `command.shell` 时以它为准，扩展名推断让位（如 `script: ./x.pl` + `shell: "perl {0}"`）
```

`docs/action.md:448` 那行校验清单：

```markdown
- `script` 必须带受支持的扩展名（`.sh` / `.ps1` / `.py` / `.js`）
```

替换为：

```markdown
- `script` 必须带受支持的扩展名（`.sh` / `.ps1` / `.py` / `.js`）；显式写了 `command.shell` 时不校验扩展名
```

- [ ] **Step 6: Commit**

```bash
git add internal/registry/registry.go internal/registry/registry_test.go docs/action.md
git commit -m "fix(registry): script 扩展名校验让位显式 shell 覆盖"
```

---

### Task 5: 补 script + 显式 shell 覆盖的 runner 单测

规格第 178 行的测试策略列了「script 路由：`.sh`/`.py`/`.js`/`.ps1` 各选对 spec、未知扩展名报错、**`shell:` 覆盖推断**」。前两项有用例（`shellspec_test.go:132` 的 `TestShellNameByScript`），第三项——也就是 `buildCommandFromCfg` 里 script + 显式 shell 的分支（`shell_runner.go:128-134`）——零用例。Task 4 刚放宽了加载期校验，正好把这条链路的下游锁住。

**注意：这是补覆盖，不是修 bug。行为本来就正确，所以新用例第一次运行就应该 PASS，没有红灯阶段。** 它的价值是防回归：以后谁把 `shell_runner.go:128` 的 `if name == ""` 去掉，这条用例立刻红。

**Files:**
- Modify: `internal/runner/shell_runner_test.go:3-8`（imports 加 `os` / `path/filepath` / `reflect`）
- Test: `internal/runner/shell_runner_test.go`（新增用例，追加在 `TestBuildCommand_WindowsDefaultBash` 之后）

**Interfaces:**
- Consumes: `buildCommandFromCfg(cfg ShellConfig) (*exec.Cmd, func(), error)`（`shell_runner.go:107`）；`ShellConfig{Script, Shell string}`（`shell_runner.go:15`）
- Produces: 无

- [ ] **Step 1: 把 imports 补齐**

把 `internal/runner/shell_runner_test.go:3-8` 的 import 块替换为：

```go
import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)
```

- [ ] **Step 2: 写用例**

在 `internal/runner/shell_runner_test.go` 的 `TestBuildCommand_WindowsDefaultBash` 函数结束之后插入：

```go
// TestBuildCommand_ScriptShellOverride script 形态显式 shell 覆盖扩展名推断
//（design 第 53/112/178 行）。刻意用自定义模板 + 不受支持的 .pl 扩展名：
// 扩展名推断若没让位就会报「script 扩展名不受支持」；resolveInterpreter 对非内置
// 名原样返回，所以本机没装 perl 也能断言 argv。
func TestBuildCommand_ScriptShellOverride(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "hello.pl")
	if err := os.WriteFile(script, []byte("print 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd, cleanup, err := buildCommandFromCfg(ShellConfig{Script: script, Shell: "perl -w {0}"})
	if err != nil {
		t.Fatalf("script + 显式 shell 应可构造: %v", err)
	}
	defer cleanup()
	want := []string{"perl", "-w", script}
	if !reflect.DeepEqual(cmd.Args, want) {
		t.Fatalf("argv = %v, want %v", cmd.Args, want)
	}
}

// TestBuildCommand_ScriptUnknownExtWithoutShell 反向锁住：不写 shell 时未知扩展名必须报错
//（让位只在显式 shell 时发生，不是把校验整体拆了）。
func TestBuildCommand_ScriptUnknownExtWithoutShell(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "hello.pl")
	if err := os.WriteFile(script, []byte("print 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := buildCommandFromCfg(ShellConfig{Script: script}); err == nil {
		t.Fatal("未写 shell 且扩展名不受支持，应报错")
	}
}
```

- [ ] **Step 3: 运行用例**

Run: `go test ./internal/runner -run "TestBuildCommand_Script" -v`

Expected: 两条都 `--- PASS`（如 Step 说明，本任务无红灯阶段）

- [ ] **Step 4: runner 包全绿**

Run: `go test ./internal/runner`

Expected: `ok  	workflow-tool/internal/runner`

- [ ] **Step 5: Commit**

```bash
git add internal/runner/shell_runner_test.go
git commit -m "test(runner): 补 script + 显式 shell 覆盖扩展名推断用例"
```

---

### Task 6: bash 探测单测跨平台化——把纯逻辑从 `//go:build windows` 里捞出来

规格第 177 行要求 bash 探测「探测函数接受候选注入，**单测不依赖真实机器状态**」。注入骨架写了（`posixShellLookup`），但唯一的测试文件带 `//go:build windows`（`shell_lookup_test.go:1`），于是 BASH_PATH 优先 / WSL 排除 / 级联顺序 / 报错指引这四条在 macOS·Linux 上一条都不执行——注入式设计白做。

根因不在测试文件，而在被测逻辑：`lookupPosixShell` / `isWSLBash` / `posixShellLookup` 全是纯字符串与路径判断（外部依赖已经注入掉了），却和平台相关的 `resolveInterpreter` 挤在同一个带 tag 的文件里。把纯逻辑移到无 tag 的新文件，测试自然可以在所有平台跑。

**Files:**
- Create: `internal/runner/posixshell.go`
- Modify: `internal/runner/shell_lookup_windows.go:1-10`（imports 收缩）、删除 `:42-74`（平移出去的三项）
- Modify: `internal/runner/shell_lookup_test.go:1-2`（删 build tag）、`:55-57`（分隔符敏感断言）

**Interfaces:**
- Consumes: 无（纯平移）
- Produces: `posixShellLookup{lookPath func(string) (string, error); validate func(string) error; dirs []string}`、`lookupPosixShell(name, override string, lk posixShellLookup) (string, error)`、`isWSLBash(p string) bool` —— 三者迁到无 build tag 的 `posixshell.go`，全平台可见；`commonPosixDirs() []string` 留在 Windows 文件（它是 Windows 特有数据，非逻辑）。

- [ ] **Step 1: 先证明这些用例当前跑不到**

Run: `go test ./internal/runner -run TestLookupPosixShell -v`

Expected: `testing: warning: no tests to run` + `ok`（三条用例被 build tag 挡在门外——这就是要修的现象）

- [ ] **Step 2: 新建 `internal/runner/posixshell.go`**

```go
package runner

import (
	"fmt"
	"path/filepath"
	"strings"
)

// posixShellLookup 收拢 bash/sh 探测的外部依赖（PATH 查找、可执行校验、候选目录），
// 便于单测注入。级联逻辑本身与平台无关——纯字符串与路径判断——所以这里不带
// build tag：带了的话注入式设计在 macOS/Linux 上一条用例都跑不到，等于白做
//（design 第 177 行要求「探测函数接受候选注入，单测不依赖真实机器状态」）。
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
```

- [ ] **Step 3: 从 `shell_lookup_windows.go` 删掉平移出去的部分**

删除该文件第 42-74 行（`posixShellLookup` 类型、`lookupPosixShell`、`isWSLBash` 及各自注释）。`commonPosixDirs`（原第 76-85 行）**保留**。

然后把文件头 imports（第 5-10 行）收缩为——`filepath` / `strings` 已随平移离开：

```go
import (
	"fmt"
	"os/exec"
)
```

- [ ] **Step 4: 解开测试文件的平台锁**

删除 `internal/runner/shell_lookup_test.go` 第 1-2 行（`//go:build windows` 与其后的空行）。

再把 `:55-57` 的断言替换为——`filepath.Join` 在非 Windows 上用 `/` 拼接，写死 `Git\bin\bash.exe` 会在 macOS 假失败：

```go
	if !strings.Contains(got, "Git") || !strings.Contains(got, "bash.exe") {
		t.Fatalf("应回退到常见 Git 安装目录, got %q", got)
	}
```

- [ ] **Step 5: 确认用例现在真的在跑**

Run: `go test ./internal/runner -run "TestLookupPosixShell|TestResolveInterpreter" -v`

Expected: 四条全 `--- PASS`：`TestLookupPosixShell_OverrideWins`、`TestLookupPosixShell_WSLBashExcluded`、`TestLookupPosixShell_NotFound`、`TestResolveInterpreter_PwshFallsBackToPowerShell`（`resolveInterpreter("powershell","")` 在两个平台都走「原样返回」分支）

- [ ] **Step 6: 确认 Windows 侧仍然编译**

Run: `GOOS=windows go vet ./internal/runner`

Expected: 无输出（`go vet` 连测试文件一起类型检查，能抓到平移后 Windows 分支的漏改与多余 import）

- [ ] **Step 7: 全包回归 + 竞态**

Run: `go test -race ./internal/runner`

Expected: `ok  	workflow-tool/internal/runner`

- [ ] **Step 8: Commit**

```bash
git add internal/runner/posixshell.go internal/runner/shell_lookup_windows.go internal/runner/shell_lookup_test.go
git commit -m "test(runner): bash 探测纯逻辑移出 windows build tag，单测全平台可跑"
```

---

### Task 7: 前端 STEP_ICON 补 `run` 键 + 重生成 bindings

`WorkflowStepInfo.Kind` 从 `"shell"` 改成了 `"run"`（`internal/api/workflows.go:79`），但前端 `STEP_ICON` 表还是 `shell` 键（`WorkflowStepsOverview.tsx:13`），于是内联步命中第 50 行的 `?? FlashIcon` 兜底，图标退化成 action 的闪电——用户看到的是「两种步骤长得一样」。

顺带一处 CLAUDE.md 违规：`frontend/bindings/.../models.js:382` 的 JSDoc 仍写 `"action" | "sleep" | "shell"`，说明 Kind 改名后 bindings 没重新生成。只是注释，但规矩是改 api 包就得重跑生成器。

保留 `?? FlashIcon` 兜底（防御性，不是坏味道），改由测试来锁「表必须覆盖后端全部取值」。

**Files:**
- Modify: `frontend/src/components/WorkflowStepsOverview.tsx:10-14`
- Create: `frontend/src/components/WorkflowStepsOverview.test.tsx`
- Regenerate: `frontend/bindings/**`（`wails3 generate bindings` 产物，不手改）

**Interfaces:**
- Consumes: `WorkflowStepInfo{kind, label, name: string}`（`frontend/bindings/workflow-tool/internal/api/models.js:374`）；`CommandIcon` / `Clock01Icon` / `FlashIcon`（`@hugeicons/core-free-icons`）
- Produces: `export const STEP_ICON` —— 键为后端 `WorkflowStepInfo.Kind` 的取值（`action` / `sleep` / `run`），值为 hugeicons 图标对象

- [ ] **Step 1: 写失败的测试**

新建 `frontend/src/components/WorkflowStepsOverview.test.tsx`：

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CommandIcon, FlashIcon } from "@hugeicons/core-free-icons";
import type { WorkflowStepInfo } from "../../bindings/workflow-tool/internal/api/models.js";
import { STEP_ICON, WorkflowStepsOverview } from "./WorkflowStepsOverview";

// 后端 WorkflowStepInfo.Kind 的全部取值（internal/api/workflows.go:18）。
// 少一个键就落到 ?? FlashIcon 兜底、退化成 action 的闪电图标——
// 正是 shell→run 改名踩到的回归。
const BACKEND_KINDS = ["action", "sleep", "run"] as const;

describe("WorkflowStepsOverview", () => {
  it("图标表覆盖后端全部 step kind", () => {
    for (const kind of BACKEND_KINDS) {
      expect(STEP_ICON[kind], `kind=${kind} 缺图标`).toBeDefined();
    }
  });

  it("run 步用命令图标而不是 action 的闪电图标", () => {
    expect(STEP_ICON.run).toBe(CommandIcon);
    expect(STEP_ICON.run).not.toBe(FlashIcon);
  });

  it("渲染 run 步的 label 与 kind 文案", () => {
    const steps: WorkflowStepInfo[] = [{ kind: "run", label: "echo hi", name: "" }];
    render(<WorkflowStepsOverview steps={steps} />);
    expect(screen.getByText("echo hi")).toBeInTheDocument();
    expect(screen.getByText("run")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd frontend && npx vitest run src/components/WorkflowStepsOverview.test.tsx`

Expected: FAIL —— `STEP_ICON` 尚未导出，报 `does not provide an export named 'STEP_ICON'`（或 `STEP_ICON is undefined`）

- [ ] **Step 3: 最小实现**

把 `frontend/src/components/WorkflowStepsOverview.tsx:10-14` 替换为：

```tsx
// 键必须与后端 WorkflowStepInfo.Kind 的取值一一对应（internal/api/workflows.go:18）：
// 缺键会落到下方 ?? FlashIcon 兜底，内联步图标退化成 action 的闪电。
export const STEP_ICON = {
  action: FlashIcon,
  sleep: Clock01Icon,
  run: CommandIcon,
} as const;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd frontend && npx vitest run src/components/WorkflowStepsOverview.test.tsx`

Expected: 3 passed

- [ ] **Step 5: 重生成 bindings 并按 CLAUDE.md 的顺序重建**

```bash
wails3 generate bindings
cd frontend && npm run build && cd ..
go build -o workflow-tool .
```

Expected: 三步都成功；`git diff --stat frontend/bindings` 显示 `models.js` 的 Kind/Label JSDoc 从 `"shell"` 更新为 `"run"`。若生成器改动了大量无关文件，先 `git diff` 看清再决定是否只留 models.js 的变化。

- [ ] **Step 6: 前端全量校验**

Run: `cd frontend && npm test && npm run lint && npm run typecheck`

Expected: vitest 全绿（含新增 3 例）、lint 无错、typecheck 无错

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/WorkflowStepsOverview.tsx frontend/src/components/WorkflowStepsOverview.test.tsx frontend/bindings
git commit -m "fix(frontend): STEP_ICON 补 run 键并重生成 bindings"
```

---

### Task 8: `spm-download.py` 去掉 `sys.argv` 就地修改

`sys.argv.extend(args)`（`scripts/spm-download.py:44`）就地改全局状态，违反 coding-style.md 标为 CRITICAL 的不可变原则；顺带让「参数从哪来」这件事变得要读两遍才明白。抽一个纯函数 `resolve_args(argv, env)`，返回新列表，谁都不改。

**Files:**
- Modify: `scripts/spm-download.py:11-15`（imports 加 `Mapping`）、`:35-47`（`main` 头部）
- Create: `scripts/test_spm_download.py`

**Interfaces:**
- Consumes: `sys.argv`、`os.environ`
- Produces: `resolve_args(argv: list[str], env: Mapping[str, str]) -> list[str]` —— 返回 `[zip_name, inner_path]` 或 `[zip_name, inner_path, out_dir]`，不修改任何入参；参数不足时 `sys.exit(__doc__)`

- [ ] **Step 1: 写失败的自查脚本**

新建 `scripts/test_spm_download.py`：

```python
#!/usr/bin/env python3
"""spm-download 参数解析自查：python3 scripts/test_spm_download.py（全绿则打印 ok）。

文件名带连字符不能直接 import，所以按路径加载模块。
"""
import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location(
    "spm_download", pathlib.Path(__file__).with_name("spm-download.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# 命令行传参：原样取 argv[1:]，且不得改动入参
argv = ["spm-download.py", "a.zip", "/inner/x.gz"]
assert mod.resolve_args(argv, {}) == ["a.zip", "/inner/x.gz"]
assert argv == ["spm-download.py", "a.zip", "/inner/x.gz"], "resolve_args 不得修改入参"

# script 形态直挂：无参数时从 env 读
assert mod.resolve_args(["spm-download.py"], {"ZIP_NAME": "a.zip", "INNER_PATH": "/i"}) == [
    "a.zip",
    "/i",
]
assert mod.resolve_args(
    ["spm-download.py"], {"ZIP_NAME": "a.zip", "INNER_PATH": "/i", "OUT_DIR": "/tmp"}
) == ["a.zip", "/i", "/tmp"]

# 带输出目录的命令行传参
assert mod.resolve_args(["spm-download.py", "a.zip", "/i", "/tmp"], {}) == ["a.zip", "/i", "/tmp"]

print("ok")
```

- [ ] **Step 2: 运行确认失败**

Run: `python3 scripts/test_spm_download.py`

Expected: `AttributeError: module 'spm_download' has no attribute 'resolve_args'`

- [ ] **Step 3: 最小实现**

`scripts/spm-download.py:11-15` 的 import 块之后（第 15 行 `import urllib.error` 下面）插入：

```python
from collections.abc import Mapping
```

把 `scripts/spm-download.py:35-47`（`def main() -> None:` 到 `out_dir = sys.argv[3] if len(sys.argv) == 4 else os.getcwd()` 这一整段）替换为：

```python
def resolve_args(argv: list[str], env: Mapping[str, str]) -> list[str]:
    """解析实参，返回 [zip名, zip内路径] 或 [zip名, zip内路径, 输出目录]；不修改入参。

    script 形态直挂时无薄壳传参，参数从环境变量读（action params 会注入子进程 env）。
    """
    if len(argv) in (3, 4):
        return list(argv[1:])
    if len(argv) == 1 and env.get("ZIP_NAME") and env.get("INNER_PATH"):
        args = [env["ZIP_NAME"], env["INNER_PATH"]]
        out_dir = env.get("OUT_DIR", "")
        if out_dir:
            args.append(out_dir)
        return args
    sys.exit(__doc__)


def main() -> None:
    args = resolve_args(sys.argv, os.environ)
    zip_name, inner = args[0], args[1].lstrip("/")
    out_dir = args[2] if len(args) == 3 else os.getcwd()
```

- [ ] **Step 4: 运行确认通过**

Run: `python3 scripts/test_spm_download.py`

Expected: `ok`

- [ ] **Step 5: 确认无参数时仍打印用法（`sys.exit(__doc__)` 未被绕过）**

Run: `python3 scripts/spm-download.py; echo "exit=$?"`

Expected: 打印 docstring 用法说明，`exit=1`

- [ ] **Step 6: Commit**

```bash
git add scripts/spm-download.py scripts/test_spm_download.py
git commit -m "refactor(scripts): spm-download 参数解析抽纯函数，不再就地改 sys.argv"
```

---

### Task 9: 规格正本 pwsh 表格 `-Command` → `-File` 收口

`01d7fe9` 已经把实现从 `-Command` 改成 `-File`（`-Command <path>` 会吞掉脚本里 `exit $LASTEXITCODE` 的退出码，恒为 1），验收记录也写了，但规格正本第 82-83 行的表格还写着 `-Command {0}`。后人照表格「修回去」就立刻复现退出码不传播——这是留在文档里的陷阱。

**Files:**
- Modify: `docs/superpowers/specs/2026-08-25-gha-style-shell-runner-design.md:82-83`

**Interfaces:**
- Consumes: `builtinShellSpecs`（`internal/runner/shellspec.go:37-38`，实现的事实来源）
- Produces: 无（纯文档）

- [ ] **Step 1: 确认实现的事实**

Run: `grep -n '"pwsh"\|"powershell"' internal/runner/shellspec.go`

Expected: 两行都含 `-NoProfile", "-File"`（若不是，先停下——说明实现又变了，以实现为准再改文档）

- [ ] **Step 2: 改表格两行**

把 `docs/superpowers/specs/2026-08-25-gha-style-shell-runner-design.md:82` 的 `` `pwsh -NoProfile -Command {0}` `` 改为 `` `pwsh -NoProfile -File {0}` ``，并在第 83 行（`powershell` 那行）之后追加一行说明：

```markdown

> **`-File` 而非 `-Command`（01d7fe9 修正）**：`-Command <脚本路径>` 会吞掉脚本内 `exit $LASTEXITCODE` 的退出码（恒为 1），WrapTail 的退出码传播只在 `-File` 下成立。改回 `-Command` 即复现该回归，`internal/runner/shellspec_test.go` 的 `TestLookupShellSpec_PwshWrapping` 会拦住。
```

- [ ] **Step 3: 确认文档里不再有 `-Command`**

Run: `grep -rn '\-Command' docs/ | grep -v '不再\|而非\|改回'`

Expected: 无输出（除上一步新增的解释性引用外，全仓文档不再把 `-Command` 写成正确用法）

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-25-gha-style-shell-runner-design.md
git commit -m "docs(spec): pwsh 模板表格 -Command 收口为 -File"
```

---

## 收尾验证（全部任务完成后执行一次）

- [ ] **Go 侧全绿（含竞态）**

Run: `go test -race ./internal/runner ./internal/registry ./internal/workflow ./internal/actionrun`

Expected: 四行 `ok`，无 FAIL、无 DATA RACE

- [ ] **Windows 交叉编译不破**

Run: `GOOS=windows go vet ./...`

Expected: 无输出

- [ ] **前端全绿**

Run: `cd frontend && npm test && npm run lint && npm run typecheck`

Expected: vitest 全绿、lint 与 typecheck 无错

- [ ] **一键全量构建**

Run: `bash deploy/build.sh`

Expected: 前端产物 → bindings → 单二进制三段依次成功

- [ ] **真机待办（不在本计划内，记录备查）**

`cmd` 内置模板末元素自带引号（`internal/runner/shellspec.go:41`）却经 `exec.Command` 传递，Windows 上是否被二次转义无从在 macOS 验证。下次 Windows 真机验收时跑一个 `shell: cmd` 的临时 action 确认；若确有问题，改法是走 `cmd.SysProcAttr.CmdLine` 绕过 Go 的参数转义。

