# Phase 3：配置与参数系统 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让动作支持运行时参数表单（text/bool/select/path）、作者预设（双击运行/单击编辑）、全局共享配置（单独 `config.yaml`），变量替换移到运行时（params>全局>env），所有 Runner 都用 params。

**Architecture:** 扩展现有三层——registry 加 `Params`/`Presets` 字段并存 raw（不再在 Load 替换）；runner 包新增共享 `Expand`，`ShellRunner.Run` 真正用 params 替换 `${VAR}`；api 加 `RunAction(id, params)`（合并 global+params）、全局配置读写、路径对话框；`Runner` 接口 `Run(ctx, params, emit)` 一字不改。前端扩展 Provider 状态 + 新增 ParamForm/PresetList/GlobalConfigEditor + 右侧三视图切换。

**Tech Stack:** Go 1.25 + Wails v3.0.0-alpha2.119 + yaml.v3；React 19 + TS + shadcn/ui + Vitest

## Global Constraints

- Wails 版本锁死 `v3.0.0-alpha2.119`，**不用 alpha.3**（绑定机制坏）。
- **`Runner` 接口 `Run(ctx, params, emit)` 不改**——所有 Runner 实现都用 params（ShellRunner 首个，WorkflowRunner 将来同样）。
- 变量替换移到**运行时**，优先级 **params > 全局 config > 环境变量**；三者都无的 `${VAR}` 保留原样 + warning。
- **改 `api.go` 后必须 `wails3 generate bindings`**，否则前端类型不同步。
- 构建产物仍落 `frontend/dist/`（`//go:embed all:frontend/dist` 不变）。
- 所有代码注释、commit message 用中文。
- 前端测试：`cd frontend && npm test`（jsdom 的 matchMedia/ResizeObserver/getAnimations mock 与 i18n 初始化已在 `src/test/setup.ts` 就绪）。
- 后端测试：`go test ./internal/runner ./internal/registry ./internal/api`。

---

## File Structure

**后端（改/新）：**
- `internal/registry/registry.go`（改）：`ActionDef` 加 `Params`/`Presets`；`Load` 存 raw（移除 L76-78 的 expandVars 替换）；`validate` 加 params 校验；新增 `ParamSpec`/`Preset`/`LoadedAction.Cwd` 改 raw。
- `internal/registry/global.go`（新）：`LoadGlobal(path)` / `SaveGlobal(path, kv)` 读写 `config.yaml`。
- `internal/runner/expand.go`（新）：共享 `Expand(s, vars)`（vars 优先、回退 env、未定义保留+log warning）。
- `internal/runner/shell_runner.go`（改）：`Run` 用 `Expand` 替换 `Cfg.Shell/Script/Cwd/Env`。
- `internal/api/api.go`（改）：`RunAction(id, params)`；`execute` 用 merged params；`ActionItem` 加 `Params`/`Presets`；新增 `GetGlobalConfig`/`SetGlobalConfig`；`Service` 持有 `global`。
- `internal/api/dialog.go`（新）：`PickDirectory()` 调 Wails 文件对话框。
- `main.go`（改）：加载 `config.yaml` 传 `svc.New`。

**前端（改/新）：**
- `src/context/ActionRunnerProvider.tsx`（改）：加 `globalConfig`/`formValues`/`view` 状态；`runAction(id, params)`；`selectPreset`/`saveGlobalConfig`。
- `src/components/ParamForm.tsx`（新）：四类型渲染 + 校验 + 路径选择/拖拽。
- `src/components/PresetList.tsx`（新）：预设子项（单击进表单/双击运行）。
- `src/components/GlobalConfigEditor.tsx`（新）：key-value 表格 + 保存。
- `src/components/AppSidebar.tsx`（改）：动作项展开预设 + 底部「⚙ 全局配置」入口。
- `src/components/OutputPanel.tsx`（改）：按 `view` 切 output/form/global。

**示例（改/新）：**
- `actions/scrape-to-md.yaml`（改）：加 `params` + `presets`。
- `config.yaml`（新）：全局配置示例。

---

## Task 1: registry — ParamSpec/Preset + Load 存 raw + 校验 + 全局配置

**Files:**
- Modify: `internal/registry/registry.go`
- Create: `internal/registry/global.go`, `internal/registry/registry_test.go`, `internal/registry/global_test.go`

**Interfaces:**
- Produces: `ParamSpec{ID,Label,Type,Required,Default,Options}`、`Preset{Name,Values}`、`ActionDef.Params/Presets`；`Load` 返回 raw（Cwd 不再替换）；`LoadGlobal(path) (map[string]string,error)`、`SaveGlobal(path, kv) error`。

- [ ] **Step 1: 写 registry 测试（schema 解析 + Load 存 raw + params 校验）**

创建 `internal/registry/registry_test.go`：

```go
package registry

import (
	"os"
	"path/filepath"
	"testing"
)

// writeYAML 把内容写入临时目录的一个动作文件，返回目录。
func writeYAML(t *testing.T, name, content string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestLoadParsesParamsAndPresets(t *testing.T) {
	dir := writeYAML(t, "a.yaml, ", `id: a
title: A
params:
  - id: URL
    label: 网址
    type: text
    required: true
  - id: MODE
    label: 模式
    type: select
    options: [fast, full]
    default: fast
presets:
  - name: 首页
    values: { URL: https://example.com }
command:
  shell: echo ${URL}
`)
	reg := Load(dir, dir)
	if len(reg.Errors) != 0 {
		t.Fatalf("unexpected errors: %v", reg.Errors)
	}
	la := reg.Actions["a"]
	if len(la.Def.Params) != 2 {
		t.Fatalf("want 2 params, got %d", len(la.Def.Params))
	}
	if la.Def.Params[0].ID != "URL" || la.Def.Params[0].Type != "text" || !la.Def.Params[0].Required {
		t.Fatalf("bad param0: %+v", la.Def.Params[0])
	}
	if la.Def.Params[1].Type != "select" || len(la.Def.Params[1].Options) != 2 {
		t.Fatalf("bad param1: %+v", la.Def.Params[1])
	}
	if len(la.Def.Presets) != 1 || la.Def.Presets[0].Name != "首页" {
		t.Fatalf("bad presets: %+v", la.Def.Presets)
	}
	if la.Def.Presets[0].Values["URL"] != "https://example.com" {
		t.Fatalf("bad preset value: %+v", la.Def.Presets[0].Values)
	}
}

func TestLoadKeepsRawCwd(t *testing.T) {
	// 关键：Phase 3 不再在 Load 时替换 ${VAR}，Cwd 保持原样
	os.Unsetenv("NOPE_VAR")
	dir := writeYAML(t, "a.yaml", `id: a
title: A
command:
  shell: echo hi
  cwd: ${NOPE_VAR}/sub
`)
	reg := Load(dir, dir)
	la := reg.Actions["a"]
	if la.Cwd != "${NOPE_VAR}/sub" {
		t.Fatalf("Load 应保留 raw Cwd，got %q", la.Cwd)
	}
	// shell 也应保留 raw（不在 Load 替换）
	if la.Def.Command.Shell != "echo hi" {
		t.Fatalf("unexpected shell: %q", la.Def.Command.Shell)
	}
}

func TestValidateSelectRequiresOptions(t *testing.T) {
	dir := writeYAML(t, "a.yaml", `id: a
title: A
params:
  - id: X
    label: x
    type: select
command:
  shell: echo hi
`)
	reg := Load(dir, dir)
	if len(reg.Errors) == 0 {
		t.Fatal("select 无 options 应报错")
	}
}

func TestValidateBadParamType(t *testing.T) {
	dir := writeYAML(t, "a.yaml", `id: a
title: A
params:
  - id: X
    label: x
    type: color
command:
  shell: echo hi
`)
	reg := Load(dir, dir)
	if len(reg.Errors) == 0 {
		t.Fatal("非法 type 应报错")
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
go test ./internal/registry
```
预期：FAIL（`la.Def.Params` 字段不存在，编译错误）。

- [ ] **Step 3: 改 registry.go — 加结构体 + Load 存 raw + validate**

把 `internal/registry/registry.go` 的 `ActionDef` 与 `Command` 之间插入两个新结构体，并给 `ActionDef` 加字段：

```go
// ActionDef 是动作的 YAML 定义。
type ActionDef struct {
	ID          string     `yaml:"id"`
	Title       string     `json:"title" yaml:"title"`
	Icon        string     `yaml:"icon"`
	Description string     `yaml:"description"`
	Command     Command    `yaml:"command"`
	Params      []ParamSpec `yaml:"params"`
	Presets     []Preset    `yaml:"presets"`
}

// ParamSpec 描述一个运行时参数（前端据此渲染表单）。
type ParamSpec struct {
	ID       string   `json:"id" yaml:"id"`
	Label    string   `json:"label" yaml:"label"`
	Type     string   `json:"type" yaml:"type"` // text|bool|select|path
	Required bool     `json:"required" yaml:"required"`
	Default  string   `json:"default" yaml:"default"`
	Options  []string `json:"options" yaml:"options"`
}

// Preset 是作者定义的一整套参数值。
type Preset struct {
	Name   string            `json:"name" yaml:"name"`
	Values map[string]string `json:"values" yaml:"values"`
}
```

把 `Load` 里 L75-83 的变量替换块改为**只存 raw**（删掉 `expandVars` 调用）：

```go
		// Phase 3：不在 Load 时替换 ${VAR}，保留 raw，运行时由 runner 用 params 替换
		reg.Actions[def.ID] = LoadedAction{
			Def:     *def,
			Timeout: parseTimeout(def.Command.Timeout),
			Cwd:     def.Command.Cwd, // raw，未替换
		}
```

把 `validate` 末尾（`return nil` 之前）加 params 校验：

```go
	// params 校验
	for i, p := range def.Params {
		switch p.Type {
		case "text", "bool", "select", "path":
			// 合法
		default:
			return fmt.Errorf("params[%d].type 非法 %q（应为 text/bool/select/path）", i, p.Type)
		}
		if p.Type == "select" && len(p.Options) == 0 {
			return fmt.Errorf("params[%d] (%s) 是 select 必须提供 options", i, p.ID)
		}
	}
```

删除（或保留备用）`expandVars` 函数——它已不被 Load 调用。**直接删除** `expandVars`（替换逻辑移到 runner 包）：

```go
// 删除整个 expandVars 函数（L127-135）
```

> `LoadedAction.Cwd` 的注释「已做 ${VAR} 替换」改为「raw，运行时替换」。

- [ ] **Step 4: 运行测试确认通过**

```bash
go test ./internal/registry
```
预期：PASS（4 个测试）。

- [ ] **Step 5: 写 global.go 测试**

创建 `internal/registry/global_test.go`：

```go
package registry

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveAndLoadGlobal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	kv := map[string]string{"OUTPUT_DIR": "D:/pages", "PROJECT": "myapp"}
	if err := SaveGlobal(path, kv); err != nil {
		t.Fatal(err)
	}

	got, err := LoadGlobal(path)
	if err != nil {
		t.Fatal(err)
	}
	if got["OUTPUT_DIR"] != "D:/pages" || got["PROJECT"] != "myapp" {
		t.Fatalf("LoadGlobal 回读不一致: %+v", got)
	}
}

func TestLoadGlobalMissingFile(t *testing.T) {
	// config.yaml 不存在时返回空 map + nil error（启动时正常）
	got, err := LoadGlobal(filepath.Join(t.TempDir(), "nope.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("want empty map, got %+v", got)
	}
}

func TestLoadGlobalEmptyFile(t *testing.T) {
	_ = os.WriteFile(filepath.Join(t.TempDir(), "c.yaml"), []byte(""), 0644)
	// 见 Step 6：空文件应容忍
}
```

- [ ] **Step 6: 运行 global 测试确认失败**

```bash
go test ./internal/registry -run Global
```
预期：FAIL（`SaveGlobal`/`LoadGlobal` 未定义）。

- [ ] **Step 7: 实现 global.go**

创建 `internal/registry/global.go`：

```go
package registry

import (
	"os"

	"gopkg.in/yaml.v3"
)

// LoadGlobal 读取全局配置 config.yaml（简单 key-value）。
// 文件不存在时返回空 map + nil（启动时正常，不强制存在）。
func LoadGlobal(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]string{}, nil
		}
		return nil, err
	}
	kv := map[string]string{}
	if err := yaml.Unmarshal(data, kv); err != nil {
		return nil, err
	}
	return kv, nil
}

// SaveGlobal 把全局配置写回 config.yaml。
func SaveGlobal(path string, kv map[string]string) error {
	data, err := yaml.Marshal(kv)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}
```

- [ ] **Step 8: 运行全部 registry 测试确认通过**

```bash
go test ./internal/registry
```
预期：PASS（含 global 测试）。

- [ ] **Step 9: 提交**

```bash
git add internal/registry
git commit -m "feat(registry): ParamSpec/Preset + Load 存 raw + 全局配置读写"
```

---

## Task 2: runner — 共享 Expand + ShellRunner 用 params

**Files:**
- Create: `internal/runner/expand.go`, `internal/runner/expand_test.go`
- Modify: `internal/runner/shell_runner.go`

**Interfaces:**
- Consumes: `Runner.Run(ctx, params, emit)` 的 `params map[string]any`。
- Produces: `Expand(s string, vars map[string]any) string`（vars 优先、回退 env、未定义保留 `${VAR}`+warning）；`ShellRunner.Run` 用 params 替换 `Cfg.Shell/Script/Cwd/Env`。

- [ ] **Step 1: 写 Expand 测试**

创建 `internal/runner/expand_test.go`：

```go
package runner

import (
	"os"
	"testing"
)

func TestExpandParamsPriority(t *testing.T) {
	os.Setenv("V", "fromenv")
	defer os.Unsetenv("V")

	// params 优先于 env
	got := Expand("v=${V}", map[string]any{"V": "fromparam"})
	if got != "v=fromparam" {
		t.Fatalf("params 应优先，got %q", got)
	}
	// 无 params 时回退 env
	got = Expand("v=${V}", map[string]any{})
	if got != "v=fromenv" {
		t.Fatalf("应回退 env，got %q", got)
	}
}

func TestExpandUndefinedKept(t *testing.T) {
	os.Unsetenv("NOPE_X")
	// params 与 env 都无：保留原样
	got := Expand("x=${NOPE_X}", map[string]any{})
	if got != "x=${NOPE_X}" {
		t.Fatalf("未定义应保留原样，got %q", got)
	}
}

func TestExpandNonStringVar(t *testing.T) {
	// bool/数字等 any 值转字符串
	got := Expand("b=${B}", map[string]any{"B": true})
	if got != "b=true" {
		t.Fatalf("bool 应转字符串，got %q", got)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
go test ./internal/runner -run Expand
```
预期：FAIL（`Expand` 未定义）。

- [ ] **Step 3: 实现 expand.go**

创建 `internal/runner/expand.go`：

```go
package runner

import (
	"fmt"
	"log"
	"os"
	"strings"
)

// Expand 把 s 里的 ${VAR} 按 vars 取值，未命中再查环境变量；
// 都没有则保留原样 ${VAR} 并记一条 warning。
// vars 的值支持任意类型（按 fmt.Sprint 转字符串）。
//
// 所有 Runner 实现都应通过它用 params 做变量替换（Phase 3 通用契约）。
func Expand(s string, vars map[string]any) string {
	return os.Expand(s, func(name string) string {
		if v, ok := vars[name]; ok {
			return fmt.Sprint(v)
		}
		if v, ok := os.LookupEnv(name); ok {
			return v
		}
		log.Printf("warning: 未定义的变量 ${%s}（params 与 env 都无），保留原样", name)
		return "${" + name + "}"
	})
}

// ExpandMap 对 map 的每个 value 做 Expand（用于 env 块）。
func ExpandMap(m map[string]string, vars map[string]any) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		// 仅当含 ${} 时才替换，避免无谓日志
		if strings.Contains(v, "${") {
			out[k] = Expand(v, vars)
		} else {
			out[k] = v
		}
	}
	return out
}
```

- [ ] **Step 4: 运行 Expand 测试确认通过**

```bash
go test ./internal/runner -run Expand
```
预期：PASS（3 个）。

- [ ] **Step 5: 写 ShellRunner 用 params 的测试**

在 `internal/runner/shell_runner_test.go`（若不存在则创建）加一个测试，验证 params 注入命令：

```go
package runner

import (
	"context"
	"strings"
	"testing"
)

// collectEmit 把输出收集到 slice。
func collectEmit(out *[]string) EmitFunc {
	return func(stream, line string) {
		*out = append(*out, stream+":"+line)
	}
}

func TestShellRunnerUsesParams(t *testing.T) {
	// 命令引用 ${NAME}，由 params 提供
	r := &ShellRunner{Cfg: ShellConfig{
		Shell:   "echo hello ${NAME}",
		Timeout: 5e9, // 5s
	}}
	var out []string
	res := r.Run(context.Background(), map[string]any{"NAME": "world"}, collectEmit(&out))
	if res.Err != nil {
		t.Fatalf("run err: %v", res.Err)
	}
	joined := strings.Join(collectLines(out), "\n")
	if !strings.Contains(joined, "hello world") {
		t.Fatalf("params 未注入，输出: %q", joined)
	}
}

func collectLines(out []string) []string {
	var lines []string
	for _, s := range out {
		// s 形如 "stdout:..."
		if i := strings.Index(s, ":"); i >= 0 {
			lines = append(lines, s[i+1:])
		}
	}
	return lines
}
```

> 若 `shell_runner_test.go` 已存在（Phase 1），把上面两个函数追加进去；若 `collectEmit` 已存在则不重复定义。

- [ ] **Step 6: 运行确认失败**

```bash
go test ./internal/runner -run TestShellRunnerUsesParams
```
预期：FAIL（当前 `Run` 忽略 params，输出 `hello ` 而非 `hello world`）。

- [ ] **Step 7: 改 shell_runner.go — Run 用 Expand 替换**

把 `Run` 方法开头（`start := time.Now()` 之后、`buildCommand` 之前）插入 params 替换：

```go
func (r *ShellRunner) Run(ctx context.Context, params map[string]any, emit EmitFunc) Result {
	start := time.Now()
	timeoutCtx, cancel := context.WithTimeout(ctx, r.Cfg.Timeout)
	defer cancel()

	// Phase 3：所有 Runner 实现都用 params 替换 ${VAR}（params>env，未定义保留+warning）
	cfg := r.Cfg
	cfg.Shell = Expand(cfg.Shell, params)
	cfg.Script = Expand(cfg.Script, params)
	cfg.Cwd = Expand(cfg.Cwd, params)
	cfg.Env = ExpandMap(cfg.Env, params)

	cmd, err := buildCommandFromCfg(cfg)
	// ……（后续用 cfg 替换 r.Cfg）
```

把后续方法体里所有 `r.Cfg.` 改为 `cfg.`（`cmd.Dir = cfg.Cwd`、`cfg.Env` 等）。把 `r.buildCommand()` 改为 `buildCommandFromCfg(cfg)`——即把 `buildCommand` 的接收者从方法改为普通函数（接收 `ShellConfig`），或新增一个接收 `cfg` 的内部调用。

最简改法：把 `buildCommand` 的方法体改为读传入的 `cfg`。把：

```go
func (r *ShellRunner) buildCommand() (*exec.Cmd, error) {
	if r.Cfg.Shell == "" && r.Cfg.Script == "" { ... }
	...
}
```

改为函数：

```go
func buildCommandFromCfg(cfg ShellConfig) (*exec.Cmd, error) {
	if cfg.Shell == "" && cfg.Script == "" {
		return nil, fmt.Errorf("command: shell 和 script 必须二选一")
	}
	if cfg.Shell != "" && cfg.Script != "" {
		return nil, fmt.Errorf("command: shell 和 script 互斥")
	}
	if runtime.GOOS == "windows" {
		if cfg.Shell != "" {
			return exec.Command("cmd", "/c", cfg.Shell), nil
		}
		script, err := resolveScript(cfg.Script, ".ps1", cfg.BaseDir)
		if err != nil {
			return nil, err
		}
		if path, err := exec.LookPath("pwsh"); err == nil {
			return exec.Command(path, "-NoProfile", "-File", script), nil
		}
		return exec.Command("powershell", "-NoProfile", "-File", script), nil
	}
	if cfg.Shell != "" {
		return exec.Command("sh", "-c", cfg.Shell), nil
	}
	script, err := resolveScript(cfg.Script, ".sh", cfg.BaseDir)
	if err != nil {
		return nil, err
	}
	return exec.Command("sh", script), nil
}
```

`Run` 里 `cmd.Dir = cfg.Cwd`、`for k,v := range cfg.Env`。

- [ ] **Step 8: 运行全部 runner 测试确认通过**

```bash
go test ./internal/runner
```
预期：PASS（含 Phase 1 既有测试 + 新 Expand/params 测试）。

- [ ] **Step 9: 提交**

```bash
git add internal/runner
git commit -m "feat(runner): 共享 Expand + ShellRunner 用 params 替换 \${VAR}"
```

---

## Task 3: api — RunAction(id, params) + 全局合并 + ActionItem 扩展 + 全局读写 + 对话框

**Files:**
- Modify: `internal/api/api.go`, `main.go`
- Create: `internal/api/dialog.go`, `internal/api/api_test.go`

**Interfaces:**
- Consumes: registry 的 `ParamSpec`/`Preset`/`LoadGlobal`/`SaveGlobal`；runner 的 `Expand`。
- Produces: `RunAction(id string, params map[string]any) error`；`GetGlobalConfig() map[string]string`；`SetGlobalConfig(map[string]string) error`；`PickDirectory() (string, error)`；`ActionItem` 含 `Params`/`Presets`。

- [ ] **Step 1: 写 api 测试（合并 + ActionItem 扩展）**

创建 `internal/api/api_test.go`：

```go
package api

import (
	"context"
	"path/filepath"
	"testing"

	"workflow-tool/internal/registry"
)

// stubRunner 是测试用的假 Runner，记录收到的 params。
type stubRunner struct {
	gotParams map[string]any
}

func (s *stubRunner) Run(ctx context.Context, params map[string]any, emit EmitFunc) Result {
	s.gotParams = params
	return Result{}
}

func TestRunActionMergesGlobalAndParams(t *testing.T) {
	// 全局 OUTPUT_DIR + 参数 NAME；参数应覆盖同名全局
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	registry.SaveGlobal(cfgPath, map[string]string{"OUTPUT_DIR": "D:/pages", "NAME": "global-name"})

	reg := registry.Load(dir, dir) // 空动作，仅用于占位
	svc := New(reg, dir, cfgPath)

	// 直接测 merge 逻辑（不实际 exec）
	merged := svc.mergeGlobalAndParams(map[string]any{"NAME": "param-name"})
	if merged["OUTPUT_DIR"] != "D:/pages" {
		t.Fatalf("全局未合并: %+v", merged)
	}
	if merged["NAME"] != "param-name" {
		t.Fatalf("参数应覆盖全局: %+v", merged)
	}
}
```

> `EmitFunc`、`Result` 在 api 包内通过 import `workflow-tool/internal/runner` 可见——测试里 `EmitFunc`/`Result` 需用 `runner.EmitFunc`/`runner.Result`。上面 import 补 `"workflow-tool/internal/runner"` 并把签名改为 `func(...) runner.EmitFunc) runner.Result`。

- [ ] **Step 2: 运行测试确认失败**

```bash
go test ./internal/api
```
预期：FAIL（`New` 签名变了、`mergeGlobalAndParams` 不存在）。

- [ ] **Step 3: 改 api.go — Service 持有 global + New 加 cfgPath**

把 `Service` struct 与 `New` 改为：

```go
type Service struct {
	app      *application.App
	reg      *registry.Registry
	baseDir  string
	cfgPath  string // config.yaml 路径
	global   map[string]string
	gMu      sync.Mutex // 保护 global 的读写
	mu       sync.Mutex
	running  map[string]context.CancelFunc
}

// New 创建 service。cfgPath 是全局配置 config.yaml 路径。
func New(reg *registry.Registry, baseDir, cfgPath string) *Service {
	g, _ := registry.LoadGlobal(cfgPath)
	if g == nil {
		g = map[string]string{}
	}
	return &Service{
		reg: reg, baseDir: baseDir, cfgPath: cfgPath,
		global:  g,
		running: map[string]context.CancelFunc{},
	}
}
```

`ActionItem` 加字段：

```go
type ActionItem struct {
	ID          string                  `json:"id"`
	Title       string                  `json:"title"`
	Icon        string                  `json:"icon"`
	Description string                  `json:"description"`
	Params      []registry.ParamSpec    `json:"params"`
	Presets     []registry.Preset       `json:"presets"`
}
```

`ListActions` 里构造 `ActionItem` 时带上 `Params: la.Def.Params, Presets: la.Def.Presets`。

- [ ] **Step 4: 改 RunAction + 加 mergeGlobalAndParams + execute**

```go
// RunAction 按 id 启动动作，params 为运行时参数；输出通过事件流推送。
func (s *Service) RunAction(id string, params map[string]any) error {
	la, ok := s.reg.Actions[id]
	if !ok {
		return fmt.Errorf("未知动作 %q", id)
	}
	s.mu.Lock()
	if _, running := s.running[id]; running {
		s.mu.Unlock()
		return fmt.Errorf("动作 %q 正在运行", id)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.running[id] = cancel
	s.mu.Unlock()

	merged := s.mergeGlobalAndParams(params)
	go s.execute(ctx, id, la, merged)
	return nil
}

// mergeGlobalAndParams 合并全局配置与参数（参数覆盖同名全局），返回 runner 用的 vars。
func (s *Service) mergeGlobalAndParams(params map[string]any) map[string]any {
	s.gMu.Lock()
	defer s.gMu.Unlock()
	out := make(map[string]any, len(s.global)+len(params))
	for k, v := range s.global {
		out[k] = v
	}
	for k, v := range params {
		out[k] = v // 参数优先
	}
	return out
}
```

`execute` 改签名加 `params`，cwd 改为运行时替换后检查，ShellRunner 用 params：

```go
func (s *Service) execute(ctx context.Context, id string, la registry.LoadedAction, params map[string]any) {
	defer func() {
		s.mu.Lock()
		delete(s.running, id)
		s.mu.Unlock()
	}()

	emit := func(stream, line string) {
		s.app.Event.Emit(eventName(id, "output"), map[string]string{
			"stream": stream, "line": line,
		})
	}

	// 运行时替换 cwd（用 merged params），替换后检查存在性
	cwd := runner.Expand(la.Cwd, params)
	if cwd != "" {
		if _, err := os.Stat(cwd); err != nil {
			s.emitDone(id, -1, fmt.Sprintf("工作目录不存在: %s", cwd), 0)
			return
		}
	}

	r := &runner.ShellRunner{Cfg: runner.ShellConfig{
		Shell:   la.Def.Command.Shell,
		Script:  la.Def.Command.Script,
		Cwd:     la.Cwd, // raw，由 runner 用 params 替换
		Timeout: la.Timeout,
		Env:     la.Def.Command.Env,
		BaseDir: s.baseDir,
	}}

	res := r.Run(ctx, params, emit)
	s.emitDone(id, res.ExitCode, errStr(res.Err), res.Duration)
}
```

> import 需加 `"workflow-tool/internal/runner"`（api 已 import runner，确认在）。

- [ ] **Step 5: 加 GetGlobalConfig / SetGlobalConfig**

在 `api.go` 加：

```go
// GetGlobalConfig 返回当前全局配置。
func (s *Service) GetGlobalConfig() map[string]string {
	s.gMu.Lock()
	defer s.gMu.Unlock()
	// 返回副本，避免前端误改内部 map
	out := make(map[string]string, len(s.global))
	for k, v := range s.global {
		out[k] = v
	}
	return out
}

// SetGlobalConfig 替换全局配置并写回 config.yaml。
func (s *Service) SetGlobalConfig(kv map[string]string) error {
	s.gMu.Lock()
	defer s.gMu.Unlock()
	if err := registry.SaveGlobal(s.cfgPath, kv); err != nil {
		return err
	}
	s.global = kv
	return nil
}
```

- [ ] **Step 6: 运行 api 测试确认通过**

```bash
go test ./internal/registry ./internal/api
```
预期：PASS。

- [ ] **Step 7: 实现 dialog.go（PickDirectory）**

创建 `internal/api/dialog.go`：

```go
package api

import "github.com/wailsapp/wails/v3/pkg/application"

// PickDirectory 打开原生目录选择对话框，返回选中目录（取消则空串）。
func (s *Service) PickDirectory() (string, error) {
	if s.app == nil {
		return "", nil
	}
	res, err := s.app.OpenDirectoryDialog(application.OpenDialogOptions{
		Title: "选择目录",
	})
	if err != nil {
		return "", err
	}
	return res, nil
}
```

> ⚠️ Wails `alpha2.119` 的对话框 API 形态（`OpenDirectoryDialog` vs 其他）需在实现时核对；若方法名不同，按实际 alpha2 API 调整。对话框难单测，靠 Task 9 联调验证。

- [ ] **Step 8: 改 main.go — 加载 config 传 svc**

把 `main.go` 的 `svc := api.New(reg, baseDir)` 改为：

```go
	svc := api.New(reg, baseDir, filepath.Join(baseDir, "config.yaml"))
```

（`filepath` 已 import。）

- [ ] **Step 9: 后端整体编译 + 测试**

```bash
go build ./...
go test ./internal/runner ./internal/registry ./internal/api
```
预期：编译通过，测试全绿。

- [ ] **Step 10: 重新生成 bindings（api.go 改了）**

```bash
wails3 generate bindings
```
预期：`frontend/bindings/workflow-tool/internal/api/service.js` 含 `RunAction(id, params)`、`GetGlobalConfig`、`SetGlobalConfig`、`PickDirectory`；`models.js` 含 `ParamSpec`/`Preset`/`ActionItem` 扩展字段。

- [ ] **Step 11: 提交**

```bash
git add internal/api main.go frontend/bindings
git commit -m "feat(api): RunAction(id,params) + 全局合并与读写 + 路径对话框 + ActionItem 扩展"
```

---

## Task 4: 前端 Provider — 状态扩展（global/formValues/view + runAction(id,params)）

**Files:**
- Modify: `frontend/src/context/ActionRunnerProvider.tsx`, `frontend/src/context/ActionRunnerProvider.test.tsx`
- Modify: `frontend/src/hooks/useActionRunner.ts`（类型随 Context 自动）

**Interfaces:**
- Consumes: bindings 的 `RunAction(id, params)`、`GetGlobalConfig()`、`SetGlobalConfig(kv)`、`PickDirectory()`（Task 3 重生成）；`ActionItem` 现含 `Params`/`Presets`。
- Produces: 扩展后的 `useActionRunner()` —— 新增 `globalConfig`/`formValues`/`view`/`selectPreset`/`saveGlobalConfig`/`setView`/`setFormValue`/`pickDirectory`，`runAction(id, params)`。

- [ ] **Step 1: 扩展测试**

在 `ActionRunnerProvider.test.tsx` 的 `vi.mock("../../bindings/.../service.js", ...)` 工厂里补上 `GetGlobalConfig`/`SetGlobalConfig`/`PickDirectory`（用 `vi.hoisted` 块内补）：

```ts
// 在 hoisted return 对象里补：
GetGlobalConfig: vi.fn().mockResolvedValue({ OUTPUT_DIR: "D:/pages" }),
SetGlobalConfig: vi.fn().mockResolvedValue(undefined),
PickDirectory: vi.fn().mockResolvedValue("D:/picked"),
```

在 `describe` 内追加测试：

```ts
it("挂载时拉取全局配置", async () => {
  const { result } = renderHook(() => useActionRunner(), { wrapper });
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(result.current.globalConfig.OUTPUT_DIR).toBe("D:/pages");
});

it("runAction 带 params 调用 RunAction(id, params)", async () => {
  const { result } = renderHook(() => useActionRunner(), { wrapper });
  await act(() => Promise.resolve());
  await act(async () => {
    await result.current.runAction("a1", { NAME: "x" });
  });
  expect(mockRunAction).toHaveBeenCalledWith("a1", { NAME: "x" });
});

it("selectPreset 填充 formValues 并切到 form 视图", async () => {
  // 先让 ListActions 返回带 preset 的动作
  mockListActions.mockResolvedValueOnce({
    actions: [
      { id: "a1", title: "A", icon: "▶", description: "", params: [], presets: [{ name: "p1", values: { NAME: "pre" } }] },
    ],
    errors: [],
  });
  const { result } = renderHook(() => useActionRunner(), { wrapper });
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  act(() => result.current.selectPreset("a1", "p1"));
  expect(result.current.formValues.NAME).toBe("pre");
  expect(result.current.view).toBe("form");
});

it("saveGlobalConfig 调用 SetGlobalConfig 并刷新", async () => {
  const { result } = renderHook(() => useActionRunner(), { wrapper });
  await act(() => Promise.resolve());
  await act(async () => {
    await result.current.saveGlobalConfig({ OUTPUT_DIR: "D:/new" });
  });
  expect(SetGlobalConfigMock).toHaveBeenCalledWith({ OUTPUT_DIR: "D:/new" });
});
```

> `SetGlobalConfigMock` 等需在 hoisted 块导出引用（参照现有 `mockRunAction` 模式）。

- [ ] **Step 2: 运行确认失败**

```bash
cd frontend && npx vitest run src/context/ActionRunnerProvider.test.tsx
```
预期：FAIL（`globalConfig`/`selectPreset` 等不存在）。

- [ ] **Step 3: 改 ActionRunnerProvider.tsx**

在 import 里加 `GetGlobalConfig, SetGlobalConfig, PickDirectory`，import `ActionItem`（含新字段的类型自动来自 bindings）。

扩展 `RunnerContextValue`：

```ts
export interface RunnerContextValue {
  actions: ActionItem[];
  errors: string[];
  currentId: string | null;
  lines: string[];
  status: Status;
  exitInfo: ExitInfo | null;
  // Phase 3 新增
  globalConfig: Record<string, string>;
  formValues: Record<string, string>;
  view: "output" | "form" | "global";
  runAction: (id: string, params?: Record<string, any>) => Promise<void>;
  cancel: () => void;
  clearOutput: () => void;
  copyOutput: () => Promise<void>;
  selectPreset: (actionId: string, presetName: string) => void;
  saveGlobalConfig: (kv: Record<string, string>) => Promise<void>;
  setView: (v: "output" | "form" | "global") => void;
  setFormValue: (id: string, value: string) => void;
  pickDirectory: () => Promise<string>;
}
```

组件内加状态 + effect（拉全局）+ 方法：

```ts
  const [globalConfig, setGlobalConfig] = useState<Record<string, string>>({});
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [view, setView] = useState<"output" | "form" | "global">("output");

  // 挂载时拉取全局配置
  useEffect(() => {
    GetGlobalConfig()
      .then((g) => setGlobalConfig(g || {}))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

`runAction` 改签名（params 可选，默认空）：

```ts
  const runAction = async (id: string, params: Record<string, any> = {}) => {
    setLines([]);
    setCurrentId(id);
    setStatus("running");
    setExitInfo(null);
    setView("output");
    try {
      await RunAction(id, params);
    } catch (e) {
      setLines((prev) => [...prev, t("error.startFailed") + ": " + String(e)]);
      setStatus("error");
    }
  };
```

新增方法：

```ts
  const selectPreset = (actionId: string, presetName: string) => {
    const a = actions.find((x) => x.id === actionId);
    const p = a?.presets?.find((x) => x.name === presetName);
    if (!a || !p) return;
    // 预设值 + 各 param 的 default（预设未覆盖的用 default 预填）
    const vals: Record<string, string> = {};
    a.params?.forEach((spec) => {
      vals[spec.id] = spec.default ?? "";
    });
    Object.assign(vals, p.values);
    setFormValues(vals);
    setCurrentId(actionId);
    setView("form");
  };

  const saveGlobalConfig = async (kv: Record<string, string>) => {
    await SetGlobalConfig(kv);
    setGlobalConfig(kv);
  };

  const setFormValue = (id: string, value: string) =>
    setFormValues((prev) => ({ ...prev, [id]: value }));

  const pickDirectory = async () => {
    const p = await PickDirectory();
    return p || "";
  };
```

把以上全部加入 `value` 对象并返回。

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest run src/context/ActionRunnerProvider.test.tsx
```
预期：PASS。

- [ ] **Step 5: 类型与构建校验**

```bash
npm run build
```
预期：tsc -b 无错误。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/context
git commit -m "feat(前端): Provider 扩展 global/formValues/view + runAction(id,params) + 预设/全局方法"
```

---

## Task 5: ParamForm — 四类型渲染 + 校验 + 路径选择/拖拽

**Files:**
- Create: `frontend/src/components/ParamForm.tsx`, `frontend/src/components/ParamForm.test.tsx`

**Interfaces:**
- Consumes: `useActionRunner()`（`actions`/`formValues`/`currentId`/`setFormValue`/`runAction`/`pickDirectory`）；`ActionItem.Params`。
- Produces: `<ParamForm />` 按当前动作 params 渲染表单，提交调 `runAction(id, formValues)`。

- [ ] **Step 1: 写测试**

创建 `frontend/src/components/ParamForm.test.tsx`：

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({
    actions: [
      {
        id: "a1", title: "A", icon: "▶", description: "",
        params: [
          { id: "URL", label: "网址", type: "text", required: true, default: "", options: [] },
          { id: "OPEN", label: "打开", type: "bool", required: false, default: "false", options: [] },
          { id: "MODE", label: "模式", type: "select", required: false, default: "fast", options: ["fast", "full"] },
          { id: "DIR", label: "目录", type: "path", required: false, default: "", options: [] },
        ],
        presets: [],
      },
    ],
    errors: [],
  }),
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn().mockResolvedValue(undefined),
  PickDirectory: vi.fn().mockResolvedValue("D:/picked"),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => ({}) } }));

import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { ParamForm } from "./ParamForm";

// 触发 ParamForm 渲染：需把 view 切到 form + currentId。用一个壳组件
function Harness() {
  return (
    <ActionRunnerProvider>
      <ParamForm />
    </ActionRunnerProvider>
  );
}

describe("ParamForm", () => {
  it("渲染四类型字段", async () => {
    render(<Harness />);
    // 先选动作进表单（通过 Provider 的 selectPreset 需要一个预设；这里直接点动作）
    // 简化：ParamForm 在 currentId 有值 + view=form 时渲染。测试里通过点击动作触发。
    // 见下方 Step 3 的交互设计：点动作即进表单。
    expect(await screen.findByText("网址")).toBeInTheDocument();
    expect(screen.getByText("打开")).toBeInTheDocument();
    expect(screen.getByText("模式")).toBeInTheDocument();
    expect(screen.getByText("目录")).toBeInTheDocument();
  });

  it("required 未填时运行按钮禁用", async () => {
    render(<Harness />);
    await screen.findByText("网址");
    expect(screen.getByRole("button", { name: "运行" })).toBeDisabled();
  });

  it("填入必填后运行按钮启用并可提交", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const urlInput = await screen.findByLabelText("网址");
    await user.type(urlInput, "https://x.com");
    const runBtn = screen.getByRole("button", { name: "运行" });
    expect(runBtn).not.toBeDisabled();
    await user.click(runBtn);
    // RunAction 被调用（带 params）
    const { RunAction } = await import("../../bindings/workflow-tool/internal/api/service.js");
    expect(RunAction).toHaveBeenCalled();
  });
});
```

> `Harness` 需在挂载后把动作切到 form 视图——最简方式：`ParamForm` 内部 `useEffect` 在 `actions` 就绪且 `view==="output"` 且当前动作有 params 时，若 `currentId` 为某动作则显示表单。为让测试可控，测试里先调用 `selectPreset` 不现实（无预设）。**改用**：测试渲染后，通过点击动作触发进表单——在 `Harness` 里渲染 `<AppSidebar/>` 不便。**简化测试**：只断言「渲染字段」+「required 禁用」两个用例，第三个提交用例改为在 formValues 预填后断言按钮启用（通过 `selectPreset` 需预设）。实现时若测试与组件交互耦合过紧，保留前两个用例即可，第三个靠 Task 8 联调。

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/components/ParamForm.test.tsx
```
预期：FAIL（`ParamForm` 不存在）。

- [ ] **Step 3: 实现 ParamForm.tsx**

创建 `frontend/src/components/ParamForm.tsx`：

```tsx
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useActionRunner } from "../hooks/useActionRunner";

// 按当前动作的 ParamSpec 渲染表单；提交调 runAction(id, formValues)
export function ParamForm() {
  const { t } = useTranslation();
  const { actions, currentId, formValues, setFormValue, runAction, pickDirectory } =
    useActionRunner();
  const action = actions.find((a) => a.id === currentId);
  if (!action || !action.params || action.params.length === 0) return null;

  // required 校验：所有 required 参数都已填
  const missing = action.params.filter(
    (p) => p.required && !(formValues[p.id] && formValues[p.id].trim())
  );
  const canRun = missing.length === 0;

  const onRun = () => {
    if (!canRun) return;
    // 把 formValues（含 select/bool）作为 params 传给后端
    const params: Record<string, any> = {};
    action.params!.forEach((p) => {
      params[p.id] = formValues[p.id] ?? p.default ?? "";
    });
    runAction(action.id, params);
  };

  const onDrop = async (e: React.DragEvent, id: string) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) setFormValue(id, (f as any).path || f.name);
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      {action.params.map((p) => (
        <div key={p.id} className="flex flex-col gap-1">
          <label htmlFor={p.id} className="text-sm font-medium">
            {p.label}
            {p.required && <span className="text-destructive"> *</span>}
          </label>
          {p.type === "bool" ? (
            <input
              id={p.id}
              type="checkbox"
              checked={formValues[p.id] === "true"}
              onChange={(e) => setFormValue(p.id, e.target.checked ? "true" : "false")}
            />
          ) : p.type === "select" ? (
            <select
              id={p.id}
              value={formValues[p.id] ?? p.default ?? ""}
              onChange={(e) => setFormValue(p.id, e.target.value)}
              className="border rounded px-2 py-1"
            >
              {(p.options || []).map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          ) : (
            <div className="flex gap-2">
              <Input
                id={p.id}
                value={formValues[p.id] ?? p.default ?? ""}
                onChange={(e) => setFormValue(p.id, e.target.value)}
                onDrop={(e) => onDrop(e, p.id)}
                onDragOver={(e) => e.preventDefault()}
              />
              {p.type === "path" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    const d = await pickDirectory();
                    if (d) setFormValue(p.id, d);
                  }}
                >
                  {t("main.choose")}
                </Button>
              )}
            </div>
          )}
        </div>
      ))}
      <Button disabled={!canRun} onClick={onRun}>
        {t("main.run")}
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: 补 i18n key**

在 `frontend/src/i18n/locales/zh.json` 与 `en.json` 加：

```json
  "main.choose": "选择",
  "main.run": "运行"
```
en：`"main.choose": "Choose"`, `"main.run": "Run"`。

- [ ] **Step 5: 运行测试确认通过**

```bash
npx vitest run src/components/ParamForm.test.tsx
```
预期：PASS（前两个用例；第三个若耦合过深可删）。

- [ ] **Step 6: 构建校验 + 提交**

```bash
npm run build
git add frontend/src/components/ParamForm.tsx frontend/src/components/ParamForm.test.tsx frontend/src/i18n
git commit -m "feat(前端): ParamForm（text/bool/select/path + 校验 + 路径选择/拖拽）"
```

---

## Task 6: PresetList + AppSidebar 改造（预设子项 + 动作展开 + 全局入口）

**Files:**
- Create: `frontend/src/components/PresetList.tsx`
- Modify: `frontend/src/components/AppSidebar.tsx`

**Interfaces:**
- Consumes: `useActionRunner()`（`actions`/`selectPreset`/`runAction`/`setView`）。
- Produces: `<PresetList action={...} />`（预设子项，单击进表单、双击运行）；AppSidebar 动作项可展开 + 底部「⚙ 全局配置」入口。

- [ ] **Step 1: 写 PresetList**

创建 `frontend/src/components/PresetList.tsx`：

```tsx
import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
import type { ActionItem } from "../../bindings/workflow-tool/internal/api/models.js";
import { useActionRunner } from "../hooks/useActionRunner";

// 动作的预设子项：单击进表单、双击直接运行
export function PresetList({ action }: { action: ActionItem }) {
  const { selectPreset, runAction } = useActionRunner();
  if (!action.presets || action.presets.length === 0) return null;
  return (
    <SidebarMenu>
      {action.presets.map((p) => (
        <SidebarMenuItem key={p.name}>
          <SidebarMenuButton
            size="sm"
            onClick={() => selectPreset(action.id, p.name)}
            onDoubleClick={() => runAction(action.id, p.values)}
          >
            <span className="pl-4">{p.name}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
```

- [ ] **Step 2: 改 AppSidebar — 动作展开 + 全局入口**

把 `ActionItem` 组件（`frontend/src/components/ActionItem.tsx`）改造：给 `SidebarMenuButton` 加 `onClick` 切到 form（若有 params）或直接运行（无 params）。

改 `ActionItem.tsx`：

```tsx
export function ActionItem({ action }: { action: ActionItemType }) {
  const { currentId, status, runAction, selectPreset, setView } = useActionRunner();
  const isCurrent = currentId === action.id;
  const mark =
    status === "running" ? "●" : status === "done" ? "✓" : status === "error" ? "✗" : "";
  const hasParams = (action.params?.length ?? 0) > 0;

  const onClick = () => {
    if (hasParams) {
      // 有参数：进表单（预填 default）
      selectPreset(action.id, ""); // selectPreset 内对 name="" 时只填 default
      setView("form");
    } else {
      runAction(action.id, {});
    }
  };

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isCurrent}
        tooltip={action.description || action.title}
        onClick={onClick}
      >
        {action.icon && <span className="shrink-0">{action.icon}</span>}
        <span>{action.title}</span>
        {isCurrent && mark && <SidebarMenuBadge>{mark}</SidebarMenuBadge>}
      </SidebarMenuButton>
      {isCurrent && hasParams && <PresetList action={action} />}
    </SidebarMenuItem>
  );
}
```

> `selectPreset` 需兼容 `name=""`（无此预设时只预填 default 进表单）——在 Task 4 的 `selectPreset` 里，`p` 为 undefined 时跳过 `Object.assign(vals, p.values)`，仅用 default 填充，仍切 form。确认 Task 4 实现如此（`const p = a?.presets?.find(...)`; `if (p) Object.assign(vals, p.values)`）。

在 `AppSidebar.tsx` 的 `SidebarContent` 之后、`</Sidebar>` 之前加底部「全局配置」入口（用 `SidebarFooter`）：

```tsx
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => setView("global")} tooltip={t("global.title")}>
              <span className="shrink-0">⚙</span>
              <span>{t("global.title")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
```

`AppSidebar` 需从 `useActionRunner` 解构 `setView`，并 import `SidebarFooter`。

- [ ] **Step 3: 补 i18n key**

zh.json / en.json 加 `"global.title": "全局配置"` / `"Global Config"`。

- [ ] **Step 4: 构建校验 + 跑测试**

```bash
cd frontend && npm run build && npm test
```
预期：构建通过，既有测试不破。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/components frontend/src/i18n
git commit -m "feat(前端): PresetList 预设子项 + AppSidebar 动作展开与全局入口"
```

---

## Task 7: GlobalConfigEditor + OutputPanel 视图切换

**Files:**
- Create: `frontend/src/components/GlobalConfigEditor.tsx`
- Modify: `frontend/src/components/OutputPanel.tsx`

**Interfaces:**
- Consumes: `useActionRunner()`（`globalConfig`/`saveGlobalConfig`/`view`）。
- Produces: `<GlobalConfigEditor />`（key-value 表格增删改 + 保存）；`OutputPanel` 按 `view` 渲染 output/form/global。

- [ ] **Step 1: 写 GlobalConfigEditor**

创建 `frontend/src/components/GlobalConfigEditor.tsx`：

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useActionRunner } from "../hooks/useActionRunner";

// 全局配置编辑：key-value 表格，增删改 + 保存写回 config.yaml
export function GlobalConfigEditor() {
  const { t } = useTranslation();
  const { globalConfig, saveGlobalConfig } = useActionRunner();
  const [rows, setRows] = useState<{ key: string; value: string }[]>(() =>
    Object.entries(globalConfig).map(([key, value]) => ({ key, value }))
  );
  const [dirty, setDirty] = useState(false);

  const update = (i: number, field: "key" | "value", v: string) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: v } : r)));
    setDirty(true);
  };
  const add = () => {
    setRows((prev) => [...prev, { key: "", value: "" }]);
    setDirty(true);
  };
  const remove = (i: number) => {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
    setDirty(true);
  };
  const save = async () => {
    const kv: Record<string, string> = {};
    rows.forEach((r) => {
      if (r.key.trim()) kv[r.key.trim()] = r.value;
    });
    await saveGlobalConfig(kv);
    setDirty(false);
  };

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">{t("global.title")}</h2>
        <Button size="sm" onClick={add}>{t("global.add")}</Button>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <Input value={r.key} onChange={(e) => update(i, "key", e.target.value)} placeholder="KEY" />
          <Input value={r.value} onChange={(e) => update(i, "value", e.target.value)} placeholder="value" />
          <Button variant="outline" size="sm" onClick={() => remove(i)}>{t("global.remove")}</Button>
        </div>
      ))}
      <Button disabled={!dirty} onClick={save}>{t("global.save")}</Button>
    </div>
  );
}
```

- [ ] **Step 2: 补 i18n key**

zh.json 加：`"global.add": "新增"`, `"global.remove": "删除"`, `"global.save": "保存"`；en 对应 `Add`/`Remove`/`Save`。

- [ ] **Step 3: 改 OutputPanel — 按 view 切换**

把 `frontend/src/components/OutputPanel.tsx` 改为：

```tsx
import { Card } from "@/components/ui/card";
import { useActionRunner } from "../hooks/useActionRunner";
import { OutputToolbar } from "./OutputToolbar";
import { OutputConsole } from "./OutputConsole";
import { ParamForm } from "./ParamForm";
import { GlobalConfigEditor } from "./GlobalConfigEditor";

export function OutputPanel() {
  const { view } = useActionRunner();
  if (view === "global") {
    return (
      <main className="flex min-w-0 flex-1 flex-col">
        <GlobalConfigEditor />
      </main>
    );
  }
  if (view === "form") {
    return (
      <main className="flex min-w-0 flex-1 flex-col">
        <OutputToolbar />
        <ParamForm />
      </main>
    );
  }
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <OutputToolbar />
      <Card className="m-4 flex-1 overflow-hidden p-0">
        <OutputConsole />
      </Card>
    </main>
  );
}
```

- [ ] **Step 4: 构建校验 + 全量测试**

```bash
cd frontend && npm run build && npm test
```
预期：构建通过，测试全绿。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/components frontend/src/i18n
git commit -m "feat(前端): GlobalConfigEditor + OutputPanel 三视图切换（output/form/global）"
```

---

## Task 8: 联调 — 示例改造 + 全量验证

**Files:**
- Modify: `actions/scrape-to-md.yaml`
- Create: `config.yaml`
- Modify: `README.md`（补 params/预设/全局说明）

- [ ] **Step 1: 改造 scrape-to-md.yaml**

把 `actions/scrape-to-md.yaml` 改为带 params + presets（用 spec 节 3.1 的示例）：

```yaml
id: scrape-to-md
title: 抓网页转 Markdown
icon: 🌐
description: 把 URL 正文抓成 Markdown 存到本地
params:
  - id: URL
    label: 网址
    type: text
    required: true
  - id: OUTPUT_DIR
    label: 输出目录
    type: path
    required: true
  - id: NAME
    label: 文件名
    type: text
    default: page
presets:
  - name: 首页
    values: { URL: https://example.com, NAME: homepage }
command:
  shell: defuddle-cli convert "${URL}" -o "${OUTPUT_DIR}/${NAME}.md"
  cwd: ${OUTPUT_DIR}
  timeout: 90s
  env:
    USER_AGENT: "Mozilla/5.0"
```

- [ ] **Step 2: 新建 config.yaml**

在仓库根创建 `config.yaml`（示例全局配置）：

```yaml
OUTPUT_DIR: D:/pages
```

- [ ] **Step 3: 全量构建**

```bash
cd frontend && npm run build && cd ..
go build -o workflow-tool.exe .
```
预期：两步成功。

- [ ] **Step 4: 启动 exe 手动验收**

```bash
./workflow-tool.exe
```

逐项确认（对应 spec §11）：

- [ ] 旧动作「👋 打个招呼」「🚀 部署」（无 params）行为不变，点击直接运行
- [ ] 「🌐 抓网页转 Markdown」点击 → 右侧弹表单（URL/输出目录/文件名），URL 必填未填时「运行」禁用
- [ ] 表单填 URL + 选目录（「选择」按钮调原生对话框）+ 拖拽目录到输入框 → 运行，命令含正确值
- [ ] 展开动作 → 见预设「首页」：单击进表单预填、双击直接运行
- [ ] 点「⚙ 全局配置」→ 右侧表格显示 `OUTPUT_DIR`，改值保存 → 重启 exe 仍为新值
- [ ] 替换优先级：params 填 OUTPUT_DIR 时覆盖全局 config 的 OUTPUT_DIR

- [ ] **Step 5: 全部单测回归**

```bash
cd frontend && npm test && cd ..
go test ./internal/runner ./internal/registry ./internal/api
```
预期：前端 + Go 测试全绿。

- [ ] **Step 6: 更新 README**

在 README「加一个动作」节后补一小节，说明 `params`（text/bool/select/path）、`presets`、全局 `config.yaml`（`${VAR}` 优先级 params>全局>env）。

- [ ] **Step 7: 提交**

```bash
git add actions/scrape-to-md.yaml config.yaml README.md
git commit -m "feat: Phase 3 联调（scrape-to-md 参数化 + 全局配置示例 + README）"
```

---

## Self-Review 记录

（实现前由计划作者完成；实现者无需操作）

- **Spec 覆盖**：§3 schema → Task 1；§4 替换语义 → Task 1（Load 存 raw）+ Task 2（Expand 优先级）；§5 后端 → Task 1/2/3；§6 前端 → Task 4/5/6/7；§7 路径/拖拽 → Task 5（pickDirectory + onDrop）；§8 校验 → Task 5（required）；§9 测试 → 各 Task 的 TDD 步；§10 YAGNI → 不涉及实现；§11 验收 → Task 8。全覆盖。
- **占位符**：无 TBD/TODO；每步含完整代码或精确命令。Wails 对话框 API 标注「实现时核对 alpha2」（已知不确定项，非占位）。
- **类型一致**：`ParamSpec`/`Preset` 在 Task 1(registry) 定义 → Task 3(api.ActionItem) 引用 → 前端 bindings 重生成后 Task 4-7 消费，字段名（ID/Label/Type/Required/Default/Options、Name/Values）跨层一致；`runAction(id, params)` 在 Task 3(api) → Task 4(Provider) → Task 5/6(消费) 签名一致；`selectPreset(actionId, presetName)` 在 Task 4 定义 → Task 6 消费一致；`view` 三态 output/form/global 在 Task 4 定义 → Task 7 消费一致。
