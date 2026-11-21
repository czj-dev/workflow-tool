# Workflow-Tool 内置定时调度器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 workflow-tool 增加内置定时调度器：`schedules.yaml` 声明 cron 档位，GUI 进程常驻时到点自动触发 action/workflow，输出走现有事件流——定时巡检任务（BG202/知识进化）在 UI 中实时可见，不再依赖 launchd 黑盒。

**Architecture:** 新增 `internal/schedule` 纯 Go 包（不依赖 Wails，可单测）：cron 5 字段匹配器 + `schedules.yaml` loader + Scheduler 触发循环（30s tick，按分钟去重）。main.go 组装：Scheduler 触发回调直接调 `api.Service.RunAction/RunWorkflow`（普通 Go 方法，复用全部事件流/并发簿记/参数展开），**internal/api 零改动**。UI 零改动（现有输出面板自动可见定时触发的输出）。

**Tech Stack:** Go 1.25 / gopkg.in/yaml.v3（已有）/ Wails v3（不新增依赖，不新增绑定，无需 `wails3 generate bindings`）。

## Global Constraints

- 不修改 `internal/api/*.go`、`internal/cli/*.go`、前端任何文件——定时触发必须经 `Service.RunAction/RunWorkflow` 现有入口，保证行为与手动点击完全一致。
- 不新增第三方依赖（yaml.v3、expr 均已存在）。
- cron 语义与系统 cron/launchd 一致：5 字段 `minute hour dom month dow`，dow 范围 0-6（周日=0）；支持 `*`、`n`、`a-b`、逗号列表 `a,b`；**不实现** `*/n` step、月份/星期名称（YAGNI）。
- 定时触发与手动触发共享同一把并发锁（`runRegistry.begin` 拒绝同 id 并发）——定时到点若同 id 正在跑，`RunAction` 返回错误，Scheduler 仅 log 记录，不排队（YAGNI）。
- 不做睡眠错过补跑（GUI 开着才触发；补跑语义复杂，文档注明局限）。
- 所有新代码遵循仓库既有风格：包注释说明意图、错误带上下文、单测均普通 Go 测试（`go test ./internal/schedule/...`）。

---

### Task 1: cron 5 字段匹配器

**Files:**
- Create: `internal/schedule/cron.go`
- Test: `internal/schedule/cron_test.go`

**Interfaces:**
- Produces: `ParseCron(s string) (*Cron, error)`；`(*Cron).Match(t time.Time) bool`；`Cron` 结构导出（Task 3 的 Scheduler 和 Task 2 的 loader 都依赖）。

- [ ] **Step 1: 写失败测试**

```go
package schedule

import (
	"testing"
	"time"
)

func TestParseCron(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		wantErr bool
	}{
		{"每分钟", "* * * * *", false},
		{"固定分钟", "7 10-19 * * 1-5", false},
		{"列表+范围混用", "3,7 12,18 * * 1-5", false},
		{"字段数不足", "7 10 * *", true},
		{"字段数过多", "7 10 * * 1-5 x", true},
		{"分钟越界", "60 * * * *", true},
		{"小时越界", "* 24 * * *", true},
		{"dow 越界", "* * * * 7", true},
		{"范围反向", "* * 31-1 * *", true},
		{"非法字符", "* * * * x", true},
		{"空串", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParseCron(tt.in)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ParseCron(%q) err=%v, wantErr=%v", tt.in, err, tt.wantErr)
			}
		})
	}
}

func TestCronMatch(t *testing.T) {
	at := func(y int, m time.Month, d, h, mi int, wd time.Weekday) time.Time {
		return time.Date(y, m, d, h, mi, 0, 0, time.Local)
	}
	tests := []struct {
		name string
		cron string
		t    time.Time
		want bool
	}{
		{"工作日 10-19 点 7 分命中", "7 10-19 * * 1-5", at(2026, time.November, 11, 10, 7, time.Wednesday), true},
		{"周日同时刻不命中", "7 10-19 * * 1-5", at(2026, time.November, 15, 10, 7, time.Sunday), false},
		{"周日 18 点不命中", "7 18 * * 1-5", at(2026, time.November, 15, 18, 7, time.Sunday), false},
		{"工作日 18 点 7 分命中", "7 18 * * 1-5", at(2026, time.November, 10, 18, 7, time.Tuesday), true},
		{"分钟不对不命中", "7 10-19 * * 1-5", at(2026, time.November, 11, 10, 8, time.Wednesday), false},
		{"小时界外不命中", "7 10-19 * * 1-5", at(2026, time.November, 11, 9, 7, time.Wednesday), false},
		{"每小时 7 分", "7 * * * *", at(2026, time.November, 11, 0, 7, time.Wednesday), true},
		{"月份限定", "0 0 1 6 *", at(2026, time.June, 1, 0, 0, time.Monday), true},
		{"月份限定不命中", "0 0 1 6 *", at(2026, time.July, 1, 0, 0, time.Wednesday), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, err := ParseCron(tt.cron)
			if err != nil {
				t.Fatalf("ParseCron err: %v", err)
			}
			if got := c.Match(tt.t); got != tt.want {
				t.Fatalf("%s.Match(%v) = %v, want %v", tt.cron, tt.t, got, tt.want)
			}
		})
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/schedule/ -run 'TestParseCron|TestCronMatch' -v`
Expected: 编译失败 `package schedule is not in std`（包不存在）——先建目录再跑：`mkdir -p internal/schedule && touch internal/schedule/cron.go && go test ./internal/schedule/ -run TestParseCron -v`，期待 FAIL（无 ParseCron）。

- [ ] **Step 3: 实现最小匹配器**

```go
// Package schedule 是 workflow-tool 的内置定时调度：解析 5 字段 cron、
// 加载 schedules.yaml、到点触发已注册的 action/workflow（复用 api 现有执行入口）。
// 纯 Go、不依赖 Wails，全部逻辑可单测。
package schedule

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// field 是 cron 单字段的匹配集。any 为 true 时匹配一切（*）；
// 否则在 vals 集合中查值（范围/列表解析时展开填充）。
type field struct {
	any  bool
	vals map[int]bool
}

func (f field) match(v int) bool {
	if f.any {
		return true
	}
	return f.vals[v]
}

// fieldSpecs 定义 5 字段的合法取值范围（minute/hour/dom/month/dow 顺序）。
var fieldSpecs = [5][2]int{{0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 6}}

// parseFieldToken 解析单个 token（"*"、数字、"a-b"），展开到 vals。
func parseFieldToken(tok string, lo, hi int, vals map[int]bool) error {
	if tok == "*" {
		for v := lo; v <= hi; v++ {
			vals[v] = true
		}
		return nil
	}
	if i := strings.IndexByte(tok, '-'); i >= 0 {
		a, err1 := strconv.Atoi(tok[:i])
		b, err2 := strconv.Atoi(tok[i+1:])
		if err1 != nil || err2 != nil || a < lo || b > hi || a > b {
			return fmt.Errorf("范围 %q 非法（%d-%d）", tok, lo, hi)
		}
		for v := a; v <= b; v++ {
			vals[v] = true
		}
		return nil
	}
	n, err := strconv.Atoi(tok)
	if err != nil || n < lo || n > hi {
		return fmt.Errorf("值 %q 非法（%d-%d）", tok, lo, hi)
	}
	vals[n] = true
	return nil
}

// parseField 解析逗号分隔的单字段（如 "3,7"、"10-19"、"*"）。
func parseField(s string, lo, hi int) (field, error) {
	f := field{vals: map[int]bool{}}
	for _, tok := range strings.Split(s, ",") {
		if tok == "*" {
			f.any = true
			continue
		}
		if err := parseFieldToken(tok, lo, hi, f.vals); err != nil {
			return field{}, err
		}
	}
	return f, nil
}

// Cron 是一个已解析的 5 字段 cron 表达式。
type Cron struct {
	minute, hour, dom, month, dow field
}

// ParseCron 解析 "minute hour dom month dow" 五字段（与系统 cron 语义一致）。
func ParseCron(s string) (*Cron, error) {
	parts := strings.Fields(s)
	if len(parts) != 5 {
		return nil, fmt.Errorf("cron 须 5 字段，得到 %d 个: %q", len(parts), s)
	}
	c := &Cron{}
	specs := []*field{&c.minute, &c.hour, &c.dom, &c.month, &c.dow}
	for i, spec := range specs {
		f, err := parseField(parts[i], fieldSpecs[i][0], fieldSpecs[i][1])
		if err != nil {
			return nil, fmt.Errorf("cron 第 %d 字段: %w", i+1, err)
		}
		*spec = f
	}
	return c, nil
}

// Match 判断 t 是否落在该 cron 的命中时刻（时间仅取分钟粒度）。
func (c *Cron) Match(t time.Time) bool {
	return c.minute.match(t.Minute()) &&
		c.hour.match(t.Hour()) &&
		c.dom.match(t.Day()) &&
		c.month.match(int(t.Month())) &&
		c.dow.match(int(t.Weekday()))
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `go test ./internal/schedule/ -run 'TestParseCron|TestCronMatch' -v`
Expected: PASS（全部用例绿）

- [ ] **Step 5: Commit**

```bash
git add internal/schedule/cron.go internal/schedule/cron_test.go
git commit -m "feat: add 5-field cron matcher for built-in scheduler"
```

---

### Task 2: schedules.yaml loader 与校验

**Files:**
- Create: `internal/schedule/loader.go`
- Test: `internal/schedule/loader_test.go`
- Create: `schedules.yaml`（仅空壳 `schedules: []`，Task 4 填真实条目）

**Interfaces:**
- Consumes: `ParseCron`（Task 1）
- Produces: `Schedule` 结构（`ID/Cron *Cron/CronStr/Action/Workflow/Params`，`Cron` 为已解析指针）；`Load(path string, knownIDs map[string]bool) ([]Schedule, error)`——knownIDs 为可引用的 action/workflow id 全集，用于引用校验。

- [ ] **Step 1: 写失败测试**

```go
package schedule

import (
	"os"
	"path/filepath"
	"testing"
)

func writeYaml(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "schedules.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoad(t *testing.T) {
	known := map[string]bool{"bg202-patrol": true, "skill-review": true}

	t.Run("空文件返回空", func(t *testing.T) {
		path := writeYaml(t, "schedules: []\n")
		got, err := Load(path, known)
		if err != nil || len(got) != 0 {
			t.Fatalf("got %v, err %v", got, err)
		}
	})

	t.Run("合法条目解析", func(t *testing.T) {
		yamlText := `schedules:
  - id: skill-review-1203
    cron: "3 12 * * 1-5"
    action: skill-review
  - id: bg202-hourly
    cron: "7 10-19 * * 1-5"
    workflow: skill-review
    params:
      echo: hi
`
		path := writeYaml(t, yamlText)
		got, err := Load(path, known)
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if len(got) != 2 {
			t.Fatalf("want 2, got %d", len(got))
		}
		if got[0].ID != "skill-review-1203" || got[0].Action != "skill-review" || got[0].Cron == nil {
			t.Fatalf("bad first: %+v", got[0])
		}
		if got[1].Workflow != "skill-review" || got[1].Params["echo"] != "hi" {
			t.Fatalf("bad second: %+v", got[1])
		}
	})

	t.Run("文件不存在报错", func(t *testing.T) {
		_, err := Load(filepath.Join(t.TempDir(), "nope.yaml"), known)
		if err == nil {
			t.Fatal("want err for missing file")
		}
	})

	t.Run("id 重复报错", func(t *testing.T) {
		path := writeYaml(t, "schedules:\n  - id: a\n    cron: \"* * * * *\"\n    action: bg202-patrol\n  - id: a\n    cron: \"* * * * *\"\n    action: bg202-patrol\n")
		if _, err := Load(path, known); err == nil {
			t.Fatal("want duplicate id err")
		}
	})

	t.Run("cron 非法报错", func(t *testing.T) {
		path := writeYaml(t, "schedules:\n  - id: a\n    cron: \"99 * * * *\"\n    action: bg202-patrol\n")
		if _, err := Load(path, known); err == nil {
			t.Fatal("want bad cron err")
		}
	})

	t.Run("action 与 workflow 都有或都无报错", func(t *testing.T) {
		p1 := writeYaml(t, "schedules:\n  - id: a\n    cron: \"* * * * *\"\n    action: bg202-patrol\n    workflow: skill-review\n")
		if _, err := Load(p1, known); err == nil {
			t.Fatal("want both-set err")
		}
		p2 := writeYaml(t, "schedules:\n  - id: b\n    cron: \"* * * * *\"\n")
		if _, err := Load(p2, known); err == nil {
			t.Fatal("want none-set err")
		}
	})

	t.Run("引用不存在的 action 报错", func(t *testing.T) {
		path := writeYaml(t, "schedules:\n  - id: a\n    cron: \"* * * * *\"\n    action: not-exist\n")
		if _, err := Load(path, known); err == nil {
			t.Fatal("want unknown id err")
		}
	})
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/schedule/ -run TestLoad -v`
Expected: FAIL（无 Load）

- [ ] **Step 3: 实现 loader**

```go
package schedule

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// Schedule 是 schedules.yaml 的一条定时触发声明：Cron 为已解析的表达式，
// Action 与 Workflow 恰一非空（Params 原样传给 RunAction/RunWorkflow，
// ${VAR} 由现有执行路径展开——本包不负责变量替换）。
type Schedule struct {
	ID       string
	Cron     *Cron
	CronStr  string
	Action   string
	Workflow string
	Params   map[string]any
}

// schedulesFile 是 schedules.yaml 的磁盘结构。
type schedulesFile struct {
	Schedules []struct {
		ID       string         `yaml:"id"`
		Cron     string         `yaml:"cron"`
		Action   string         `yaml:"action,omitempty"`
		Workflow string         `yaml:"workflow,omitempty"`
		Params   map[string]any `yaml:"params,omitempty"`
	} `yaml:"schedules"`
}

// Load 解析并校验 schedules.yaml。knownIDs 是当前可引用的 action/workflow id 全集
//（registry 与 workflow registry 的并集），引用不在集合中的 id 报错。
func Load(path string, knownIDs map[string]bool) ([]Schedule, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取 %s: %w", path, err)
	}
	var file schedulesFile
	if err := yaml.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("解析 %s: %w", path, err)
	}
	out := make([]Schedule, 0, len(file.Schedules))
	seen := map[string]bool{}
	for i, s := range file.Schedules {
		if s.ID == "" {
			return nil, fmt.Errorf("第 %d 条 schedule 缺少 id", i+1)
		}
		if seen[s.ID] {
			return nil, fmt.Errorf("schedule id %q 重复", s.ID)
		}
		seen[s.ID] = true
		c, err := ParseCron(s.Cron)
		if err != nil {
			return nil, fmt.Errorf("schedule %q: %w", s.ID, err)
		}
		if (s.Action == "") == (s.Workflow == "") {
			return nil, fmt.Errorf("schedule %q: action 与 workflow 必须恰一非空", s.ID)
		}
		target := s.Action
		if target == "" {
			target = s.Workflow
		}
		if !knownIDs[target] {
			return nil, fmt.Errorf("schedule %q 引用未知 id %q", s.ID, target)
		}
		out = append(out, Schedule{
			ID:       s.ID,
			Cron:     c,
			CronStr:  s.Cron,
			Action:   s.Action,
			Workflow: s.Workflow,
			Params:   s.Params,
		})
	}
	return out, nil
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `go test ./internal/schedule/ -run TestLoad -v`
Expected: PASS

- [ ] **Step 5: 创建空壳 schedules.yaml 并 Commit**

Create `schedules.yaml`（项目根，与 config.yaml 同级）:
```yaml
schedules: []
```

```bash
git add internal/schedule/loader.go internal/schedule/loader_test.go schedules.yaml
git commit -m "feat: add schedules.yaml loader with reference validation"
```

---

### Task 3: Scheduler 触发循环（分钟去重）

**Files:**
- Create: `internal/schedule/scheduler.go`
- Test: `internal/schedule/scheduler_test.go`

**Interfaces:**
- Consumes: `Schedule`（Task 2）
- Produces: `TriggerFunc func(Schedule) error`；`New(schedules []Schedule, trigger TriggerFunc) *Scheduler`；`(*Scheduler).Check(now time.Time) []Schedule`（纯函数，可注入时间）；`(*Scheduler).Run(ctx context.Context, tick time.Duration)`（ticker 循环，Task 4 的 main.go 调用）。

- [ ] **Step 1: 写失败测试**

```go
package schedule

import (
	"context"
	"testing"
	"time"
)

func mustParse(t *testing.T, cron string) *Cron {
	t.Helper()
	c, err := ParseCron(cron)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestCheckMinuteDedup(t *testing.T) {
	scheds := []Schedule{
		{ID: "a", Cron: mustParse(t, "* * * * *"), Action: "act-a"},
		{ID: "b", Cron: mustParse(t, "* * * * *"), Action: "act-b"},
	}
	s := New(scheds, func(Schedule) error { return nil })
	now := time.Date(2026, time.November, 11, 10, 7, 0, 0, time.Local)

	if got := s.Check(now); len(got) != 2 {
		t.Fatalf("首次检查应触发 2 条，得到 %d", len(got))
	}
	// 同一分钟内第二次检查（30s tick 场景）不重复触发
	if got := s.Check(now.Add(30 * time.Second)); len(got) != 0 {
		t.Fatalf("同分钟应去重，得到 %d", len(got))
	}
	// 下一分钟重新触发
	if got := s.Check(now.Add(time.Minute)); len(got) != 2 {
		t.Fatalf("下一分钟应重新触发，得到 %d", len(got))
	}
}

func TestCheckCronFilter(t *testing.T) {
	scheds := []Schedule{
		{ID: "a", Cron: mustParse(t, "7 18 * * 1-5"), Action: "act-a"},
	}
	s := New(scheds, func(Schedule) error { return nil })
	in := time.Date(2026, time.November, 10, 18, 7, 0, 0, time.Local)
	out := time.Date(2026, time.November, 10, 18, 8, 0, 0, time.Local)
	if got := s.Check(in); len(got) != 1 {
		t.Fatalf("18:07 应触发，得到 %d", len(got))
	}
	if got := s.Check(out); len(got) != 0 {
		t.Fatalf("18:08 不应触发，得到 %d", len(got))
	}
}

func TestRunTicksAndTriggers(t *testing.T) {
	fired := make(chan Schedule, 4)
	s := New([]Schedule{{ID: "a", Cron: mustParse(t, "* * * * *"), Action: "act-a"}},
		func(sc Schedule) error { fired <- sc; return nil })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx, 20*time.Millisecond)
	select {
	case sc := <-fired:
		if sc.ID != "a" {
			t.Fatalf("触发条目 id=%q", sc.ID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run 未触发（2s 超时）")
	}
}

func TestRunTriggerErrorLogged(t *testing.T) {
	s := New([]Schedule{{ID: "a", Cron: mustParse(t, "* * * * *"), Action: "act-a"}},
		func(Schedule) error { return nil })
	now := time.Date(2026, time.November, 11, 10, 7, 0, 0, time.Local)
	_ = s.Check(now) // 触发一次，error= nil 分支走通即可（log 由 Run 内处理，此处仅确保不 panic）
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/schedule/ -run 'TestCheck|TestRun' -v`
Expected: FAIL（无 New/Check/Run）

- [ ] **Step 3: 实现 Scheduler**

```go
package schedule

import (
	"context"
	"log"
	"time"
)

// TriggerFunc 由调用方（main.go）注入：把 Schedule 转发给现有执行入口
// （api.Service.RunAction / RunWorkflow），错误原样返回供 Scheduler 记录。
type TriggerFunc func(s Schedule) error

// Scheduler 持有全部 schedule 定义并按分钟检查触发。触发语义：
//   - Check 是纯函数（now 注入），同一分钟每个 id 至多触发一次（30s tick 去重）；
//   - 触发失败仅 log，不重试不排队（与手动点击共用 runRegistry 的并发拒绝）。
//   - 不补跑睡眠错过期间的任务（GUI 开着才检查；跨分钟错过即跳过）。
type Scheduler struct {
	schedules []Schedule
	trigger   TriggerFunc
	lastFired map[string]string // id → 已触发分钟 key（2006-01-02 15:04）
}

// New 创建 Scheduler。schedules 须已通过 Load 校验（Cron 非 nil）。
func New(schedules []Schedule, trigger TriggerFunc) *Scheduler {
	return &Scheduler{
		schedules: schedules,
		trigger:   trigger,
		lastFired: map[string]string{},
	}
}

// Check 返回 now 时刻应触发的条目（已按分钟去重）。纯函数、可单测。
func (s *Scheduler) Check(now time.Time) []Schedule {
	key := now.Format("2006-01-02 15:04")
	var out []Schedule
	for _, sc := range s.schedules {
		if sc.Cron == nil {
			continue
		}
		if sc.Cron.Match(now) && s.lastFired[sc.ID] != key {
			s.lastFired[sc.ID] = key
			out = append(out, sc)
		}
	}
	return out
}

// Run 每 tick 间隔检查一次，触发命中的 schedule，直至 ctx 取消。
// tick 建议 30s（Check 内按分钟去重，30s 粒度既及时又无重复执行风险）。
func (s *Scheduler) Run(ctx context.Context, tick time.Duration) {
	t := time.NewTicker(tick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for _, sc := range s.Check(time.Now()) {
				if err := s.trigger(sc); err != nil {
					log.Printf("[schedule] %s 触发失败: %v", sc.ID, err)
				} else {
					log.Printf("[schedule] %s 已触发 (cron=%s → %s)", sc.ID, sc.CronStr, target(sc))
				}
			}
		}
	}
}

func target(s Schedule) string {
	if s.Action != "" {
		return "action:" + s.Action
	}
	return "workflow:" + s.Workflow
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `go test ./internal/schedule/ -v`
Expected: PASS（含 Task 1/2 全部用例）

- [ ] **Step 5: Commit**

```bash
git add internal/schedule/scheduler.go internal/schedule/scheduler_test.go
git commit -m "feat: add scheduler trigger loop with per-minute dedup"
```

---

### Task 4: main.go 接入 + schedules.yaml 真实条目 + 集成验证

**Files:**
- Modify: `main.go`（加 import 与启动段）
- Modify: `schedules.yaml`（填两条巡检条目，Task 5 落地 action 后可再加入）
- Create: `schedules.example.yaml`（可选示例，与 README 文档 Task 6 配套）

**Interfaces:**
- Consumes: `schedule.Load`（Task 2）、`schedule.New/Run`（Task 3）、`api.Service.RunAction/RunWorkflow`（现有）
- Produces: 无新导出——main.go 组装完成，GUI 启动即开始调度。

- [ ] **Step 1: main.go 接入**

在 `main.go` 的 import 块加：
```go
	"context"
	"time"

	"workflow-tool/internal/schedule"
```

在 `svc.SetApp(app)` 之后、`window := app.Window.NewWithOptions(...)` 之前插入：

```go
	// 内置定时调度：启动时加载 schedules.yaml，GUI 常驻期间到点触发 action/workflow。
	// 输出复用 RunAction/RunWorkflow 的事件流——定时任务与手动点击同等可见。
	schedPath := filepath.Join(baseDir, "schedules.yaml")
	known := make(map[string]bool, len(reg.Actions)+len(wfReg.Workflows))
	for id := range reg.Actions {
		known[id] = true
	}
	for id := range wfReg.Workflows {
		known[id] = true
	}
	if scheds, err := schedule.Load(schedPath, known); err != nil {
		log.Printf("[schedule] 加载 %s 失败（定时调度停用）: %v", schedPath, err)
	} else if len(scheds) > 0 {
		sched := schedule.New(scheds, func(sc schedule.Schedule) error {
			if sc.Action != "" {
				return svc.RunAction(sc.Action, sc.Params)
			}
			return svc.RunWorkflow(sc.Workflow, sc.Params)
		})
		ctx, cancel := context.WithCancel(context.Background())
		go sched.Run(ctx, 30*time.Second)
		app.OnShutdown(func() { cancel() })
		log.Printf("[schedule] 已加载 %d 条定时任务", len(scheds))
	}
```

> **说明**：`app.OnShutdown` 是 Wails v3 的 `application.App` 方法（窗口全关时回调）——若编译报无此方法，改用 `defer cancel()` 语义不可行（main 不阻塞），则退而接受 goroutine 随进程退出回收（注释注明原因）。

- [ ] **Step 2: 编译验证**

Run: `go build ./...`
Expected: 编译通过（Wails 绑定无需重新生成——未改任何 Service 方法签名）

- [ ] **Step 3: schedules.yaml 填两条**

```yaml
schedules:
  - id: skill-review-1203
    cron: "3 12 * * 1-5"
    action: skill-review
  - id: skill-review-1807
    cron: "7 18 * * 1-5"
    action: skill-review
```

> 注意：此刻 `skill-review` action 尚未存在（Task 5 创建），**先跑 Step 4 的手工验证用临时条目，再改回这两条**；或临时改为 `cron: "*/..."` 不支持的写法不可用——验证用「当前时刻的固定分钟」生成一条一次性条目。

- [ ] **Step 4: 集成验证（手动）**

1. 生成一条 1 分钟后触发的临时条目（验证用，用系统时间动态构造）：
```bash
MIN=$(( ($(date +%M) + 1) % 60 )); HOUR=$(date +%H)
python3 - <<PY
import yaml
yaml.safe_dump({"schedules": [{"id": "verify-now", "cron": "$MIN $HOUR * * *", "action": "shell-demo"}]}, open("schedules.yaml", "w"))
PY
```
2. 确认 `actions/shell-demo.yaml` 存在（无则创建一个 `command.run: echo "schedule fired at \$(date)"` 的动作）。
3. Run: `bash deploy/build.sh && ./workflow-tool`
4. 等到点后观察：GUI 输出面板出现 `shell-demo` 的输出流；终端日志出现 `[schedule] verify-now 已触发`。
Expected: 两者同时可见（**这是"定时任务 UI 可见"的验收点**）
5. 还原 schedules.yaml 为 Step 3 内容。

- [ ] **Step 5: Commit**

```bash
git add main.go schedules.yaml
git commit -m "feat: wire built-in scheduler into main (30s tick, event-driven visible runs)"
```

---

### Task 5: 巡检 LLM action 落地（生成式提取 prompt）

**Files:**
- Create: `actions/bg202-patrol.yaml`
- Create: `actions/skill-review.yaml`
- Modify: `schedules.yaml`（补 BG202 小时档）

**Interfaces:**
- Consumes: `command.llm` 形态（现有 actionrun.LLMRunner，ducc CLI 自带配置）；`skills` 同步（现有 SkillRouter）
- Produces: `bg202-patrol`、`skill-review` 两个可被 schedule 引用的 action id。

- [ ] **Step 1: 生成式创建 action（prompt 自 json 单源提取）**

以下脚本从 `~/.claude/scheduled_tasks.json`（项目 .claude 下，任务 prompt 的单一真相源）提取 prompt，生成两个 LLM action。在 workflow-tool 项目根执行：

```bash
python3 <<'PY'
import json, os
# 单一真相源：项目级 scheduled_tasks.json（launchd 兜底方案同源）
src = os.path.expanduser("~/Project/baidu/asd-edc/xdzs-speech/.claude/scheduled_tasks.json")
tasks = {t["id"]: t["prompt"] for t in json.load(open(src))["tasks"]}

bg202 = tasks["25a1ad35"]   # BG202 巡检
review = tasks["0dbe931a"]  # 知识巡检（12/18 档 prompt 相同）

def yaml_llm_action(fid, title, prompt, skills):
    # params 用 textarea 承载 prompt，default 为任务全文（用户可在表单查看/修改）
    return f"""id: {fid}
title: {title}
command:
  llm:
    prompt: task_prompt
    skills:
{chr(10).join('      - %s' % s for s in skills)}
params:
  - id: task_prompt
    type: textarea
    label: 任务流程
    default: |
{prompt.replace(chr(10), chr(10) + '        ')}
"""

open("actions/bg202-patrol.yaml", "w").write(
    yaml_llm_action("bg202-patrol", "BG202 语音Bug巡检", bg202, ["voice-bug-analyzer"]))
open("actions/skill-review.yaml", "w").write(
    yaml_llm_action("skill-review", "SKILL 知识进化巡检", review,
                    ["voice-bug-analyzer", "xdzs-speech-patterns"]))
print("已生成 actions/bg202-patrol.yaml / actions/skill-review.yaml")
PY
```

- [ ] **Step 2: 校验 action 可加载**

Run: `go test ./internal/registry/ -run TestRegistry -v 2>&1 | tail -5`（registry 单测会加载 actions/ 全部 yaml）
Expected: PASS（新 yaml 通过 schema 校验；若校验失败按现有字段约定修复——参考 `docs/action.md` LLM 域形态章节）

- [ ] **Step 3: schedules.yaml 补 BG202 小时档**

```yaml
schedules:
  - id: skill-review-1203
    cron: "3 12 * * 1-5"
    action: skill-review
  - id: skill-review-1807
    cron: "7 18 * * 1-5"
    action: skill-review
  - id: bg202-hourly
    cron: "7 10-19 * * 1-5"
    action: bg202-patrol
```

- [ ] **Step 4: 集成验证（手动，GUI）**

```bash
bash deploy/build.sh && ./workflow-tool
```
在 GUI 中点击 `BG202 语音Bug巡检` 卡片，观察：聊天页流式输出 + 工序轨道面板出现 iCafe 查询工具调用（skill 同步行 `[skill-sync]` 也应出现）。
Expected: 工具调用轨道可见——**这是"观察输入输出"目标的落地验收**。

- [ ] **Step 5: Commit**

```bash
git add actions/bg202-patrol.yaml actions/skill-review.yaml schedules.yaml
git commit -m "feat: onboard BG202 and skill-review patrol as schedulable LLM actions"
```

---

### Task 6: 文档与 launchd 退役决策点

**Files:**
- Create: `docs/schedule.md`
- Modify: `CLAUDE.md`（架构小节补 `internal/schedule` 与文件清单两行）
- Modify: `README.md`（核心特性补「内置定时调度」一行）

**Interfaces:**
- Consumes: 前 5 个 Task 的全部产出
- Produces: 运维文档

- [ ] **Step 1: docs/schedule.md**

```markdown
# 定时调度（schedules.yaml）

workflow-tool 内置定时调度器：GUI 常驻期间，按 cron 档位自动触发 action/workflow。
**局限**：仅 GUI 运行时触发；机器睡眠/macOS 睡眠错过不补跑（与 launchd 方案互补，
launchd 支持唤醒补跑，但输出不可在 UI 观察）。

## 语法

```yaml
schedules:
  - id: skill-review-1203        # 唯一
    cron: "3 12 * * 1-5"        # 5 字段：minute hour dom month dow（dow 0-6，周日=0）
    action: skill-review        # 引用 actions/*.yaml 的 id（与 workflow 恰一）
    # workflow: my-wf          # 或引用 workflows/*.yaml 的 id
    params: {}                  # 可选，原样传给 RunAction/RunWorkflow（${VAR} 照常展开）
```

支持：`*`、`n`、`a-b`、逗号列表 `a,b`。不支持：`*/n` step、名称别名。
触发语义：30s tick 检查、按分钟去重、同 id 运行中拒绝（与手动点击共享并发锁）、失败仅日志。
```

- [ ] **Step 2: CLAUDE.md / README.md 更新**

CLAUDE.md「架构」小节 after `internal/workflow/` 行后加：

```
internal/schedule/ 内置定时调度：cron 5 字段匹配器 + schedules.yaml loader + 30s tick 触发循环
                    （纯 Go 不依赖 Wails；TriggerFunc 由 main 接 api.RunAction/RunWorkflow，零改 api）
```

架构小节文件清单行补 `schedules.yaml`（与 config.yaml 同级的扫描约定）。

README.md 核心特性列表补：`- **内置定时调度**：\`schedules.yaml\` 声明 cron 档位，GUI 常驻期间到点自动触发 action/workflow，输出与手动点击同等可见（睡眠错过不补跑，见 docs/schedule.md）`

- [ ] **Step 3: launchd 退役（决策点——执行前须用户确认）**

若用户确认以 workflow-tool 内置调度为主，退役现有 launchd 兜底（防双触发）：
```bash
launchctl bootout "gui/$(id -u)/com.ducc.skill-review-1203"
launchctl bootout "gui/$(id -u)/com.ducc.skill-review-1807"
launchctl bootout "gui/$(id -u)/com.ducc.skill-review-bg202"
rm ~/Library/LaunchAgents/com.ducc.skill-review-*.plist
rm ~/.ducc/gen_launchagents.py   # 生成器一并退役
```
> 只删 agent；保留 `skill-review-run.sh` + `claude-headless.json` + `auth_token`（手动补跑/排障仍可用）。

- [ ] **Step 4: 全量回归**

Run: `go test ./...`
Expected: 全绿（新包 + 既有包均通过）

- [ ] **Step 5: Commit**

```bash
git add docs/schedule.md CLAUDE.md README.md
git commit -m "docs: document built-in scheduler and patrol onboarding"
```

---

## Self-Review

**Spec coverage:**
- 定时触发 action/workflow（GUI 内、cron 档位、分钟去重）→ Task 1-4
- 巡检任务落地（BG202/知识巡检 LLM action + 3 条 schedule）→ Task 5
- UI 可见性（事件流复用，零前端改动）→ Task 4 Step 4 + Task 5 Step 4 两处验收点
- 文档 → Task 6
- launchd 退役（防双触发）→ Task 6 Step 3（用户确认决策点）
- 局限记录（睡眠不补跑/LLM CLI v1 禁止已由架构绕过——scheduler 走 GUI 内 RunAction 不经 cli）→ docs/schedule.md 与 Global Constraints

**Placeholder scan:** 无 TBD/TODO；所有代码步骤含完整代码；Task 5 的 prompt 提取为可执行命令（prompt 全文 1600 字符不宜手抄，生成式提取保真且维持 json 单源）。Task 4 Step 3 注明了「临时条目验证后再还原」的操作顺序（已给命令）。

**Type consistency:** `Schedule`（ID/Cron/CronStr/Action/Workflow/Params）在 Task 2 定义、Task 3/4 引用一致；`TriggerFunc` Task 3 定义 Task 4 使用；`Load(path, knownIDs)` 签名跨 Task 一致；`Run(ctx, tick)` 签名一致。