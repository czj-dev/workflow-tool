# 内置变量统一管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `internal/builtinvars` 包统一管理内置变量（`CURRENT_DATE`/`CURRENT_TIME`/`ADB_SERIAL`），让 `runner.Expand` 支持查内置变量，并修复 `ADB_SERIAL` 在 shell/script 域动作里取不到 UI 激活设备的 bug。

**Architecture:** 新包 `internal/builtinvars` 提供无状态之外依赖的 `Registry`（只依赖一个最小 `DeviceResolver` 接口，避免 `runner`/`adb` 循环依赖）。`runner.Expand`/`ExpandMap`/`ExpandParams` 签名新增 `ctx context.Context, builtins *builtinvars.Registry` 两个参数，查找顺序变为 vars → builtins → 环境变量。所有调用点（`ShellRunner`/`LLMRunner`/`ADBRunner`/`api.Service` 的 `run.go`/`workflows.go`/`actionrun.Build`）透传这两个新参数。

**Tech Stack:** Go 1.x，标准库 `time`/`strconv`/`context`，无新增第三方依赖。

## Global Constraints

- 变量格式：`CURRENT_DATE` = `time.Now().Format("20060102")`；`CURRENT_TIME` = `strconv.FormatInt(time.Now().UnixMilli(), 10)`（完整毫秒时间戳，纯数字字符串）。
- 查找优先级：动作参数(params) > 全局配置(config.yaml，已在 params/merged 里) > 内置变量 > 环境变量。内置变量**不会**覆盖 params/config.yaml 里已有同名 key（因为 `Expand` 先查 vars，vars 命中直接返回，不再往下查 builtins）。
- `ADB_SERIAL` 在 `config.yaml` 显式配置或 params 里已有值时，沿用现有行为（`ADBRunner.resolveSerial` 的在线校验/回退逻辑不变），内置变量只是给"完全没有任何显式值"的场景（尤其是 shell/script 域）提供兜底。
- `builtinvars.Registry` 的 nil receiver 与 nil `DeviceResolver` 都必须安全（不 panic），因为大量现有测试直接构造 `ShellRunner{}`/`ADBRunner{}` 不设置 builtins 字段。
- 不改变 `runner.Runner` 接口本身（`Run(ctx, params, emit) Result`）；builtins 通过各 Runner struct 的字段注入，不进 `Run` 的参数列表。
- 每个任务完成后运行 `go build ./...` 和相关包的 `go test`，确保编译通过、测试通过后才进入下一任务。

---

## File Structure

```
internal/builtinvars/
  builtinvars.go       新建：Registry + DeviceResolver 接口 + Resolve()
  builtinvars_test.go  新建：单测

internal/runner/
  expand.go            修改：Expand/ExpandMap/ExpandParams 签名新增 ctx, builtins
  expand_test.go       修改：现有用例更新签名 + 新增 builtins 优先级用例
  shell_runner.go      修改：ShellConfig 新增 Builtins 字段，Run() 里透传
  llm_runner.go         修改：LLMConfig 新增 Builtins 字段（仅 Cwd 展开用得到，其余字段在 actionrun.buildLLM 里已展开）

internal/adb/
  runner.go            修改：ADBRunner 新增 Builtins 字段，resolveSerial 新增 builtins 参数与兜底分支
  runner_test.go       修改：resolveSerial 调用签名更新 + 新增 builtins 命中用例

internal/actionrun/
  build.go             修改：Deps 新增 Builtins 字段，Build() 新增 ctx 参数，buildLLM 透传
  build_test.go         修改：Build() 调用签名更新

internal/api/
  api.go               修改：Service 新增 builtins 字段，New() 里构造并注入 runDeps
  run.go               修改：execute() 里 ExpandParams/Expand 调用透传 ctx, s.builtins；actionrun.Build 调用新增 ctx
  workflows.go         修改：makeShellRun/buildActionRunParams 里的 Expand 调用透传；actionrun.Build 调用新增 ctx
  api_test.go          修改：如有直接调用 Expand/Build 的测试同步签名

docs/action.md         修改：变量替换章节新增内置变量说明
```

---

### Task 1: `internal/builtinvars` 包 — Registry 与三个内置变量

**Files:**
- Create: `internal/builtinvars/builtinvars.go`
- Test: `internal/builtinvars/builtinvars_test.go`

**Interfaces:**
- Produces:
  - `type DeviceResolver interface { ResolveActive(ctx context.Context) (string, error) }`
  - `type Registry struct { ... }`（字段不导出）
  - `func New(dev DeviceResolver) *Registry`
  - `func (r *Registry) Resolve(ctx context.Context, name string) (string, bool)` — nil receiver 安全，返回 `("", false)`

- [ ] **Step 1: 写失败测试**

创建 `internal/builtinvars/builtinvars_test.go`：

```go
package builtinvars

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"
)

// fakeDev 实现 DeviceResolver，用于测试 ADB_SERIAL 解析。
type fakeDev struct {
	serial string
	err    error
}

func (f *fakeDev) ResolveActive(ctx context.Context) (string, error) {
	return f.serial, f.err
}

func TestResolveCurrentDate(t *testing.T) {
	r := New(nil)
	got, ok := r.Resolve(context.Background(), "CURRENT_DATE")
	if !ok {
		t.Fatal("CURRENT_DATE 应命中")
	}
	want := time.Now().Format("20060102")
	if got != want {
		t.Fatalf("CURRENT_DATE 格式不对，got %q want %q", got, want)
	}
	if len(got) != 8 {
		t.Fatalf("CURRENT_DATE 应为 8 位数字，got %q", got)
	}
}

func TestResolveCurrentTime(t *testing.T) {
	r := New(nil)
	before := time.Now().UnixMilli()
	got, ok := r.Resolve(context.Background(), "CURRENT_TIME")
	after := time.Now().UnixMilli()
	if !ok {
		t.Fatal("CURRENT_TIME 应命中")
	}
	ms, err := strconv.ParseInt(got, 10, 64)
	if err != nil {
		t.Fatalf("CURRENT_TIME 应为纯数字，got %q, err %v", got, err)
	}
	if ms < before || ms > after {
		t.Fatalf("CURRENT_TIME 应落在调用区间内，got %d, range [%d,%d]", ms, before, after)
	}
}

func TestResolveADBSerialHit(t *testing.T) {
	r := New(&fakeDev{serial: "EMULATOR-5554"})
	got, ok := r.Resolve(context.Background(), "ADB_SERIAL")
	if !ok || got != "EMULATOR-5554" {
		t.Fatalf("ADB_SERIAL 应命中并返回设备 serial，got %q ok=%v", got, ok)
	}
}

func TestResolveADBSerialNoDevice(t *testing.T) {
	r := New(&fakeDev{serial: "", err: nil})
	_, ok := r.Resolve(context.Background(), "ADB_SERIAL")
	if ok {
		t.Fatal("无激活设备时 ADB_SERIAL 应 ok=false")
	}
}

func TestResolveADBSerialResolveError(t *testing.T) {
	r := New(&fakeDev{err: errors.New("adb down")})
	_, ok := r.Resolve(context.Background(), "ADB_SERIAL")
	if ok {
		t.Fatal("ResolveActive 出错时 ADB_SERIAL 应 ok=false")
	}
}

func TestResolveADBSerialNilDevResolver(t *testing.T) {
	r := New(nil)
	_, ok := r.Resolve(context.Background(), "ADB_SERIAL")
	if ok {
		t.Fatal("dev 为 nil 时 ADB_SERIAL 应 ok=false（不 panic）")
	}
}

func TestResolveUnknownName(t *testing.T) {
	r := New(nil)
	_, ok := r.Resolve(context.Background(), "SOME_RANDOM_VAR")
	if ok {
		t.Fatal("未注册的变量名应 ok=false")
	}
}

func TestResolveNilRegistry(t *testing.T) {
	var r *Registry
	_, ok := r.Resolve(context.Background(), "CURRENT_DATE")
	if ok {
		t.Fatal("nil *Registry 应安全返回 ok=false，不 panic")
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/builtinvars/... -v`
Expected: 编译失败（`builtinvars.go` 不存在，`New`/`Registry`/`DeviceResolver` 未定义）

- [ ] **Step 3: 实现 `internal/builtinvars/builtinvars.go`**

```go
// Package builtinvars 统一管理内置变量（CURRENT_DATE/CURRENT_TIME/ADB_SERIAL），
// 供 runner.Expand 在 params/环境变量都未命中时兜底查询。
// 新增内置变量只需在 Resolve 的 switch 里加一个 case，不改动调用方。
package builtinvars

import (
	"context"
	"strconv"
	"time"
)

// DeviceResolver 是 ADB_SERIAL 解析所需的最小设备查询能力
// （*device.Service 实现；单独定义避免本包依赖 adb/device，防止循环依赖）。
type DeviceResolver interface {
	ResolveActive(ctx context.Context) (string, error)
}

// Registry 持有内置变量解析所需的依赖（目前只有 ADB_SERIAL 需要设备服务）。
type Registry struct {
	dev DeviceResolver
}

// New 创建 Registry。dev 为 nil 时 ADB_SERIAL 解析恒为未命中（其余变量不受影响）。
func New(dev DeviceResolver) *Registry {
	return &Registry{dev: dev}
}

// Resolve 返回 name 对应的内置变量值。ok=false 表示 name 不是已注册的内置变量，
// 或是但当前解析失败（如无在线设备）——调用方应继续走下一优先级（环境变量）。
// receiver 为 nil 时安全返回 ("", false)，兼容未注入 builtins 的调用点。
func (r *Registry) Resolve(ctx context.Context, name string) (string, bool) {
	if r == nil {
		return "", false
	}
	switch name {
	case "CURRENT_DATE":
		return time.Now().Format("20060102"), true
	case "CURRENT_TIME":
		return strconv.FormatInt(time.Now().UnixMilli(), 10), true
	case "ADB_SERIAL":
		if r.dev == nil {
			return "", false
		}
		serial, err := r.dev.ResolveActive(ctx)
		if err != nil || serial == "" {
			return "", false
		}
		return serial, true
	default:
		return "", false
	}
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `go test ./internal/builtinvars/... -v`
Expected: 全部 PASS（7 个测试）

- [ ] **Step 5: Commit**

```bash
git add internal/builtinvars/builtinvars.go internal/builtinvars/builtinvars_test.go
git commit -m "feat: 新增 builtinvars 包统一管理内置变量"
```

---

### Task 2: `runner.Expand`/`ExpandMap`/`ExpandParams` 支持内置变量

**Files:**
- Modify: `internal/runner/expand.go`
- Modify: `internal/runner/expand_test.go`

**Interfaces:**
- Consumes: `builtinvars.Registry.Resolve(ctx, name) (string, bool)`（Task 1 产出，nil receiver 安全）
- Produces:
  - `func Expand(ctx context.Context, s string, vars map[string]any, builtins *builtinvars.Registry) string`
  - `func ExpandMap(ctx context.Context, m map[string]string, vars map[string]any, builtins *builtinvars.Registry) map[string]string`
  - `func ExpandParams(ctx context.Context, params map[string]any, builtins *builtinvars.Registry) map[string]any`

- [ ] **Step 1: 写失败测试（新增用例，先不改现有用例签名）**

在 `internal/runner/expand_test.go` 末尾追加（先追加新用例，Step 3 里再统一改全部签名）：

```go
// 追加到文件末尾，import 块需加 "workflow-tool/internal/builtinvars"

type stubDev struct{ serial string }

func (s *stubDev) ResolveActive(ctx context.Context) (string, error) {
	return s.serial, nil
}

func TestExpandBuiltinFallsBackAfterParamsMiss(t *testing.T) {
	os.Unsetenv("ADB_SERIAL")
	builtins := builtinvars.New(&stubDev{serial: "DEVICE_X"})
	got := Expand(context.Background(), "s=${ADB_SERIAL}", map[string]any{}, builtins)
	if got != "s=DEVICE_X" {
		t.Fatalf("params 未命中应查 builtins，got %q", got)
	}
}

func TestExpandParamsOverridesBuiltin(t *testing.T) {
	builtins := builtinvars.New(&stubDev{serial: "DEVICE_X"})
	got := Expand(context.Background(), "s=${ADB_SERIAL}", map[string]any{"ADB_SERIAL": "PINNED"}, builtins)
	if got != "s=PINNED" {
		t.Fatalf("params 应优先于 builtins，got %q", got)
	}
}

func TestExpandBuiltinBeforeEnv(t *testing.T) {
	os.Setenv("CURRENT_DATE", "envvalue")
	defer os.Unsetenv("CURRENT_DATE")
	builtins := builtinvars.New(nil)
	got := Expand(context.Background(), "d=${CURRENT_DATE}", map[string]any{}, builtins)
	if got == "d=envvalue" {
		t.Fatal("builtins 应优先于环境变量")
	}
	if len(got) != len("d=")+8 {
		t.Fatalf("CURRENT_DATE 应是 8 位日期，got %q", got)
	}
}

func TestExpandNilBuiltinsFallsBackToEnv(t *testing.T) {
	os.Setenv("V2", "fromenv2")
	defer os.Unsetenv("V2")
	got := Expand(context.Background(), "v=${V2}", map[string]any{}, nil)
	if got != "v=fromenv2" {
		t.Fatalf("builtins=nil 应跳过、回退 env，got %q", got)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/runner/... -run TestExpandBuiltin -v`
Expected: 编译失败（`Expand` 签名不匹配，`builtinvars` 包未导入过）

- [ ] **Step 3: 修改 `internal/runner/expand.go`**

```go
package runner

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"

	"workflow-tool/internal/builtinvars"
)

// Expand 把 s 里的 ${VAR} 按优先级替换：vars（params/merged） → builtins（内置变量）
// → 环境变量；都未命中则保留 ${VAR} 原样并记一条 warning。
// vars 的值支持任意类型（按 fmt.Sprint 转字符串）。builtins 为 nil 时跳过该层查找。
//
// 所有 Runner 实现都应通过它用 params 做变量替换（Phase 3 通用契约）。
func Expand(ctx context.Context, s string, vars map[string]any, builtins *builtinvars.Registry) string {
	return os.Expand(s, func(name string) string {
		if v, ok := vars[name]; ok {
			return fmt.Sprint(v)
		}
		if v, ok := builtins.Resolve(ctx, name); ok {
			return v
		}
		if v, ok := os.LookupEnv(name); ok {
			return v
		}
		log.Printf("warning: 未定义的变量 ${%s}（params/内置变量/env 都无），保留原样", name)
		return "${" + name + "}"
	})
}

// ExpandMap 对 map 的每个 value 做 Expand（用于 env 块）。
func ExpandMap(ctx context.Context, m map[string]string, vars map[string]any, builtins *builtinvars.Registry) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		// 仅当含 ${} 时才替换，避免无谓日志
		if strings.Contains(v, "${") {
			out[k] = Expand(ctx, v, vars, builtins)
		} else {
			out[k] = v
		}
	}
	return out
}

// ExpandParams 对 params 中每个字符串值做 ${VAR} 展开（用原始 params 作为查表来源），
// 非字符串值（bool 等）原样保留。由 api 层在调用 runner.Run 之前统一调用，
// 使所有 runner 拿到的 params 都是终值——runner 不再各自重复展开。
//
// 这是 ${VAR} 展开的唯一入口：workflow 的 action step params 常含 ${PACKAGE} 这类引用，
// Substitute 只处理 ${{ }} 表达式，剩余 ${VAR} 在此统一了结。
func ExpandParams(ctx context.Context, params map[string]any, builtins *builtinvars.Registry) map[string]any {
	if len(params) == 0 {
		return params
	}
	out := make(map[string]any, len(params))
	for k, v := range params {
		if s, ok := v.(string); ok {
			out[k] = Expand(ctx, s, params, builtins)
		} else {
			out[k] = v
		}
	}
	return out
}
```

- [ ] **Step 4: 更新 `expand_test.go` 里现有用例的签名**

把文件开头已有的 6 个测试函数（`TestExpandParamsPriority`/`TestExpandUndefinedKept`/`TestExpandNonStringVar`/`TestExpandParamsMapExpandsStringRefs`/`TestExpandParamsMapKeepsNonStringValues`/`TestExpandParamsMapNilEmpty`）里所有 `Expand(...)`/`ExpandParams(...)` 调用，在参数列表里插入 `context.Background(), ` 作为第一个参数、`nil` 作为最后一个参数。例如：

```go
// 之前
got := Expand("v=${V}", map[string]any{"V": "fromparam"})
// 之后
got := Expand(context.Background(), "v=${V}", map[string]any{"V": "fromparam"}, nil)
```

```go
// 之前
out := ExpandParams(in)
// 之后
out := ExpandParams(context.Background(), in, nil)
```

文件顶部 import 块加 `"context"`：

```go
import (
	"context"
	"os"
	"testing"

	"workflow-tool/internal/builtinvars"
)
```

- [ ] **Step 5: 运行全部测试确认通过**

Run: `go test ./internal/runner/... -run TestExpand -v`
Expected: 全部 PASS（原 6 个 + 新增 4 个 = 10 个测试）

- [ ] **Step 6: Commit**

```bash
git add internal/runner/expand.go internal/runner/expand_test.go
git commit -m "feat: Expand 新增内置变量查找层（params > builtins > env）"
```

---

### Task 3: `ShellRunner`/`LLMRunner` 透传 builtins

**Files:**
- Modify: `internal/runner/shell_runner.go`
- Modify: `internal/runner/llm_runner.go`
- Modify: `internal/runner/shell_runner_test.go`（如存在，检查并同步签名）
- Modify: `internal/runner/llm_runner_test.go`

**Interfaces:**
- Consumes: Task 2 产出的新签名 `Expand(ctx, s, vars, builtins)`/`ExpandMap(ctx, m, vars, builtins)`
- Produces:
  - `ShellConfig` 新增字段 `Builtins *builtinvars.Registry`
  - `LLMConfig` 新增字段 `Builtins *builtinvars.Registry`
  - 两者 `Run(ctx, params, emit)` 方法签名不变（`builtins` 通过 `Cfg` 字段拿到，不进 `Run` 参数列表）

- [ ] **Step 1: 检查现有测试文件是否直接构造 `ShellRunner{}`/调用 `Expand`**

Run: `grep -n "ShellRunner{\|Cfg\.\|runner\.Expand\|ExpandMap" internal/runner/shell_runner_test.go internal/runner/llm_runner_test.go`

记录所有匹配行，用于 Step 4 逐一确认是否需要改动（多数只是构造 `Cfg` 不传 `Builtins`，字段零值 `nil` 天然安全，不需要改）。

- [ ] **Step 2: 修改 `internal/runner/shell_runner.go`**

先读取当前文件顶部 import 与 `ShellConfig` 定义：

```go
package runner

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"time"

	"workflow-tool/internal/builtinvars"
)

// ShellConfig 是已解析、待执行的命令配置。
type ShellConfig struct {
	Shell         string            // 内联命令（与 Script 二选一）
	Script        string            // 脚本路径不含扩展名（与 Shell 二选一）
	Cwd           string            // 工作目录（必须存在）
	Timeout       time.Duration     // 超时
	Env           map[string]string // 额外环境变量
	BaseDir       string            // exe 目录，用于解析相对 script 路径
	CaptureOutput *bool             // nil 或指向 true = 捕获全量 stdout/stderr 供 outputs 使用；指向 false = 关闭（长跑/持续输出 action 用）
	Builtins      *builtinvars.Registry // 内置变量注册表（CURRENT_DATE/CURRENT_TIME/ADB_SERIAL），nil 时跳过该层查找
}
```

`Run` 方法里的展开调用：

```go
// Run 执行配置的命令，通过 emit 流式推送输出。
func (r *ShellRunner) Run(ctx context.Context, params map[string]any, emit EmitFunc) Result {
	start := time.Now()

	cfg := r.Cfg

	// Phase 3：所有 Runner 实现都用 params 替换 ${VAR}（params > 内置变量 > env，未定义保留+warning）
	cfg.Shell = Expand(ctx, cfg.Shell, params, cfg.Builtins)
	cfg.Script = Expand(ctx, cfg.Script, params, cfg.Builtins)
	cfg.Cwd = Expand(ctx, cfg.Cwd, params, cfg.Builtins)
	cfg.Env = ExpandMap(ctx, cfg.Env, params, cfg.Builtins)

	cmd, err := buildCommandFromCfg(cfg)
```

（`buildCommandFromCfg` 及其后的代码保持不动。）

- [ ] **Step 3: 修改 `internal/runner/llm_runner.go`**

读取当前 `LLMConfig` 定义与 `Run` 方法里 `Cwd` 处理逻辑（第 28 行、第 50-67 行附近），在 `LLMConfig` struct 里新增字段：

```go
type LLMConfig struct {
	// ...现有字段不变...
	Builtins *builtinvars.Registry // 内置变量注册表，nil 时跳过该层查找
}
```

`Run` 方法里 `cfg.Cwd` 相关逻辑（第 67 行附近 `if cfg.Cwd != "" {`）之前不需要改——**注意**：`actionrun.buildLLM` 已经在构造 `LLMRunner` 之前把 `Cwd` 用 `Expand` 展开成终值传入（`build.go:90`），所以 `LLMConfig.Builtins` 字段本次只是为了保持结构一致性预留，`LLMRunner.Run` 内部不需要再调用 `Expand`。**不修改 `Run` 方法体**，只在 struct 里加字段、顶部 import 加 `"workflow-tool/internal/builtinvars"`。

- [ ] **Step 4: 运行测试确认现有测试仍通过**

Run: `go test ./internal/runner/... -v`
Expected: 全部 PASS（现有 `ShellRunner`/`LLMRunner` 测试不涉及 `Expand` 直接调用，字段新增不破坏零值构造）

- [ ] **Step 5: Commit**

```bash
git add internal/runner/shell_runner.go internal/runner/llm_runner.go
git commit -m "feat: ShellConfig/LLMConfig 新增 Builtins 字段"
```

---

### Task 4: `ADBRunner.resolveSerial` 支持内置变量兜底

**Files:**
- Modify: `internal/adb/runner.go`
- Modify: `internal/adb/runner_test.go`

**Interfaces:**
- Consumes: `builtinvars.Registry.Resolve(ctx, "ADB_SERIAL") (string, bool)`（Task 1）
- Produces: `ADBRunner` 新增字段 `Builtins *builtinvars.Registry`；`resolveSerial(ctx, dev, builtins, paramSerial) string` 签名变化（新增 `builtins` 参数，插在 `dev` 之后）

- [ ] **Step 1: 写失败测试（新增用例）**

在 `internal/adb/runner_test.go` 末尾追加：

```go
// stubBuiltins 模拟 builtinvars.Registry 命中 ADB_SERIAL 的场景。
type stubBuiltins struct{ serial string }

func (s *stubBuiltins) Resolve(ctx context.Context, name string) (string, bool) {
	if name == "ADB_SERIAL" && s.serial != "" {
		return s.serial, true
	}
	return "", false
}

// params 无显式 serial、dev.ResolveActive 也拿不到（模拟纯 shell 域场景没有 dev 依赖时的兜底），
// 但 builtins 命中 → 用 builtins 的值。
func TestResolveSerialFallsBackToBuiltinsWhenNoDevAndEmptyParam(t *testing.T) {
	got := resolveSerial(context.Background(), nil, &fakeBuiltinsAdapter{&stubBuiltins{serial: "FROM_BUILTINS"}}, "")
	if got != "FROM_BUILTINS" {
		t.Fatalf("dev 为 nil 时应回退 builtins，got %q", got)
	}
}

// builtins 为 nil（未注入）→ 保持现有行为，不 panic。
func TestResolveSerialNilBuiltinsPassthrough(t *testing.T) {
	dev := &fakeDev{ready: map[string]bool{}, resolve: "AUTO_PICKED"}
	got := resolveSerial(context.Background(), dev, nil, "")
	if got != "AUTO_PICKED" {
		t.Fatalf("builtins=nil 应跳过、继续走 dev.ResolveActive，got %q", got)
	}
}
```

先不要定义 `fakeBuiltinsAdapter`——这一步的目的是让编译失败，暴露出 `resolveSerial` 签名还未变更。

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/adb/... -run TestResolveSerial -v`
Expected: 编译失败（`resolveSerial` 参数数量不匹配，`fakeBuiltinsAdapter` 未定义）

- [ ] **Step 3: 定义 builtins 接口并修改 `internal/adb/runner.go`**

先看当前文件顶部 import 与 `deviceResolver` 接口定义（第 1-40 行附近），新增一个最小接口（避免直接依赖 `*builtinvars.Registry` 具体类型，方便测试用 stub）：

```go
package adb

import (
	"context"
	"fmt"
	"strings"
	"time"

	"workflow-tool/internal/adb/binary"
	"workflow-tool/internal/runner"
)

// builtinResolver 是 ADB_SERIAL 内置变量兜底所需的最小能力
// （*builtinvars.Registry 实现；单独定义方便测试用 stub，避免本包依赖具体类型细节）。
type builtinResolver interface {
	Resolve(ctx context.Context, name string) (string, bool)
}
```

`ADBRunner` struct 新增字段：

```go
type ADBRunner struct {
	Operation    string
	Timeout      time.Duration
	Dev          deviceResolver
	ResolvePaths func() binary.Paths
	Control      chan any
	Builtins     builtinResolver // 内置变量兜底（ADB_SERIAL），nil 时跳过该层，行为与改动前一致
}
```

`Run` 方法里调用处：

```go
	// 解析 serial：优先 params 里的 ${ADB_SERIAL}（config.yaml 显式覆盖时经此路径），
	// 但需校验仍在线；未命中或失效时依次尝试 builtins（内置变量兜底）与 ResolveActive。
	// 设备（尤其车载/网络 ADB）重连后 transport serial 可能变化，缓存的 ADB_SERIAL 会失效；
	// 若盲目把失效 serial 传给 adb，会得到 "- waiting for device -" 并悬挂到超时。
	serial := resolveSerial(ctx, r.Dev, r.Builtins, strParam(params, "ADB_SERIAL"))
```

`resolveSerial` 函数体：

```go
// resolveSerial 决定本次 adb 命令的目标 serial，按优先级：
// 1. paramSerial 非空且仍在线 → 沿用（尊重 UI 选择的设备 / config.yaml 显式 ADB_SERIAL）；
// 2. builtins 命中（内置变量兜底，ADB_SERIAL 走 device.Service.ResolveActive）；
// 3. dev.ResolveActive（重新选首个 ready 设备），避免 adb -s <失效serial> 无限 waiting；
// 4. 全部落空则保留 paramSerial 原值（可能为空，交给下游 adb 自行报错）。
// dev 为 nil（测试/无设备服务）时跳过第 1/3 步；builtins 为 nil 时跳过第 2 步。
func resolveSerial(ctx context.Context, dev deviceResolver, builtins builtinResolver, paramSerial string) string {
	if paramSerial != "" && dev != nil && dev.IsReady(ctx, paramSerial) {
		return paramSerial
	}
	if builtins != nil {
		if s, ok := builtins.Resolve(ctx, "ADB_SERIAL"); ok {
			return s
		}
	}
	if dev != nil {
		if s, err := dev.ResolveActive(ctx); err == nil && s != "" {
			return s
		}
	}
	return paramSerial
}
```

**注意**：原逻辑里 `if dev == nil { return paramSerial }` 的早退分支要移除，改为在每个判断处单独判空——因为现在 `dev` 为 nil 但 `builtins` 非 nil 时仍应尝试 builtins 兜底（这是 shell 域场景：`ADBRunner` 未必总有 `Dev` 但可能有 `Builtins`）。

- [ ] **Step 4: 补全测试文件的 stub 适配器**

回到 `internal/adb/runner_test.go`，把 Step 1 里占位的 `fakeBuiltinsAdapter` 去掉（不需要，因为 `stubBuiltins` 已经直接实现了 `Resolve(ctx, name) (string, bool)`，满足 `builtinResolver` 接口），修正测试为：

```go
func TestResolveSerialFallsBackToBuiltinsWhenNoDevAndEmptyParam(t *testing.T) {
	got := resolveSerial(context.Background(), nil, &stubBuiltins{serial: "FROM_BUILTINS"}, "")
	if got != "FROM_BUILTINS" {
		t.Fatalf("dev 为 nil 时应回退 builtins，got %q", got)
	}
}

func TestResolveSerialNilBuiltinsPassthrough(t *testing.T) {
	dev := &fakeDev{ready: map[string]bool{}, resolve: "AUTO_PICKED"}
	got := resolveSerial(context.Background(), dev, nil, "")
	if got != "AUTO_PICKED" {
		t.Fatalf("builtins=nil 应跳过、继续走 dev.ResolveActive，got %q", got)
	}
}

// builtins 命中但 dev 的在线 serial 更应优先——覆盖 paramSerial 在线场景，builtins 不应抢先。
func TestResolveSerialParamStillWinsOverBuiltins(t *testing.T) {
	dev := &fakeDev{ready: map[string]bool{"DEVICE_A": true}}
	got := resolveSerial(context.Background(), dev, &stubBuiltins{serial: "FROM_BUILTINS"}, "DEVICE_A")
	if got != "DEVICE_A" {
		t.Fatalf("在线 paramSerial 应优先于 builtins，got %q", got)
	}
}
```

同时更新此前已存在的 6 个测试（`TestResolveSerialKeepsValidInjectedSerial` 等）里的 `resolveSerial(...)` 调用，在 `dev` 参数后插入 `nil`（表示不测 builtins 分支）：

```go
// 之前
got := resolveSerial(context.Background(), dev, "DEVICE_A")
// 之后
got := resolveSerial(context.Background(), dev, nil, "DEVICE_A")
```

对以下 6 处逐一应用同样改法：`TestResolveSerialKeepsValidInjectedSerial`、`TestResolveSerialFallsBackWhenStale`、`TestResolveSerialResolvesWhenEmpty`、`TestResolveSerialKeepsParamOnResolveError`、`TestResolveSerialKeepsParamWhenNoDevice`、`TestResolveSerialNilDevPassthrough`（最后这个也要在 `nil` dev 后再加一个 `nil` builtins：`resolveSerial(context.Background(), nil, nil, "ANY")`）。

- [ ] **Step 5: 运行测试确认全部通过**

Run: `go test ./internal/adb/... -run TestResolveSerial -v`
Expected: 全部 PASS（原 6 个改签名 + 新增 3 个 = 9 个测试）

- [ ] **Step 6: 运行整个 adb 包测试确认无回归**

Run: `go test ./internal/adb/... -v`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add internal/adb/runner.go internal/adb/runner_test.go
git commit -m "fix: ADBRunner.resolveSerial 支持内置变量兜底（修复 shell 域 ADB_SERIAL 取不到激活设备）"
```

---

### Task 5: `actionrun.Build`/`Deps`/`Options` 透传 builtins + ctx

**Files:**
- Modify: `internal/actionrun/build.go`
- Modify: `internal/actionrun/build_test.go`

**Interfaces:**
- Consumes: Task 3/4 产出的 `ShellConfig.Builtins`/`LLMConfig.Builtins`/`ADBRunner.Builtins` 字段；Task 2 产出的 `Expand(ctx, s, vars, builtins)`
- Produces:
  - `Deps` 新增字段 `Builtins *builtinvars.Registry`
  - `func Build(ctx context.Context, la registry.LoadedAction, deps Deps, opts Options) runner.Runner`（新增 `ctx` 作为第一个参数）

- [ ] **Step 1: 写失败测试（更新现有测试签名 + 新增 builtins 透传验证）**

修改 `internal/actionrun/build_test.go`，在文件顶部 import 加 `"context"`，把全部 `Build(la, ...)` 调用改为 `Build(context.Background(), la, ...)`：

```go
r := Build(context.Background(), la, Deps{BaseDir: "/base"}, Options{})
...
sr2 := Build(context.Background(), la, Deps{}, Options{ExtraEnv: map[string]string{"A": "2", "B": "3"}}).(*runner.ShellRunner)
...
sr3 := Build(context.Background(), la, Deps{}, Options{}).(*runner.ShellRunner)
...
sr4 := Build(context.Background(), la, Deps{}, Options{CaptureOverride: &tr}).(*runner.ShellRunner)
...
r := Build(context.Background(), la, Deps{}, Options{})  // TestBuildADBForm 里
...
r := Build(context.Background(), la, Deps{}, Options{Params: params})  // TestBuildLLMForm 里
...
sr := Build(context.Background(), la, Deps{}, Options{Params: params, ExtraEnv: map[string]string{"K": "v"}})
```

并在 `TestBuildShellForm` 末尾追加验证 `Deps.Builtins` 透传到 `ShellConfig.Builtins`：

```go
// Deps.Builtins 应透传到 ShellRunner.Cfg.Builtins
builtins := builtinvars.New(nil)
sr5 := Build(context.Background(), la, Deps{Builtins: builtins}, Options{}).(*runner.ShellRunner)
if sr5.Cfg.Builtins != builtins {
	t.Fatal("Deps.Builtins 未透传到 ShellConfig.Builtins")
}
```

顶部 import 加 `"workflow-tool/internal/builtinvars"`。

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/actionrun/... -v`
Expected: 编译失败（`Build` 参数数量不匹配，`Deps.Builtins`/`ShellConfig.Builtins` 未透传逻辑缺失）

- [ ] **Step 3: 修改 `internal/actionrun/build.go`**

`Deps` struct 新增字段（顶部 import 加 `"workflow-tool/internal/builtinvars"`）：

```go
// Deps 是跨动作共享的执行依赖，由 api.Service 构造一次、全程复用。
type Deps struct {
	BaseDir   string              // exe 目录，解析相对 script 路径
	ADBPaths  func() binary.Paths // 二进制路径解析（config 覆盖 → PATH → 常见路径），唯一实现是 api.binPaths
	ADBDevice DeviceResolver      // 设备解析（serial 校验与回退）
	Builtins  *builtinvars.Registry // 内置变量注册表（CURRENT_DATE/CURRENT_TIME/ADB_SERIAL）
}
```

`Build` 函数签名与内部调用改为：

```go
// Build 按 LoadedAction 的 command 形态构造对应 Runner。
// registry.Validate 已保证四选一互斥，default 分支即 shell/script 形态。
func Build(ctx context.Context, la registry.LoadedAction, deps Deps, opts Options) runner.Runner {
	capture := la.Def.Command.CaptureOutput
	if opts.CaptureOverride != nil {
		capture = opts.CaptureOverride
	}
	switch {
	case la.Def.Command.Adb.Operation != "":
		return &adb.ADBRunner{
			Operation:    la.Def.Command.Adb.Operation,
			Timeout:      la.Timeout,
			Dev:          deps.ADBDevice,
			ResolvePaths: deps.ADBPaths,
			Control:      opts.ADBControl,
			Builtins:     deps.Builtins,
		}
	case la.Def.Command.LLM.Prompt != "":
		return buildLLM(ctx, la, opts, deps.Builtins)
	default:
		return &runner.ShellRunner{Cfg: runner.ShellConfig{
			Shell:         la.Def.Command.Shell,
			Script:        la.Def.Command.Script,
			Cwd:           la.Cwd, // raw，由 ShellRunner 用 params 替换
			Timeout:       la.Timeout,
			Env:           mergeEnv(la.Def.Command.Env, opts.ExtraEnv),
			BaseDir:       deps.BaseDir,
			CaptureOutput: capture,
			Builtins:      deps.Builtins,
		}}
	}
}
```

`buildLLM` 签名与内部调用改为：

```go
// buildLLM 按 command.llm 声明的 param id 从 params 取终值构造 LLMRunner。
// CLI 名空时由 LLMRunner 内部取默认（ducc）。
func buildLLM(ctx context.Context, la registry.LoadedAction, opts Options, builtins *builtinvars.Registry) runner.Runner {
	cmd := la.Def.Command.LLM
	return &runner.LLMRunner{Cfg: runner.LLMConfig{
		CLI:          strOf(opts.Params, "LLM_CLI"),
		SystemPrompt: strOf(opts.Params, cmd.System),
		Prompt:       strOf(opts.Params, cmd.Prompt),
		Resume:       strings.TrimSpace(strOf(opts.Params, cmd.Resume)),
		// LLMRunner 不做 ${VAR} 替换，Cwd 在这里展开成终值（与 Shell 形态传 raw 不同）。
		Cwd:      runner.Expand(ctx, la.Cwd, opts.Params, builtins),
		Timeout:  la.Timeout,
		Env:      mergeEnv(la.Def.Command.Env, opts.ExtraEnv),
		Builtins: builtins,
	}}
}
```

`DeviceResolver` 接口定义（文件顶部，第 19-23 行附近）保持不变，与新增的 `Deps.Builtins` 无关。

- [ ] **Step 4: 运行测试确认通过**

Run: `go test ./internal/actionrun/... -v`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add internal/actionrun/build.go internal/actionrun/build_test.go
git commit -m "feat: actionrun.Build 新增 ctx 参数并透传 Builtins 到三种 Runner"
```

---

### Task 6: `api.Service` 构造并注入 `builtins`，更新 `run.go`/`workflows.go` 全部调用点

**Files:**
- Modify: `internal/api/api.go`
- Modify: `internal/api/run.go`
- Modify: `internal/api/workflows.go`
- Modify: `internal/api/api_test.go`

**Interfaces:**
- Consumes: `builtinvars.New(dev builtinvars.DeviceResolver) *builtinvars.Registry`（Task 1）；`actionrun.Build(ctx, la, deps, opts)`（Task 5）；`runner.Expand(ctx, s, vars, builtins)`/`ExpandParams(ctx, params, builtins)`（Task 2）
- Produces: `Service.builtins *builtinvars.Registry` 字段（供其余方法引用，本任务内消费完毕，不对外暴露）

- [ ] **Step 1: 修改 `internal/api/api.go`**

顶部 import 加 `"workflow-tool/internal/builtinvars"`。`Service` struct 新增字段：

```go
type Service struct {
	app       *application.App
	reg       *registry.Registry
	baseDir   string
	cfgPath   string // config.yaml 路径
	fragPath  string // fragments.yaml 路径
	global    map[string]string
	gMu       sync.Mutex // 保护 global 的读写
	fragments []registry.Fragment
	fMu       sync.Mutex   // 保护 fragments 的读写
	running   *runRegistry // action 运行簿记（拒绝并发/结束清理/取消）
	wfReg     *workflow.WorkflowRegistry
	wfMu      sync.Mutex   // 保护 wfReg 的遍历读（GetVarReferenceCounts）
	wfRunning *runRegistry // workflow 运行簿记

	bin      *binary.Service        // adb/fastboot/scrcpy 路径探测
	dev      *device.Service        // 设备列表 + 激活 serial
	builtins *builtinvars.Registry  // 内置变量注册表（CURRENT_DATE/CURRENT_TIME/ADB_SERIAL）
	runDeps  actionrun.Deps         // actionrun.Build 的共享依赖（两条执行路径共用）
}
```

`New` 函数里构造顺序（`svc.dev` 之后紧接着构造 `svc.builtins`，因为 `builtins` 依赖 `dev`）：

```go
	svc.bin = binary.NewService()
	svc.dev = device.NewService(svc.binPaths)
	svc.builtins = builtinvars.New(svc.dev)
	svc.runDeps = actionrun.Deps{BaseDir: baseDir, ADBPaths: svc.binPaths, ADBDevice: svc.dev, Builtins: svc.builtins}
	return svc
```

（`*device.Service` 需满足 `builtinvars.DeviceResolver` 接口，即已有 `ResolveActive(ctx context.Context) (string, error)` 方法——`internal/adb/device/manager.go:148` 已存在此方法，无需改动 `device.Service`。）

- [ ] **Step 2: 修改 `internal/api/run.go`**

`execute` 方法里三处调用：

```go
func (s *Service) execute(ctx context.Context, id string, la registry.LoadedAction, params map[string]any, ctrl chan any) {
	// 统一在进入 runner 前对 params 做 ${VAR} 展开：runner 拿到的是终值，不再各自展开。
	params = runner.ExpandParams(ctx, params, s.builtins)
	defer s.running.end(id)

	ev := newActionEvents(s.app, id)

	// 运行时替换 cwd（用终值 params），替换后检查存在性；
	// 早退发生在任何 output 之前，done 不带 seq（前端直接应用）。
	cwd := runner.Expand(ctx, la.Cwd, params, s.builtins)
	if cwd != "" {
		if _, err := os.Stat(cwd); err != nil {
			ev.DoneUnordered(-1, fmt.Sprintf("工作目录不存在: %s", cwd), 0)
			return
		}
	}

	r := actionrun.Build(ctx, la, s.runDeps, actionrun.Options{Params: params, ADBControl: ctrl})
	res := r.Run(ctx, params, ev.EmitFunc())
```

（其余代码不变。）

- [ ] **Step 3: 修改 `internal/api/workflows.go`**

`makeActionRun` 里 `actionrun.Build` 调用（第 170 行附近）：

```go
func (s *Service) makeActionRun(merged map[string]any) workflow.ActionRunFunc {
	return func(req workflow.ActionRequest) runner.Result {
		la, ok := s.reg.Actions[req.ActionID]
		if !ok {
			req.Emit("stderr", fmt.Sprintf("未知动作 %q", req.ActionID))
			return runner.Result{ExitCode: -1, Err: fmt.Errorf("未知动作 %q", req.ActionID)}
		}
		// ${VAR} 展开必须在合并前完成（详见 buildActionRunParams 注释）。
		runParams, expandedEnv := s.buildActionRunParams(req.Ctx, merged, req.Env, req.Params)
		// 与直跑路径共用同一构造逻辑：形态分发/env 分层/capture 合并都在 actionrun.Build 里。
		r := actionrun.Build(req.Ctx, la, s.runDeps, actionrun.Options{
			Params:          runParams,
			ExtraEnv:        expandedEnv,
			CaptureOverride: req.CaptureOutput,
		})
		return r.Run(req.Ctx, runParams, req.Emit)
	}
}
```

`makeShellRun`：

```go
func (s *Service) makeShellRun(merged map[string]any) workflow.ShellRunFunc {
	return func(req workflow.ShellRequest) runner.Result {
		// env 的 ${VAR} 用 merged 展开（executor 只做了 ${{ }} 替换，剩余在此了结）
		expandedEnv := make(map[string]string, len(req.Env))
		for k, v := range req.Env {
			expandedEnv[k] = runner.Expand(req.Ctx, v, merged, s.builtins)
		}
		// params 同样展开成终值（runner 拿到即终值的统一约定）
		runParams := make(map[string]any, len(req.Params))
		for k, v := range req.Params {
			if sv, ok := v.(string); ok {
				runParams[k] = runner.Expand(req.Ctx, sv, merged, s.builtins)
			} else {
				runParams[k] = v
			}
		}
		r := &runner.ShellRunner{Cfg: runner.ShellConfig{
			Shell:         req.Shell,
			Timeout:       parseShellTimeout(req.Timeout),
			Env:           expandedEnv,
			CaptureOutput: req.CaptureOutput,
			Builtins:      s.builtins,
		}}
		return r.Run(req.Ctx, runParams, req.Emit)
	}
}
```

`buildActionRunParams` 改为 `Service` 的方法（原本是独立函数，现在需要访问 `s.builtins`，且需要 `ctx` 参数）：

```go
// buildActionRunParams 合并 global/workflow params（merged）与 step.params，并展开 ${VAR}。
// 展开变量源必须是 merged 而非合并结果——否则 step.params 里 { PACKAGE: "${PACKAGE}" }
// 这类自引用会展开成自身原值，拿不到 merged 里的真实包名
// （复现：adb-clean-reinstall 第一步 force-stop 收到空包名）。
func (s *Service) buildActionRunParams(ctx context.Context, merged map[string]any, env map[string]string, stepParams map[string]any) (map[string]any, map[string]string) {
	// 1. 合并 merged + stepParams（step 覆盖），字符串值用 merged 展开 ${VAR}
	runParams := make(map[string]any, len(merged)+len(stepParams))
	for k, v := range merged {
		runParams[k] = v
	}
	for k, v := range stepParams {
		if sv, ok := v.(string); ok {
			runParams[k] = runner.Expand(ctx, sv, merged, s.builtins)
		} else {
			runParams[k] = v
		}
	}

	// 2. env 的 ${VAR} 同样用 merged 展开（如 ADB_SERIAL 内置变量兜底）
	expandedEnv := make(map[string]string, len(env))
	for k, v := range env {
		expandedEnv[k] = runner.Expand(ctx, v, merged, s.builtins)
	}

	return runParams, expandedEnv
}
```

检查 `workflow.ActionRequest`/`workflow.ShellRequest` 是否已有 `Ctx` 字段可用：

Run: `grep -n "type ActionRequest\|type ShellRequest" -A5 internal/workflow/*.go`

如果输出显示两者都已有 `Ctx context.Context` 字段（预期如此，`workflows.go:175` 已经在用 `req.Ctx`），则上面的改动直接适用，无需改 `internal/workflow` 包。

- [ ] **Step 4: 检查并修改 `internal/api/api_test.go` 里受影响的调用**

Run: `grep -n "runner\.Expand\|ExpandParams\|actionrun\.Build\|buildActionRunParams" internal/api/api_test.go`

若有直接调用这些函数的测试代码，按 Task 2/5 的新签名补 `context.Background()` 与 `nil`/`s.builtins`。若 `buildActionRunParams` 被测试直接调用（原是包级函数），需要改为通过一个 `*Service` 实例调用（`svc.buildActionRunParams(ctx, ...)`），或者构造一个最小 `Service{}`（此时 `s.builtins` 为 nil，`Expand` 内部 nil-safe，测试仍可通过）。

- [ ] **Step 5: 编译并运行 api 包全部测试**

Run: `go build ./... && go test ./internal/api/... -v`
Expected: 编译通过，全部测试 PASS

- [ ] **Step 6: 运行项目全部单测确认无回归**

Run: `go test ./internal/runner ./internal/registry ./internal/workflow ./internal/actionrun ./internal/adb ./internal/builtinvars ./internal/api -v`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add internal/api/api.go internal/api/run.go internal/api/workflows.go internal/api/api_test.go
git commit -m "feat: Service 构造 builtinvars.Registry 并接入全部 Expand 调用点"
```

---

### Task 7: 端到端构建验证 + 文档同步

**Files:**
- Modify: `docs/action.md`

**Interfaces:**
- Consumes: 全部前置任务产出（无新代码接口）

- [ ] **Step 1: 全量构建**

Run: `go build ./...`
Expected: 无错误

- [ ] **Step 2: 带竞态检测的全量测试**

Run: `go test -race ./...`
Expected: 全部 PASS，无 race 报告

- [ ] **Step 3: 更新 `docs/action.md` 的"变量替换"章节**

读取当前章节内容（约第 92-102 行），替换为：

```markdown
## 变量替换

运行时由 `runner.Expand` 处理，替换优先级：

1. **动作参数**（params 表单填入的值）
2. **全局配置**（`config.yaml` 中的键值对）
3. **内置变量**（见下表，无需声明即可直接使用）
4. **环境变量**

四者都未定义则保留 `${VAR}` 原样 + 控制台 warning。

### 内置变量

| 变量 | 值 | 用途示例 |
|---|---|---|
| `CURRENT_DATE` | 当天日期，`yyyyMMdd`（如 `20260819`） | `${OUTPUT_DIR}screenshot-${CURRENT_DATE}.png` |
| `CURRENT_TIME` | 当前毫秒时间戳（如 `1755590400000`） | `${OUTPUT_DIR}${CURRENT_TIME}.png`，避免同名文件覆盖 |
| `ADB_SERIAL` | 当前激活设备 serial（UI 设备选择器选中的设备） | shell/script 动作里 `adb -s "${ADB_SERIAL}" shell ...` |

`ADB_SERIAL` 若在 `config.yaml` 里显式配置，或动作参数里已有同名值，则内置变量不生效（参数/配置优先级更高，见上）——这是给需要固定某台设备的场景保留的覆盖能力。`command.adb.operation` 形态本身有独立的在线校验与自动重连回退逻辑（详见下方"adb 域形态"），内置变量表里的 `ADB_SERIAL` 主要解决 `command.shell`/`script` 形态里引用 `${ADB_SERIAL}` 时同样能取到当前激活设备。

### workflow 中的变量优先级扩展

当 action 被 workflow 引用时，变量优先级变为：

params（step.params）> step.env > workflow.env > config.yaml > 内置变量 > 系统环境变量

`stream: logcat` action 之外，`command.llm` action 在 workflow 中运行时，即使 `capture_output: false`，仍会提取结构化 outputs（text/thinking/session_id/cost_usd/total_tokens），因为这些来自 stream-json 语义解析而非原始 stdout 转储。
```

- [ ] **Step 4: 手动验证（可选，需要真机/模拟器）**

在 `actions/` 下任意 shell 域动作的 YAML 临时改为（或新建一个测试用 action）：

```yaml
id: test-builtin-vars
title: 内置变量测试
command:
  shell: 'echo "date=${CURRENT_DATE} time=${CURRENT_TIME} serial=${ADB_SERIAL}"'
```

构建并运行（`bash deploy/build.sh`），在 UI 里选中一台设备后运行此动作，确认输出的 `date`/`time`/`serial` 都是真实值而非 `${...}` 原样。验证完成后删除该测试 action。

- [ ] **Step 5: Commit**

```bash
git add docs/action.md
git commit -m "docs: 变量替换章节补充内置变量说明"
```
