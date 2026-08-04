# Workflow 编排器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 侧边栏新增 Workflow group，支持定义 workflows/*.yaml 串行编排多个 step（引用已有 action 或 CustomRunner 如 sleep），输出面板用工具链+分步输出展示执行过程。

**Architecture:** 后端 `internal/workflow` 包：schema → loader → executor，复用 `runner.Runner` 接口；新增 `SleepRunner` 作 CustomRunner 示例。通过事件 `workflow:<id>:output` 的 stream 字段区分 `step-start` / `step-done` / `stdout` / `stderr`。前端 Provider 扩展 workflow 状态，新增 `WorkflowView` 用现有 Item/Collapsible/Badge/Card 组件渲染工具链。

**Tech Stack:** Go 标准库 + gopkg.in/yaml.v3 / Wails v3-alpha2.119 / React 19 + TS + Vite + tailwind4 + base-ui/shadcn 组件 / vitest / hugeicons

## Global Constraints

- Wails 锁定 `v3.0.0-alpha2.119`，不升级。
- `runner.Runner` 接口签名不改。
- 变量替换运行时 `runner.Expand`。
- workflow id 与 action id 全局不重名（loader 校验）。
- 改 api.go 方法签名后必须 `wails3 generate bindings` → `npm run build` → `go build`。
- 前端文案走 i18n；前端组件优先用项目已有 `ui/` 组件库（Item, Collapsible, Badge, Card, ScrollArea 等），不引入新 UI 依赖。
- 文件 <800 行，函数 <50 行。

---

## Workflow YAML Schema（workflows/*.yaml）

每个 step 必须且只能指定 `action` / `sleep` / `shell` 三者之一（step kind）。
`retry` 与 `continue_on_error` 是任意 kind 都可用的修饰字段。

```yaml
id: demo-install-broadcast          # ^[a-z0-9-]+$ 全局唯一
title: 安装后发广播
icon: hi:workflow                    # 可选
description: "先安装 APK 再发车控广播"
steps:
  - action: adb-install              # kind A: 引用已有 action id
    params:                          # 可选，覆盖 action 的 params
      apk_path: "/tmp/test.apk"
    retry: 2                         # 可选，失败后额外重试 2 次（共 3 次尝试），默认 0
  - sleep: 3                         # kind B: CustomRunner，sleep N 秒
  - shell: adb devices               # kind C: inline shell，不必先建 action
    timeout: 30s                     # 可选，仅 shell step 生效，默认 60s
    continue_on_error: true          # 可选，失败不中止后续步骤，默认 false
  - action: adb-car-broadcast
```

**字段语义：**
- `retry: N` — 该 step 失败（exitCode != 0）后最多再试 N 次；任一次成功即继续。
- `continue_on_error: true` — 所有尝试都失败时不中止 workflow，继续下一 step；workflow 最终 exitCode 仍为 0（step 状态在前端标为 error）。
- `timeout` — Go duration 字符串，仅 `shell` step 用；`action` step 用 action 自己的 timeout。

---

## File Structure

**新增（后端）：**
- `internal/runner/sleep_runner.go` — SleepRunner 实现
- `internal/runner/sleep_runner_test.go`
- `internal/workflow/schema.go` — WorkflowDef / Step / LoadedWorkflow + Validate
- `internal/workflow/loader.go` — Load(dir) → WorkflowRegistry
- `internal/workflow/loader_test.go`
- `internal/workflow/executor.go` — Execute：串行 steps，emit step-start/step-done 帧
- `internal/workflow/executor_test.go`
- `workflows/demo-install-broadcast.yaml` — 示例

**修改（后端）：**
- `internal/api/api.go` — 新增 ListWorkflows / RunWorkflow / CancelWorkflow
- `main.go` — 加载 workflows/ 目录，注入 Service

**新增（前端）：**
- `frontend/src/components/WorkflowItem.tsx` — 侧边栏条目
- `frontend/src/components/WorkflowView.tsx` — 输出面板：工具链 timeline + 分步输出

**修改（前端）：**
- `frontend/src/context/ActionRunnerProvider.tsx` — workflows 状态 + runWorkflow / cancelWorkflow
- `frontend/src/components/AppSidebar.tsx` — 新增 Workflow group
- `frontend/src/components/OutputPanel.tsx` — view === "workflow" 分支
- `frontend/src/types/events.ts` — 新增 StepEventData
- `frontend/src/i18n/locales/zh.json` + `en.json` — 新增文案

---

### Task 1: SleepRunner（后端 CustomRunner）

**Files:**
- Create: `internal/runner/sleep_runner.go`
- Create: `internal/runner/sleep_runner_test.go`

**Interfaces:**
- Consumes: `runner.Runner` 接口、`runner.EmitFunc`、`runner.Result`
- Produces: `SleepRunner` struct，实现 `Runner` 接口；后续 executor 用 `&SleepRunner{Seconds: n}` 调用

- [ ] **Step 1: Write the failing test**

```go
// internal/runner/sleep_runner_test.go
package runner

import (
	"context"
	"testing"
	"time"
)

func TestSleepRunner_EmitsAndWaits(t *testing.T) {
	var emitted []string
	emit := func(stream, line string) { emitted = append(emitted, stream+":"+line) }

	r := &SleepRunner{Seconds: 1}
	start := time.Now()
	res := r.Run(context.Background(), nil, emit)
	elapsed := time.Since(start)

	if res.ExitCode != 0 {
		t.Fatalf("expected exit 0, got %d", res.ExitCode)
	}
	if res.Err != nil {
		t.Fatalf("unexpected error: %v", res.Err)
	}
	if elapsed < 900*time.Millisecond {
		t.Fatalf("sleep too short: %v", elapsed)
	}
	if len(emitted) != 1 || emitted[0] != "stdout:sleep 1s" {
		t.Fatalf("unexpected emit: %v", emitted)
	}
}

func TestSleepRunner_CancelledEarly(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // 立即取消

	r := &SleepRunner{Seconds: 10}
	start := time.Now()
	res := r.Run(ctx, nil, func(_, _ string) {})
	elapsed := time.Since(start)

	if elapsed > 500*time.Millisecond {
		t.Fatalf("should return immediately on cancel, took %v", elapsed)
	}
	if res.ExitCode != -1 {
		t.Fatalf("expected exit -1 on cancel, got %d", res.ExitCode)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/v_chenzhaojun/Documents/workflow-tool && go test ./internal/runner -run TestSleepRunner -v`
Expected: FAIL — `SleepRunner` undefined

- [ ] **Step 3: Write minimal implementation**

```go
// internal/runner/sleep_runner.go
package runner

import (
	"context"
	"fmt"
	"time"
)

// SleepRunner 是 CustomRunner，sleep 指定秒数后返回。
type SleepRunner struct {
	Seconds int
}

func (r *SleepRunner) Run(ctx context.Context, _ map[string]any, emit EmitFunc) Result {
	start := time.Now()
	emit("stdout", fmt.Sprintf("sleep %ds", r.Seconds))

	select {
	case <-time.After(time.Duration(r.Seconds) * time.Second):
		return Result{ExitCode: 0, Duration: time.Since(start)}
	case <-ctx.Done():
		return Result{ExitCode: -1, Err: ctx.Err(), Duration: time.Since(start)}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/v_chenzhaojun/Documents/workflow-tool && go test ./internal/runner -run TestSleepRunner -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/runner/sleep_runner.go internal/runner/sleep_runner_test.go
git commit -m "feat: add SleepRunner as first CustomRunner for workflow"
```

---

### Task 2: Workflow Schema + Loader（后端）

**Files:**
- Create: `internal/workflow/schema.go`
- Create: `internal/workflow/loader.go`
- Create: `internal/workflow/loader_test.go`
- Create: `workflows/demo-install-broadcast.yaml`

**Interfaces:**
- Consumes: `gopkg.in/yaml.v3`
- Produces: `WorkflowDef`、`Step`、`LoadedWorkflow`、`WorkflowRegistry` struct；`Load(dir) *WorkflowRegistry`；`Validate(*WorkflowDef) error`

- [ ] **Step 1: Create the example workflow YAML**

```yaml
# workflows/demo-install-broadcast.yaml
id: demo-install-broadcast
title: 安装后发广播
icon: hi:workflow
description: "先安装 APK 再发车控广播（sleep 2s 等设备就绪）"
steps:
  - action: adb-install
    params:
      apk_path: "${APK_PATH}"
  - sleep: 2
  - action: adb-car-broadcast
```

- [ ] **Step 2: Write schema.go**

```go
// internal/workflow/schema.go
package workflow

import (
	"fmt"
	"regexp"
)

var idPattern = regexp.MustCompile(`^[a-z0-9-]+$`)

// WorkflowDef 是 workflow YAML 的原始结构。
type WorkflowDef struct {
	ID          string `yaml:"id"`
	Title       string `yaml:"title"`
	Icon        string `yaml:"icon"`
	Description string `yaml:"description"`
	Steps       []Step `yaml:"steps"`
}

// Step 是 workflow 中的一步。action 和 sleep 互斥。
type Step struct {
	Action string            `yaml:"action"` // 引用已有 action id
	Params map[string]string `yaml:"params"` // 覆盖 action 的参数
	Sleep  int               `yaml:"sleep"`  // CustomRunner: sleep N 秒
}

// LoadedWorkflow 是已校验的 workflow。
type LoadedWorkflow struct {
	Def  WorkflowDef
	File string // 源文件绝对路径
}

func Validate(def *WorkflowDef) error {
	if !idPattern.MatchString(def.ID) {
		return fmt.Errorf("id 必须匹配 ^[a-z0-9-]+$，got %q", def.ID)
	}
	if def.Title == "" {
		return fmt.Errorf("title 必填")
	}
	if len(def.Steps) == 0 {
		return fmt.Errorf("steps 不能为空")
	}
	for i, s := range def.Steps {
		hasAction := s.Action != ""
		hasSleep := s.Sleep > 0
		if !hasAction && !hasSleep {
			return fmt.Errorf("steps[%d]: 必须指定 action 或 sleep", i)
		}
		if hasAction && hasSleep {
			return fmt.Errorf("steps[%d]: action 与 sleep 互斥", i)
		}
	}
	return nil
}
```

- [ ] **Step 3: Write loader.go**

```go
// internal/workflow/loader.go
package workflow

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// FileError 记录单个文件的加载错误。
type FileError struct {
	File  string
	Error string
}

// WorkflowRegistry 是所有已加载 workflow 的集合。
type WorkflowRegistry struct {
	Workflows map[string]LoadedWorkflow
	Errors    []FileError
}

// Load 扫描 dir 下所有 *.yaml，返回 WorkflowRegistry。
func Load(dir string) *WorkflowRegistry {
	reg := &WorkflowRegistry{Workflows: map[string]LoadedWorkflow{}}
	files, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil {
		reg.Errors = append(reg.Errors, FileError{File: dir, Error: err.Error()})
		return reg
	}
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			reg.Errors = append(reg.Errors, FileError{File: filepath.Base(f), Error: err.Error()})
			continue
		}
		var def WorkflowDef
		if err := yaml.Unmarshal(data, &def); err != nil {
			reg.Errors = append(reg.Errors, FileError{File: filepath.Base(f), Error: err.Error()})
			continue
		}
		if err := Validate(&def); err != nil {
			reg.Errors = append(reg.Errors, FileError{File: filepath.Base(f), Error: err.Error()})
			continue
		}
		if _, exists := reg.Workflows[def.ID]; exists {
			reg.Errors = append(reg.Errors, FileError{File: filepath.Base(f), Error: fmt.Sprintf("重复 id %q", def.ID)})
			continue
		}
		reg.Workflows[def.ID] = LoadedWorkflow{Def: def, File: f}
	}
	return reg
}
```

- [ ] **Step 4: Write loader_test.go**

```go
// internal/workflow/loader_test.go
package workflow

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoad_ValidWorkflow(t *testing.T) {
	dir := t.TempDir()
	yaml := `id: test-wf
title: Test
steps:
  - action: some-action
  - sleep: 2
`
	os.WriteFile(filepath.Join(dir, "test.yaml"), []byte(yaml), 0644)

	reg := Load(dir)
	if len(reg.Errors) != 0 {
		t.Fatalf("unexpected errors: %v", reg.Errors)
	}
	if _, ok := reg.Workflows["test-wf"]; !ok {
		t.Fatal("workflow not loaded")
	}
	wf := reg.Workflows["test-wf"]
	if len(wf.Def.Steps) != 2 {
		t.Fatalf("expected 2 steps, got %d", len(wf.Def.Steps))
	}
}

func TestLoad_InvalidYAML(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "bad.yaml"), []byte("{{invalid"), 0644)

	reg := Load(dir)
	if len(reg.Errors) == 0 {
		t.Fatal("expected errors for invalid yaml")
	}
}

func TestValidate_EmptySteps(t *testing.T) {
	def := &WorkflowDef{ID: "x", Title: "X", Steps: nil}
	if err := Validate(def); err == nil {
		t.Fatal("expected error for empty steps")
	}
}

func TestValidate_MutualExclusive(t *testing.T) {
	def := &WorkflowDef{ID: "x", Title: "X", Steps: []Step{{Action: "a", Sleep: 2}}}
	if err := Validate(def); err == nil {
		t.Fatal("expected error for action+sleep")
	}
}
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/v_chenzhaojun/Documents/workflow-tool && go test ./internal/workflow/... -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add internal/workflow/ workflows/
git commit -m "feat: workflow schema, loader, and validation"
```

---

### Task 3: Workflow Executor（后端）

**Files:**
- Create: `internal/workflow/executor.go`
- Create: `internal/workflow/executor_test.go`

**Interfaces:**
- Consumes: `WorkflowDef`、`runner.Runner`、`runner.EmitFunc`、`runner.Result`、`runner.SleepRunner`
- Produces: `Executor` struct 方法 `Execute(ctx, wf LoadedWorkflow, actionRunner func(actionID string, params map[string]any, emit EmitFunc) runner.Result, emit EmitFunc) runner.Result`

- [ ] **Step 1: Write the failing test**

```go
// internal/workflow/executor_test.go
package workflow

import (
	"context"
	"testing"

	"workflow-tool/internal/runner"
)

func TestExecutor_RunsStepsSequentially(t *testing.T) {
	var events []string
	emit := func(stream, line string) {
		events = append(events, stream+":"+line)
	}

	wf := LoadedWorkflow{Def: WorkflowDef{
		ID:    "test",
		Title: "Test",
		Steps: []Step{
			{Action: "act-a"},
			{Sleep: 1},
			{Action: "act-b"},
		},
	}}

	actionRunner := func(actionID string, params map[string]any, e runner.EmitFunc) runner.Result {
		e("stdout", "ran:"+actionID)
		return runner.Result{ExitCode: 0}
	}

	exec := &Executor{}
	res := exec.Execute(context.Background(), wf, actionRunner, emit)

	if res.ExitCode != 0 {
		t.Fatalf("expected exit 0, got %d (err=%v)", res.ExitCode, res.Err)
	}
	// Expect: step-start:0, stdout from act-a, step-done:0, step-start:1, stdout from sleep, step-done:1, step-start:2, stdout from act-b, step-done:2
	hasStart0 := false
	hasDone2 := false
	for _, ev := range events {
		if ev == "step-start:0" {
			hasStart0 = true
		}
		if ev == "step-done:2" {
			hasDone2 = true
		}
	}
	if !hasStart0 || !hasDone2 {
		t.Fatalf("missing step events, got: %v", events)
	}
}

func TestExecutor_StopsOnFailure(t *testing.T) {
	emit := func(_, _ string) {}

	wf := LoadedWorkflow{Def: WorkflowDef{
		ID:    "test",
		Title: "Test",
		Steps: []Step{
			{Action: "fail-act"},
			{Action: "never-run"},
		},
	}}

	ran := []string{}
	actionRunner := func(actionID string, _ map[string]any, _ runner.EmitFunc) runner.Result {
		ran = append(ran, actionID)
		if actionID == "fail-act" {
			return runner.Result{ExitCode: 1}
		}
		return runner.Result{ExitCode: 0}
	}

	exec := &Executor{}
	res := exec.Execute(context.Background(), wf, actionRunner, emit)

	if res.ExitCode != 1 {
		t.Fatalf("expected exit 1, got %d", res.ExitCode)
	}
	if len(ran) != 1 {
		t.Fatalf("second step should not run, ran: %v", ran)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/v_chenzhaojun/Documents/workflow-tool && go test ./internal/workflow -run TestExecutor -v`
Expected: FAIL — `Executor` undefined

- [ ] **Step 3: Write executor.go**

```go
// internal/workflow/executor.go
package workflow

import (
	"context"
	"fmt"
	"time"

	"workflow-tool/internal/runner"
)

// ActionRunFunc 是 executor 调用已有 action 的回调签名。
type ActionRunFunc func(actionID string, params map[string]any, emit runner.EmitFunc) runner.Result

// Executor 按顺序执行 workflow 的 steps。
type Executor struct{}

// Execute 串行执行 wf 的每个 step。
// 每步开始 emit("step-start", stepIndex)，结束 emit("step-done", stepIndex:exitCode)。
// 任何 step 失败（exitCode != 0）则中止后续，返回该 step 的结果。
func (e *Executor) Execute(ctx context.Context, wf LoadedWorkflow, actionRun ActionRunFunc, emit runner.EmitFunc) runner.Result {
	start := time.Now()
	for i, step := range wf.Def.Steps {
		emit("step-start", fmt.Sprintf("%d", i))

		var res runner.Result
		switch {
		case step.Sleep > 0:
			sr := &runner.SleepRunner{Seconds: step.Sleep}
			res = sr.Run(ctx, nil, emit)
		case step.Action != "":
			params := toAnyMap(step.Params)
			res = actionRun(step.Action, params, emit)
		}

		emit("step-done", fmt.Sprintf("%d:%d", i, res.ExitCode))

		if res.ExitCode != 0 {
			res.Duration = time.Since(start)
			return res
		}
	}
	return runner.Result{ExitCode: 0, Duration: time.Since(start)}
}

func toAnyMap(m map[string]string) map[string]any {
	if m == nil {
		return nil
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/v_chenzhaojun/Documents/workflow-tool && go test ./internal/workflow -run TestExecutor -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/workflow/executor.go internal/workflow/executor_test.go
git commit -m "feat: workflow executor with sequential step execution"
```

---

### Task 4: API 层集成（后端）

**Files:**
- Modify: `internal/api/api.go`
- Modify: `main.go`

**Interfaces:**
- Consumes: `workflow.WorkflowRegistry`、`workflow.Executor`、`workflow.LoadedWorkflow`
- Produces: `ListWorkflows() WorkflowListResult`、`RunWorkflow(id string, params map[string]any) error`、`CancelWorkflow(id string)`

- [ ] **Step 1: Modify api.go — add workflow fields to Service and new types**

在 `Service` struct 中新增字段（在 `fragments` 下方）：

```go
wfReg    *workflow.WorkflowRegistry
wfMu     sync.Mutex
wfRunning map[string]context.CancelFunc
```

新增类型：

```go
// WorkflowItem 是前端可见的 workflow 描述。
type WorkflowItem struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Icon        string `json:"icon"`
	Description string `json:"description"`
	StepCount   int    `json:"stepCount"`
}

// WorkflowListResult 是 ListWorkflows 的返回值。
type WorkflowListResult struct {
	Workflows []WorkflowItem `json:"workflows"`
	Errors    []string       `json:"errors"`
}
```

- [ ] **Step 2: Add ListWorkflows method**

```go
func (s *Service) ListWorkflows() WorkflowListResult {
	items := make([]WorkflowItem, 0, len(s.wfReg.Workflows))
	for _, lw := range s.wfReg.Workflows {
		items = append(items, WorkflowItem{
			ID:          lw.Def.ID,
			Title:       lw.Def.Title,
			Icon:        lw.Def.Icon,
			Description: lw.Def.Description,
			StepCount:   len(lw.Def.Steps),
		})
	}
	errs := make([]string, 0, len(s.wfReg.Errors))
	for _, e := range s.wfReg.Errors {
		errs = append(errs, fmt.Sprintf("%s: %s", e.File, e.Error))
	}
	return WorkflowListResult{Workflows: items, Errors: errs}
}
```

- [ ] **Step 3: Add RunWorkflow method**

```go
func (s *Service) RunWorkflow(id string, params map[string]any) error {
	lw, ok := s.wfReg.Workflows[id]
	if !ok {
		return fmt.Errorf("未知 workflow %q", id)
	}
	s.wfMu.Lock()
	if _, running := s.wfRunning[id]; running {
		s.wfMu.Unlock()
		return fmt.Errorf("workflow %q 正在运行", id)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.wfRunning[id] = cancel
	s.wfMu.Unlock()

	go s.executeWorkflow(ctx, id, lw, params)
	return nil
}

func (s *Service) CancelWorkflow(id string) {
	s.wfMu.Lock()
	cancel, ok := s.wfRunning[id]
	s.wfMu.Unlock()
	if ok {
		cancel()
	}
}
```

- [ ] **Step 4: Add executeWorkflow internal method**

```go
func (s *Service) executeWorkflow(ctx context.Context, id string, lw workflow.LoadedWorkflow, params map[string]any) {
	defer func() {
		s.wfMu.Lock()
		delete(s.wfRunning, id)
		s.wfMu.Unlock()
	}()

	emit := func(stream, line string) {
		s.app.Event.Emit(fmt.Sprintf("workflow:%s:output", id), map[string]string{
			"stream": stream, "line": line,
		})
	}

	merged := s.mergeGlobalAndParams(params)

	actionRun := func(actionID string, stepParams map[string]any, stepEmit runner.EmitFunc) runner.Result {
		la, ok := s.reg.Actions[actionID]
		if !ok {
			stepEmit("stderr", fmt.Sprintf("未知动作 %q", actionID))
			return runner.Result{ExitCode: -1, Err: fmt.Errorf("未知动作 %q", actionID)}
		}
		// 合并全局 + workflow params + step params
		runParams := make(map[string]any, len(merged)+len(stepParams))
		for k, v := range merged {
			runParams[k] = v
		}
		for k, v := range stepParams {
			runParams[k] = v
		}
		r := &runner.ShellRunner{Cfg: runner.ShellConfig{
			Shell:   la.Def.Command.Shell,
			Script:  la.Def.Command.Script,
			Cwd:     la.Cwd,
			Timeout: la.Timeout,
			Env:     la.Def.Command.Env,
			BaseDir: s.baseDir,
			Stream:  la.Def.Command.Stream,
		}}
		return r.Run(ctx, runParams, stepEmit)
	}

	exec := &workflow.Executor{}
	res := exec.Execute(ctx, lw, actionRun, emit)

	s.app.Event.Emit(fmt.Sprintf("workflow:%s:done", id), map[string]any{
		"exitCode": res.ExitCode,
		"err":      errStr(res.Err),
		"duration": res.Duration.String(),
	})
}
```

- [ ] **Step 5: Modify main.go — load workflows dir and inject**

在 `main.go` 的 `main()` 中 `reg := registry.Load(...)` 之后加：

```go
wfReg := workflow.Load(filepath.Join(baseDir, "workflows"))
```

修改 `api.New` 调用签名，传入 `wfReg`。在 `api.New` 函数中初始化 `wfReg` 和 `wfRunning` 字段。

- [ ] **Step 6: Run backend tests + build**

Run:
```bash
cd /Users/v_chenzhaojun/Documents/workflow-tool
go test ./internal/... -v
wails3 generate bindings
cd frontend && npm run build && cd ..
go build -o workflow-tool .
```
Expected: PASS + build success

- [ ] **Step 7: Commit**

```bash
git add internal/api/api.go main.go
git commit -m "feat: API layer for workflow list/run/cancel"
```

---

### Task 5: 前端状态层（Provider 扩展）

**Files:**
- Modify: `frontend/src/context/ActionRunnerProvider.tsx`
- Modify: `frontend/src/types/events.ts`
- Modify: `frontend/src/i18n/locales/zh.json`
- Modify: `frontend/src/i18n/locales/en.json`

**Interfaces:**
- Consumes: `ListWorkflows`、`RunWorkflow`、`CancelWorkflow` bindings
- Produces: `RunnerContextValue` 新增 `workflows`、`workflowSteps`、`runWorkflow`、`cancelWorkflow`；`view` 枚举新增 `"workflow"`

- [ ] **Step 1: Extend events.ts**

新增 `StepEventData` 类型，`OutputEventData.stream` 扩展允许 `"step-start"` | `"step-done"`：

```ts
// frontend/src/types/events.ts
export interface OutputEventData {
  stream: "stdout" | "stderr" | "llm" | "llm-thinking" | "step-start" | "step-done";
  line: string;
}

export interface DoneEventData {
  exitCode: number;
  err: string;
  duration: string;
}

// workflow step 运行状态
export interface WorkflowStepState {
  index: number;
  status: "pending" | "running" | "done" | "error";
  exitCode?: number;
  lines: string[];
}
```

- [ ] **Step 2: Add i18n keys**

zh.json 新增：
```json
"sidebar.workflows": "工作流",
"workflow.running": "运行中",
"workflow.done": "完成",
"workflow.error": "失败",
"workflow.step": "步骤 {{index}}",
"workflow.stepAction": "动作: {{action}}",
"workflow.stepSleep": "等待 {{seconds}}s"
```

en.json 新增相应英文。

- [ ] **Step 3: Extend ActionRunnerProvider**

新增状态：
```ts
const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
const [workflowSteps, setWorkflowSteps] = useState<WorkflowStepState[]>([]);
```

`view` 类型扩展 `| "workflow"`。

挂载时调 `ListWorkflows()` 拉列表。

新增 `runWorkflow(id)` 方法：清空 steps，设 view="workflow"，订阅 `workflow:<id>:output` / `workflow:<id>:done` 事件，解析 step-start/step-done 帧更新 `workflowSteps` 状态，普通 stdout/stderr 追加到当前 step 的 lines。

新增 `cancelWorkflow()` 方法。

- [ ] **Step 4: Run frontend typecheck**

Run: `cd /Users/v_chenzhaojun/Documents/workflow-tool/frontend && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/context/ActionRunnerProvider.tsx frontend/src/types/events.ts frontend/src/i18n/locales/
git commit -m "feat(frontend): workflow state management in Provider"
```

---

### Task 6: 前端 UI — 侧边栏 Workflow Group + WorkflowView

**Files:**
- Create: `frontend/src/components/WorkflowItem.tsx`
- Create: `frontend/src/components/WorkflowView.tsx`
- Modify: `frontend/src/components/AppSidebar.tsx`
- Modify: `frontend/src/components/OutputPanel.tsx`

**Interfaces:**
- Consumes: `RunnerContextValue.workflows`、`RunnerContextValue.workflowSteps`、`RunnerContextValue.runWorkflow`
- Produces: 侧边栏新 group + 工具链输出视图

- [ ] **Step 1: Create WorkflowItem.tsx**

用 `SidebarMenuItem` / `SidebarMenuButton` / `ActionIcon` / `SidebarMenuBadge` 渲染。单击运行，运行中显 loading 旋转图标：

```tsx
// frontend/src/components/WorkflowItem.tsx
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading03Icon, Tick02Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import {
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
} from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";
import { ActionIcon } from "./ActionIcon";

interface WorkflowItemProps {
  workflow: { id: string; title: string; icon: string; description: string };
}

export function WorkflowItem({ workflow }: WorkflowItemProps) {
  const { currentId, status, view, runWorkflow } = useActionRunner();
  const isCurrent = currentId === workflow.id && view === "workflow";
  const running = isCurrent && status === "running";

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isCurrent}
        tooltip={workflow.description || workflow.title}
        onClick={() => runWorkflow(workflow.id)}
      >
        <ActionIcon name={workflow.icon || "hi:workflow"} className="shrink-0" />
        <span>{workflow.title}</span>
        {isCurrent && running && (
          <SidebarMenuBadge>
            <HugeiconsIcon icon={Loading03Icon} strokeWidth={1.75} className="size-3.5 animate-spin text-muted-foreground" />
          </SidebarMenuBadge>
        )}
        {isCurrent && status === "done" && (
          <SidebarMenuBadge>
            <HugeiconsIcon icon={Tick02Icon} strokeWidth={1.75} className="size-3.5 text-muted-foreground" />
          </SidebarMenuBadge>
        )}
        {isCurrent && status === "error" && (
          <SidebarMenuBadge>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.75} className="size-3.5 text-destructive" />
          </SidebarMenuBadge>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
```

- [ ] **Step 2: Modify AppSidebar.tsx — add Workflow group**

在 `<SidebarContent>` 中，现有 actions group 下方新增：

```tsx
<SidebarGroup>
  <SidebarGroupLabel>{t("sidebar.workflows")}</SidebarGroupLabel>
  <SidebarGroupContent>
    <SidebarMenu>
      {workflows.map((w) => (
        <WorkflowItem key={w.id} workflow={w} />
      ))}
    </SidebarMenu>
  </SidebarGroupContent>
</SidebarGroup>
```

- [ ] **Step 3: Create WorkflowView.tsx — 工具链 timeline + 分步输出**

用现有组件：`Card`、`Badge`、`Collapsible`/`CollapsibleTrigger`/`CollapsibleContent`、`ScrollArea`。每个 step 是一行 Item，点击可展开/折叠输出：

```tsx
// frontend/src/components/WorkflowView.tsx
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading03Icon, Tick02Icon, Cancel01Icon, Clock01Icon } from "@hugeicons/core-free-icons";
import { useActionRunner } from "../hooks/useActionRunner";

const STATUS_ICON = {
  pending: Clock01Icon,
  running: Loading03Icon,
  done: Tick02Icon,
  error: Cancel01Icon,
} as const;

export function WorkflowView() {
  const { t } = useTranslation();
  const { workflowSteps, status, cancelWorkflow } = useActionRunner();

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <span className="font-semibold">{t("sidebar.workflows")}</span>
        </div>
        <Button
          variant="destructive"
          size="sm"
          disabled={status !== "running"}
          onClick={cancelWorkflow}
        >
          {t("main.stop")}
        </Button>
      </header>
      <ScrollArea className="flex-1 p-4">
        <div className="flex flex-col gap-2">
          {workflowSteps.map((step) => (
            <Collapsible key={step.index} defaultOpen={step.status === "running" || step.status === "error"}>
              <Card className="p-0 overflow-hidden">
                <CollapsibleTrigger className="flex w-full items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-muted/50">
                  <HugeiconsIcon
                    icon={STATUS_ICON[step.status]}
                    strokeWidth={1.75}
                    className={`size-4 shrink-0 ${step.status === "running" ? "animate-spin text-primary" : step.status === "error" ? "text-destructive" : step.status === "done" ? "text-green-600" : "text-muted-foreground"}`}
                  />
                  <span className="text-sm font-medium flex-1 text-left">
                    {t("workflow.step", { index: step.index + 1 })}
                  </span>
                  <Badge variant={step.status === "error" ? "destructive" : step.status === "done" ? "secondary" : "outline"}>
                    {step.status}
                  </Badge>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {step.lines.length > 0 && (
                    <pre className="border-t bg-zinc-100 dark:bg-zinc-950 px-4 py-2 font-mono text-xs leading-relaxed text-zinc-900 dark:text-zinc-100 whitespace-pre-wrap max-h-48 overflow-auto">
                      {step.lines.join("\n")}
                    </pre>
                  )}
                </CollapsibleContent>
              </Card>
            </Collapsible>
          ))}
        </div>
      </ScrollArea>
    </main>
  );
}
```

- [ ] **Step 4: Modify OutputPanel.tsx — add workflow view branch**

在 `if (view === "edit")` 之前加：

```tsx
if (view === "workflow") {
  return <WorkflowView />;
}
```

- [ ] **Step 5: Run typecheck + lint**

Run: `cd /Users/v_chenzhaojun/Documents/workflow-tool/frontend && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 6: Full build**

Run:
```bash
cd /Users/v_chenzhaojun/Documents/workflow-tool
wails3 generate bindings
cd frontend && npm run build && cd ..
go build -o workflow-tool .
```
Expected: build success

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/WorkflowItem.tsx frontend/src/components/WorkflowView.tsx frontend/src/components/AppSidebar.tsx frontend/src/components/OutputPanel.tsx
git commit -m "feat(frontend): workflow sidebar group + timeline view"
```

---

## Self-Review Notes

1. **Spec coverage:** 侧边栏 Workflow group ✓；串行执行多个 runner ✓；CustomRunner(sleep) ✓；工具链展示+运行输出 ✓。
2. **Placeholder scan:** 无 TBD/TODO/implement later。
3. **Type consistency:** `WorkflowItem` 前后端对齐；`step-start`/`step-done` stream 值 executor 和前端事件处理一致；`Executor.Execute` 签名在 Task 3 定义、Task 4 调用一致。

