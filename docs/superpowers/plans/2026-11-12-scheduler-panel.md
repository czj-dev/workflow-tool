# Scheduler Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 workflow-tool 中实现一个不绑定 LLM 的通用定时任务面板，支持配置、查看、启停、立即执行和删除 Cron 任务，并定时执行 action 或 workflow。

**Architecture:** 新增纯 Go `internal/schedule` 域，负责五字段 Cron 解析、配置模型、文件读写和 30 秒调度 tick；它只通过注入的 `TriggerFunc` 触发目标，不依赖 Wails 或 `internal/api`。`internal/api.Service` 持有 `schedules.yaml`、调度器和当前进程内的最近运行状态，所有调度执行都转发到现有 `RunAction` / `RunWorkflow` 内部路径，以复用参数展开、运行锁、取消和输出事件。React 端由 `ActionRunnerProvider` 管理 Scheduler API 与状态事件，`SchedulerView` 按已确认的 A 版运维表格布局渲染，并且入口只位于侧边栏 Config 分组。

**Tech Stack:** Go、`gopkg.in/yaml.v3`、Wails v3 `alpha2.119`、React 19、TypeScript、Vite、Tailwind 4、现有 shadcn/base-ui 组件、Vitest、Testing Library。

## Global Constraints

- Scheduler 不绑定 LLM；LLM 只是可被调度的 action 形态之一。
- Scheduler 只支持 `action` 和 `workflow` 两类目标。
- Scheduler 入口只放在侧边栏 `Config` 分组，不放入 Actions、Workflows 或 AI Chat 分组。
- `schedules.yaml` 是调度配置的持久化真相源；文件不存在时按空列表启动，首次保存时创建。
- 最近一次运行状态只保存在当前 GUI 进程内；进程重启后无运行记录时显示“未执行”。
- 调度 tick 为 30 秒；同一任务同一分钟只触发一次。
- GUI 睡眠期间错过的任务不补跑。
- 调度到点遇到同一 action/workflow 正在运行时不排队，记录启动失败并继续处理其他任务。
- 文件写入失败时不得替换当前有效内存配置。
- 所有 schedule ID、名称、Cron、目标引用和参数必须在后端校验；非法输入不得落盘。
- 不退役现有 launchd，除非另行确认。
- 不手动编辑生成的 Wails bindings；修改 Service 方法后运行 `wails3 generate bindings`。
- 正式 React 实现不得复制原型的 `innerHTML` 用户输入渲染模式；原型文件 `frontend/public/scheduler-prototype.html` 仅作为视觉参考。
- 遵循仓库现有不可变数据约定；状态更新返回新值，不就地修改共享对象或数组。
- 不新增 Cron 或状态管理依赖；使用标准库和仓库已有依赖完成实现。
- 不执行 `git commit`、`git push`、分支或 worktree 操作，本计划只覆盖代码、测试、文档和构建验证。

---

## 文件结构与职责

### 新建文件

- `internal/schedule/model.go`：调度定义、目标类型和触发接口等纯 Go 数据模型。
- `internal/schedule/cron.go`：五字段 Cron 解析、范围边界、匹配和下次时间计算。
- `internal/schedule/store.go`：`schedules.yaml` 的读取、校验、原子写入和序列化。
- `internal/schedule/scheduler.go`：30 秒 tick、分钟去重、启用过滤、错过不补跑和注入触发器。
- `internal/schedule/cron_test.go`：Cron 解析和匹配测试。
- `internal/schedule/store_test.go`：YAML 默认值、互斥字段和持久化失败保护测试。
- `internal/schedule/scheduler_test.go`：tick、去重、禁用、启动失败和不排队测试。
- `internal/api/schedules.go`：Scheduler Wails DTO、CRUD、引用校验、列表投影和状态事件。
- `frontend/src/components/SchedulerView.tsx`：A 版表格、筛选、搜索和编辑抽屉。
- `frontend/src/components/SchedulerView.test.tsx`：Scheduler 面板行为测试。

### 修改文件

- `internal/api/api.go`：Service 增加 schedule 文件路径、store/runtime、运行状态和取消句柄；在构造及 App 生命周期中启动/停止调度器。
- `internal/api/run.go`：抽取 action 内部启动路径，增加可选 schedule source，并在执行完成或提前失败时更新 schedule 最近结果。
- `internal/api/workflows.go`：让 workflow 内部启动路径接受可选 schedule source，并把完成结果回传给 Service。
- `internal/api/events.go`：集中定义 `schedules:changed` 状态事件 payload 和发送辅助方法。
- `main.go`：若 Service 生命周期需要显式 shutdown 注入，仅补充已有 Service/App 组装，不把调度器放回 main 局部变量。
- `frontend/src/context/ActionRunnerProvider.tsx`：增加 Scheduler DTO 导入、列表状态、CRUD 方法和 `schedules:changed` 事件订阅。
- `frontend/src/components/OutputPanel.tsx`：增加 `scheduler` view 分支。
- `frontend/src/components/AppSidebar.tsx`：在 Config 分组加入 Scheduler 入口。
- `frontend/src/types/events.ts`：增加 Scheduler 状态事件类型并与 Go DTO 对齐。
- `frontend/src/i18n/locales/zh.json`、`frontend/src/i18n/locales/en.json`：增加完整 Scheduler 文案，保持 key 集合一致。
- `frontend/src/context/ActionRunnerProvider.test.tsx`：补充 Scheduler bindings 和事件状态测试。
- `docs/action.md`：说明 action 可被 `schedules.yaml` 作为调度目标引用，参数值遵循现有参数协议。
- `docs/workflow.md`：说明 workflow 可被 `schedules.yaml` 调度，以及运行参数来源。
- `docs/schedule.md`：记录 schedules.yaml 格式、Cron 语法、生命周期和限制。
- Wails 生成目录 `frontend/bindings/`：通过 `wails3 generate bindings` 自动更新，禁止手工编辑。

---

### Task 1: 建立纯 Go Scheduler 域模型与 Cron 引擎

**Files:**
- Create: `internal/schedule/model.go`
- Create: `internal/schedule/cron.go`
- Test: `internal/schedule/cron_test.go`

**Interfaces:**
- Produces `schedule.Definition`，字段为 `ID string`、`Name string`、`Enabled bool`、`Cron string`、`Action string`、`Workflow string`、`Params map[string]any`。
- Produces `schedule.TargetKind`，取值 `"action"` 或 `"workflow"`。
- Produces `schedule.Target()`，返回 `(TargetKind, string, error)`，要求 action/workflow 恰好存在一个。
- Produces `schedule.Parse(expr string) (Cron, error)`、`Cron.Matches(time.Time) bool` 和 `Cron.NextAfter(time.Time) (time.Time, bool)`。
- `Cron.NextAfter` 只在未来一年内按分钟扫描，避免无界循环；不支持 `*/n`、月份名称和星期名称。

- [ ] **Step 1: 编写失败测试，锁定 Cron 支持范围**

在 `cron_test.go` 覆盖以下行为：

```go
func TestParseAndMatch(t *testing.T) {
    cron, err := Parse("7 10-19 * * 1-5")
    if err != nil { t.Fatal(err) }
    if !cron.Matches(time.Date(2026, 11, 13, 10, 7, 0, 0, time.Local)) {
        t.Fatal("expected Friday 10:07 to match")
    }
    if cron.Matches(time.Date(2026, 11, 14, 10, 7, 0, 0, time.Local)) {
        t.Fatal("expected Saturday 10:07 not to match")
    }
}

func TestParseSupportsListsAndRanges(t *testing.T) {
    cron, err := Parse("3,7 10-19 1-5 1,6,12 1-5")
    if err != nil { t.Fatal(err) }
    if !cron.Matches(time.Date(2026, 12, 3, 10, 7, 0, 0, time.Local)) {
        t.Fatal("expected listed minute/month to match")
    }
}

func TestParseRejectsUnsupportedStepAndInvalidBounds(t *testing.T) {
    for _, expr := range []string{"*/5 * * * *", "60 * * * *", "0 24 * * *", "0 * * Jan *"} {
        if _, err := Parse(expr); err == nil {
            t.Fatalf("Parse(%q) unexpectedly succeeded", expr)
        }
    }
}

func TestNextAfterUsesTheNextMinute(t *testing.T) {
    cron, err := Parse("7 * * * *")
    if err != nil { t.Fatal(err) }
    got, ok := cron.NextAfter(time.Date(2026, 11, 11, 10, 8, 30, 0, time.Local))
    if !ok || !got.Equal(time.Date(2026, 11, 11, 11, 7, 0, 0, time.Local)) {
        t.Fatalf("unexpected next run: %v, %v", got, ok)
    }
}
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `go test ./internal/schedule -run 'TestParse|TestNextAfter' -v`

Expected: FAIL because the new package and functions do not exist yet。

- [ ] **Step 3: 实现最小纯函数实现**

将每个 Cron 字段解析为固定范围内的 `[]bool` 或不可变 bit set；解析逗号项时分别接受单值和 `start-end`，拒绝空项、反向范围、越界值和包含 `/` 的步进表达式。`Matches` 只比较分钟、小时、日、月、星期；`NextAfter` 从输入时间的下一分钟开始扫描，到一年上限返回 `(time.Time{}, false)`。

模型至少包含：

```go
type TargetKind string

const (
    TargetAction   TargetKind = "action"
    TargetWorkflow TargetKind = "workflow"
)

type Definition struct {
    ID       string         `yaml:"id"`
    Name     string         `yaml:"name"`
    Enabled  bool           `yaml:"enabled"`
    Cron     string         `yaml:"cron"`
    Action   string         `yaml:"action,omitempty"`
    Workflow string         `yaml:"workflow,omitempty"`
    Params   map[string]any `yaml:"params,omitempty"`
}

func (d Definition) Target() (TargetKind, string, error)
```

- [ ] **Step 4: 运行测试确认 GREEN，并补充边界测试**

Run: `go test ./internal/schedule -v`

补充字段数量错误、空表达式、`dom` 与 `dow` 的明确匹配规则测试；采用项目确定的五字段匹配语义并在测试中固定下来，避免运行时和 UI 预览出现分歧。

---

### Task 2: 实现 schedules.yaml Store 与配置校验

**Files:**
- Modify: `internal/schedule/model.go`
- Create: `internal/schedule/store.go`
- Test: `internal/schedule/store_test.go`

**Interfaces:**
- Consumes `schedule.Definition` 和 Task 1 的 `Parse`。
- Produces `type File struct { Schedules []Definition `yaml:"schedules"` }`。
- Produces `type TargetCatalog struct { Actions map[string]struct{}; Workflows map[string]struct{} }`。
- Produces `ValidateDefinitions(defs []Definition, catalog TargetCatalog) ([]Definition, error)`。
- Produces `LoadFile(path string, catalog TargetCatalog) ([]Definition, []error)`；文件不存在返回空列表且无错误，YAML 错误或非法条目返回错误并不启用非法条目。
- Produces `SaveFile(path string, defs []Definition) error`；使用同目录临时文件、同步/关闭后 rename，写入失败不改动目标文件。

- [ ] **Step 1: 编写失败测试覆盖 YAML 默认值和校验**

在临时目录中验证：

```go
func TestLoadFileDefaultsEnabledAndParams(t *testing.T) {
    path := filepath.Join(t.TempDir(), "schedules.yaml")
    if err := os.WriteFile(path, []byte("schedules:\n  - id: check\n    name: Check\n    cron: '7 * * * *'\n    action: patrol\n"), 0o600); err != nil { t.Fatal(err) }
    defs, errs := LoadFile(path, TargetCatalog{Actions: map[string]struct{}{"patrol": {}}})
    if len(errs) != 0 || len(defs) != 1 { t.Fatalf("defs=%v errs=%v", defs, errs) }
    if !defs[0].Enabled || defs[0].Params == nil { t.Fatalf("defaults not applied: %+v", defs[0]) }
}

func TestValidateRejectsInvalidTargetAndDuplicateID(t *testing.T) {
    cases := []struct {
        name string
        defs []Definition
        want string
    }{
        {name: "both targets", defs: []Definition{{ID: "x", Name: "X", Cron: "* * * * *", Action: "a", Workflow: "w"}}, want: "exactly one target"},
        {name: "unknown action", defs: []Definition{{ID: "x", Name: "X", Cron: "* * * * *", Action: "missing"}}, want: "unknown action"},
        {name: "duplicate id", defs: []Definition{{ID: "x", Name: "X", Cron: "* * * * *", Action: "a"}, {ID: "x", Name: "Y", Cron: "* * * * *", Action: "a"}}, want: "duplicate"},
    }
    for _, tc := range cases {
        t.Run(tc.name, func(t *testing.T) {
            _, err := ValidateDefinitions(tc.defs, TargetCatalog{Actions: map[string]struct{}{"a": {}}})
            if err == nil || !strings.Contains(err.Error(), tc.want) { t.Fatalf("err=%v, want %q", err, tc.want) }
        })
    }
}

func TestSaveFileRoundTrips(t *testing.T) {
    path := filepath.Join(t.TempDir(), "schedules.yaml")
    want := []Definition{{ID: "x", Name: "X", Enabled: true, Cron: "* * * * *", Action: "a", Params: map[string]any{"device": "active"}}}
    if err := SaveFile(path, want); err != nil { t.Fatal(err) }
    got, errs := LoadFile(path, TargetCatalog{Actions: map[string]struct{}{"a": {}}})
    if len(errs) != 0 || !reflect.DeepEqual(got, want) { t.Fatalf("got=%v errs=%v want=%v", got, errs, want) }
}

func TestSaveFileDoesNotReplaceExistingFileOnWriteFailure(t *testing.T) {
    dir := t.TempDir()
    path := filepath.Join(dir, "schedules.yaml")
    original := []byte("schedules: []\n")
    if err := os.WriteFile(path, original, 0o600); err != nil { t.Fatal(err) }
    err := SaveFile(filepath.Join(dir, "missing", "schedules.yaml"), []Definition{})
    if err == nil { t.Fatal("expected write error") }
    got, readErr := os.ReadFile(path)
    if readErr != nil { t.Fatal(readErr) }
    if !bytes.Equal(got, original) { t.Fatalf("existing file changed: %q", got) }
}
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `go test ./internal/schedule -run 'TestLoadFile|TestValidate|TestSaveFile' -v`

Expected: FAIL because Store APIs are not implemented。

- [ ] **Step 3: 实现解析、默认值和边界校验**

校验规则必须包含：

- ID 匹配 `^[a-z0-9-]+$`，不能为空且全局唯一。
- Name trim 后非空。
- Cron 通过 `Parse` 校验。
- `Action` 和 `Workflow` 恰好一个非空；目标必须存在于对应 catalog。
- `Params` 缺省归一化为非 nil 空 map；保存时只写入调度定义允许的字段。
- `Enabled` 缺省按启用处理。由于 Go bool 无法区分缺省和显式 false，YAML 解码模型应额外使用 `*bool` 中间结构，再归一化到 `Definition.Enabled`。

使用 `yaml.v3` 解析根 mapping；根类型错误、未知根字段策略和每个条目的错误都要返回可读的 schedule ID/字段上下文。加载时跳过非法条目但保留错误列表，避免非法条目进入调度器。

- [ ] **Step 4: 实现原子保存并通过测试**

`SaveFile` 先将完整新配置编码到内存，再在目标目录创建权限为 `0600` 的临时文件，写入并关闭成功后使用 `os.Rename` 替换目标。任一步失败都删除临时文件并返回错误，调用方继续保留旧内存配置。

Run: `go test ./internal/schedule -v`

Expected: PASS。

---

### Task 3: 实现 30 秒调度器、分钟去重和触发接口

**Files:**
- Create: `internal/schedule/scheduler.go`
- Test: `internal/schedule/scheduler_test.go`

**Interfaces:**
- Consumes Task 2 的 `Definition` 和 `Cron`。
- Produces：

```go
type TriggerFunc func(context.Context, Definition) error

type Scheduler struct {
    mu sync.Mutex
    definitions []Definition
    lastTriggered map[string]time.Time
    trigger TriggerFunc
}

func NewScheduler(defs []Definition, trigger TriggerFunc) *Scheduler
func (s *Scheduler) Replace(defs []Definition)
func (s *Scheduler) Run(ctx context.Context, now func() time.Time, tick <-chan time.Time)
func (s *Scheduler) TriggerNow(ctx context.Context, id string) error
```

`Run` 接收时钟和 tick 注入，生产环境由 Service 提供 30 秒 ticker，测试不使用 sleep。调度器只负责选出到点定义并调用 TriggerFunc；运行结果由 Service 回写。

- [ ] **Step 1: 编写失败测试**

覆盖：

```go
func TestSchedulerTriggersEnabledScheduleOncePerMinute(t *testing.T) {
    // Arrange: inject two ticks at 10:07:01 and 10:07:29 for one enabled 10:07 schedule.
    // Act: run both ticks through one Scheduler instance.
    // Assert: TriggerFunc receives exactly one definition.
}

func TestSchedulerSkipsDisabledSchedule(t *testing.T) {
    // Arrange: inject a disabled schedule matching the current minute.
    // Act: run a matching tick.
    // Assert: TriggerFunc receives no definition.
}

func TestSchedulerDoesNotBackfillMissedMinutes(t *testing.T) {
    // Arrange: schedule matches 10:07, first observed tick is 10:08:01.
    // Act: run the first tick without a prior 10:07 tick.
    // Assert: TriggerFunc receives no definition.
}

func TestSchedulerContinuesAfterTriggerError(t *testing.T) {
    // Arrange: two schedules match the same minute; the first TriggerFunc call returns an error.
    // Act: run one matching tick.
    // Assert: both definitions are attempted and Run does not terminate.
}

func TestSchedulerReplaceRemovesDeletedDefinition(t *testing.T) {
    // Arrange: construct a Scheduler with schedule A, then call Replace with schedule B.
    // Act: run a tick matching A and a later tick matching B.
    // Assert: A is not triggered and B is triggered once.
}
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `go test ./internal/schedule -run TestScheduler -v`

Expected: FAIL because Scheduler APIs do not exist。

- [ ] **Step 3: 实现最小调度循环**

每个 tick 将当前时间截断到分钟；只处理 `Enabled` 且 `Cron.Matches(now)` 的定义。使用 `(scheduleID, minute)` 作为去重键，触发前登记本分钟，确保同一分钟的第二个 tick 不重复触发。启动时只观察当前 tick，不根据上一次 tick 或系统休眠时长回放缺失分钟。`Replace` 在锁内替换完整定义快照，并清理已删除 ID 的去重状态。

`TriggerFunc` 返回错误时继续其他任务；调度器不负责重试、不建立排队队列。`TriggerNow` 绕过 Cron 和分钟去重，但仍调用同一个 TriggerFunc。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `go test ./internal/schedule -v`

Expected: PASS。

---

### Task 4: 在 api.Service 中加入 Schedule DTO、CRUD 和列表投影

**Files:**
- Create: `internal/api/schedules.go`
- Modify: `internal/api/api.go`
- Create: `internal/api/schedules_test.go`

**Interfaces:**
- Consumes Task 2 的 `LoadFile`、`SaveFile`、`TargetCatalog` 和现有 `Registry` / `WorkflowRegistry`。
- Produces以下 Wails DTO，字段名保持导出字段的 JSON/TypeScript 生成名称：

```go
type ScheduleInput struct {
    ID       string         `json:"id"`
    Name     string         `json:"name"`
    Enabled  bool           `json:"enabled"`
    Cron     string         `json:"cron"`
    TargetKind string       `json:"targetKind"`
    TargetID string         `json:"targetId"`
    Params   map[string]any `json:"params"`
}

type LastRun struct {
    Status     string `json:"status"`
    StartedAt  string `json:"startedAt"`
    FinishedAt string `json:"finishedAt"`
    ExitCode   int    `json:"exitCode"`
    Duration   string `json:"duration"`
    Error      string `json:"error"`
}

type ScheduleItem struct {
    ID         string         `json:"id"`
    Name       string         `json:"name"`
    Enabled    bool           `json:"enabled"`
    Cron       string         `json:"cron"`
    TargetKind string         `json:"targetKind"`
    TargetID   string         `json:"targetId"`
    Params     map[string]any `json:"params"`
    NextRun    string         `json:"nextRun"`
    Running    bool           `json:"running"`
    LastRun    *LastRun       `json:"lastRun,omitempty"`
}

type ScheduleListResult struct {
    Schedules []ScheduleItem `json:"schedules"`
    Errors    []string       `json:"errors"`
}
```

- Produces `ListSchedules() ScheduleListResult`、`SaveSchedule(input ScheduleInput) (ScheduleListResult, error)`、`DeleteSchedule(id string) (ScheduleListResult, error)`、`SetScheduleEnabled(id string, enabled bool) (ScheduleListResult, error)`、`RunScheduleNow(id string) error`。
- `NextRun` 使用当前时间和 Task 1 的 `Cron.NextAfter` 计算；无可计算时间返回空字符串。
- CRUD 对完整配置做新快照校验，成功写盘后再替换 Service 内存配置和 scheduler definitions。

- [ ] **Step 1: 编写失败 API 测试**

测试实例化带临时 `baseDir`、内存 action/workflow registry 的 Service，覆盖：

```go
func TestListSchedulesReturnsEmptyWhenFileMissing(t *testing.T) {
    // Arrange: create Service with a base directory that has no schedules.yaml.
    // Act: call ListSchedules.
    // Assert: result.Schedules is empty and result.Errors is empty.
}

func TestSaveSchedulePersistsActionTarget(t *testing.T) {
    // Arrange: register action patrol and build an input with TargetKind action.
    // Act: call SaveSchedule, then read schedules.yaml and call ListSchedules.
    // Assert: YAML stores action: patrol, omits workflow, and the DTO exposes targetKind/action ID.
}

func TestSaveScheduleRejectsUnknownTargetWithoutChangingFile(t *testing.T) {
    // Arrange: write a valid schedules.yaml and use an input targeting an unknown action.
    // Act: call SaveSchedule.
    // Assert: the error names the schedule and target; the original file bytes and ListSchedules result remain unchanged.
}

func TestSaveScheduleUpdatesExistingID(t *testing.T) {
    // Arrange: persist an enabled schedule and prepare an input with the same ID and a new Cron.
    // Act: call SaveSchedule.
    // Assert: the original entry is replaced, the list still has one entry, and the YAML contains the new Cron.
}

func TestLoadFileRejectsDuplicateIDs(t *testing.T) {
    // Arrange: write two schedules with the same ID to schedules.yaml.
    // Act: call LoadFile.
    // Assert: duplicate-ID diagnostics are returned; duplicate definitions never become active.
}

func TestDeleteAndToggleSchedule(t *testing.T) {
    // Arrange: persist one enabled schedule.
    // Act: disable it with SetScheduleEnabled, then delete it with DeleteSchedule.
    // Assert: the first result has Enabled=false and the final YAML has no schedule entries.
}

func TestRunScheduleNowRejectsMissingID(t *testing.T) {
    // Arrange: construct a Service with no matching schedule ID.
    // Act: call RunScheduleNow with the missing ID.
    // Assert: a clear not-found error is returned.
}
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `go test ./internal/api -run 'Test(List|Save|Delete|RunSchedule)' -v`

Expected: FAIL because Service fields and methods are not present。

- [ ] **Step 3: 扩展 Service 状态并实现 DTO 映射**

在 `Service` 中增加 schedule 文件路径、schedule mutex、定义快照、加载错误、`map[string]*scheduleRunState` 和 scheduler 运行句柄。构造函数继续接收现有参数，在 `baseDir` 下固定使用 `schedules.yaml`。目标 catalog 从 `s.reg.Actions` 与 `s.wfReg.Workflows` 生成；action/workflow ID 不能混用。

`SaveSchedule` 先根据 `ScheduleInput.TargetKind` 构造一个新 `schedule.Definition`，读取旧配置、替换同 ID 条目或追加新条目，调用 `ValidateDefinitions` 后写入完整文件。只有写入成功才替换内存 definitions、运行状态中被删除的 ID，并调用 scheduler.Replace。错误应包含 schedule ID、字段和目标 ID。

`DeleteSchedule` 对不存在 ID 返回明确错误；成功后写完整新列表。`SetScheduleEnabled` 走同一个不可变保存路径，不单独修改文件文本。`RunScheduleNow` 只负责查找并进入 Task 5 的统一启动路径。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `go test ./internal/api -v`

Expected: 新增测试和已有 API 测试全部 PASS。

---

### Task 5: 关联 action/workflow 运行完成结果并接入 Service 调度生命周期

**Files:**
- Modify: `internal/api/api.go`
- Modify: `internal/api/run.go`
- Modify: `internal/api/workflows.go`
- Modify: `internal/api/events.go`
- Modify: `main.go`（仅在 Service 生命周期需要已有 App shutdown 钩子时）
- Test: `internal/api/schedules_runtime_test.go`、现有 run/workflow 测试

**Interfaces:**
- Consumes Task 3 的 `TriggerFunc` 和 Task 4 的 Service schedule store/DTO。
- Produces内部 source metadata：

```go
type runSource struct {
    scheduleID string
}
```

- Existing public methods remain unchanged：`RunAction(id string, params map[string]any) error` 和 `RunWorkflow(id string, params map[string]any) error`。
- Adds private paths equivalent to `runAction(id, params, source)` and `runWorkflow(id, params, source)`; manual calls pass `nil`, scheduler calls pass `&runSource{scheduleID: id}`。
- Produces `schedules:changed` event，payload至少包含 `ScheduleItem` 的 `id`、`running`、`lastRun`；前端一次订阅即可更新列表。

- [ ] **Step 1: 编写失败运行关联测试**

使用可控 runner 或现有测试依赖覆盖：

```go
func TestScheduledActionCompletionUpdatesLastRun(t *testing.T) {
    // Arrange: register an action whose injected runner returns exit code 0 and a known duration.
    // Act: start it through the schedule source path and wait for completion.
    // Assert: LastRun has status success, exit code 0, non-empty timestamps, and the runner duration.
}

func TestScheduledWorkflowCompletionUpdatesLastRun(t *testing.T) {
    // Arrange: register a workflow with one successful step and a schedule source.
    // Act: execute the workflow through the scheduler trigger.
    // Assert: the same schedule state path records status success after workflow done.
}

func TestScheduledStartFailureUpdatesLastRun(t *testing.T) {
    // Arrange: start the target manually so the existing run lock is held.
    // Act: trigger the same target through a schedule.
    // Assert: the schedule records failed with the lock error and no queued goroutine is created.
}

func TestManualRunDoesNotWriteScheduleState(t *testing.T) {
    // Arrange: create a schedule with no LastRun state.
    // Act: call the public RunAction or RunWorkflow method without a runSource.
    // Assert: target output still completes normally and the schedule LastRun remains nil.
}
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `go test ./internal/api -run 'TestScheduled|TestManualRun' -v`

Expected: FAIL because execution functions do not carry source metadata and schedule state is not updated。

- [ ] **Step 3: 把 source metadata 传入现有执行路径**

将 `RunAction` 和 `RunWorkflow` 保持为薄包装：参数解码、运行锁和已有错误语义不变，仅转调内部方法。`execute`、`executeWorkflow` 接受 source 参数；以下所有完成出口都调用统一的 `finishScheduleRun(source, exitCode, err, duration)`：

- 工作目录不存在。
- `actionrun.Build` 失败。
- runner 正常返回成功或失败。
- workflow step/整体结束。
- 运行锁拒绝启动。

开始调度运行时先登记 `Running=true` 和 `StartedAt`，但只有目标成功进入已有运行锁后才算真正启动；锁拒绝立即写入失败 LastRun，不建立队列。重复完成回调不得覆盖更新后的状态，使用 schedule ID 对应的一次性运行 token 或等价的互斥保护。

- [ ] **Step 4: 启动、停止并重载调度器**

在 Service 初始化阶段加载 `baseDir/schedules.yaml`；在 App 注入后创建 `schedule.NewScheduler`，注入一个将 definition 转为 `runAction` 或 `runWorkflow` 的 TriggerFunc，并启动 `time.NewTicker(30 * time.Second)`。Service 保存 cancel function，在已有 App shutdown 生命周期中取消 ticker goroutine。

`Reload` 或 action/workflow registry 重载后，重新生成 catalog、校验并 `scheduler.Replace`；非法 schedule 保留在错误列表但不触发。保存、删除、启停成功后同样 reconcile，不需要重启 GUI。

- [ ] **Step 5: 发送状态事件并验证测试**

在 `events.go` 集中定义常量 `schedules:changed` 和 payload 构造，避免把事件名散落在 CRUD、action、workflow 文件中。无 App（单测）时状态更新仍写入内存，但事件发送必须显式跳过而不能 panic。

Run: `go test ./internal/api ./internal/schedule -race -v`

Expected: PASS；确认竞态检测没有 schedule store、runtime map 或事件序列问题。

---

### Task 6: 生成并校验 Wails bindings

**Files:**
- Modify: `frontend/bindings/` generated files only

**Interfaces:**
- Consumes Task 4 的五个公开 Service 方法及其 DTO。
- Produces TypeScript imports for `ScheduleInput`、`ScheduleItem`、`ScheduleListResult`、`LastRun` and methods `ListSchedules`、`SaveSchedule`、`DeleteSchedule`、`SetScheduleEnabled`、`RunScheduleNow`。

- [ ] **Step 1: 运行绑定生成**

Run: `wails3 generate bindings`

Expected: 生成目录出现 Scheduler DTO 和 Service 方法；不直接编辑生成文件。

- [ ] **Step 2: 检查生成名称与 Go DTO 一致**

Run: `rg -n "Schedule(Input|Item|ListResult)|ListSchedules|SaveSchedule|DeleteSchedule|SetScheduleEnabled|RunScheduleNow" frontend/bindings`

Expected: 所有名称均可被前端 import，字段 casing 与 Task 4 的 JSON 名称一致。

- [ ] **Step 3: 运行 Go 编译检查**

Run: `go test ./internal/api ./internal/schedule`

Expected: PASS；若 bindings 生成暴露了不受支持的类型，先修正 Go DTO 的 JSON-safe 字段，再重新生成。

---

### Task 7: 扩展 Provider 的 Scheduler 状态、API 调用和事件订阅

**Files:**
- Modify: `frontend/src/context/ActionRunnerProvider.tsx`
- Modify: `frontend/src/types/events.ts`
- Modify: `frontend/src/context/ActionRunnerProvider.test.tsx`

**Interfaces:**
- Consumes Task 6 的 generated bindings 和 Task 5 的 `schedules:changed` event。
- Produces Context values：

```ts
schedules: ScheduleItem[];
scheduleErrors: string[];
refreshSchedules: () => Promise<void>;
saveSchedule: (input: ScheduleInput) => Promise<void>;
deleteSchedule: (id: string) => Promise<void>;
setScheduleEnabled: (id: string, enabled: boolean) => Promise<void>;
runScheduleNow: (id: string) => Promise<void>;
```

- Produces event type：

```ts
export interface ScheduleStateEventData {
  id: string;
  running: boolean;
  lastRun?: ScheduleLastRun;
}
```

字段必须与生成 DTO 的实际类型和后端事件 payload 对齐；若事件 payload 是完整 `ScheduleItem`，前端类型应直接复用该结构而不是维护第二套 LastRun 字段。

- [ ] **Step 1: 编写失败 Provider 测试**

扩展 bindings mock，验证：

```tsx
it("加载 schedules 并暴露 schedule 状态", async () => {
  mockListSchedules.mockResolvedValue({ schedules: [scheduleItem], errors: [] });
  render(<TestProvider />);
  expect(await screen.findByText("bg202-hourly")).toBeInTheDocument();
});

it("接收 schedules:changed 后不可变更新对应任务", async () => {
  const updated = { ...scheduleItem, running: true };
  listeners["schedules:changed"](updated);
  expect(await screen.findByText("运行中")).toBeInTheDocument();
  expect(initialSchedulesReference).not.toBe(currentSchedulesReference);
});

it("保存、删除、启停和立即执行调用对应 binding 并刷新列表", async () => {
  await act(() => context.saveSchedule(input));
  await act(() => context.setScheduleEnabled("bg202-hourly", false));
  await act(() => context.runScheduleNow("bg202-hourly"));
  await act(() => context.deleteSchedule("bg202-hourly"));
  expect(mockSaveSchedule).toHaveBeenCalledWith(input);
  expect(mockSetScheduleEnabled).toHaveBeenCalledWith("bg202-hourly", false);
  expect(mockRunScheduleNow).toHaveBeenCalledWith("bg202-hourly");
  expect(mockDeleteSchedule).toHaveBeenCalledWith("bg202-hourly");
  expect(mockListSchedules).toHaveBeenCalledTimes(5);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `cd frontend && npm test -- ActionRunnerProvider`

Expected: FAIL because context has no Scheduler state or methods。

- [ ] **Step 3: 实现 Provider API 和事件订阅**

初始化时与 actions/workflows 并行调用 `ListSchedules`，将 `errors` 映射为 `scheduleErrors`。CRUD 方法统一捕获 binding 错误、保留用户可见错误语义，并在成功后使用返回的 `ScheduleListResult` 更新状态，避免额外请求造成竞态。`Events.On("schedules:changed", ...)` 订阅每个状态事件；事件数据通过窄类型守卫校验 `id` 后，以 `map` 返回新数组替换对应项，未知 ID 触发 `refreshSchedules`。

不要在 Provider 中保存表单草稿、筛选或抽屉状态；这些属于 `SchedulerView`。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `cd frontend && npm test -- ActionRunnerProvider`

Expected: PASS。

---

### Task 8: 实现 A 版 SchedulerView 与 Config 导航接入

**Files:**
- Create: `frontend/src/components/SchedulerView.tsx`
- Create: `frontend/src/components/SchedulerView.test.tsx`
- Modify: `frontend/src/components/OutputPanel.tsx`
- Modify: `frontend/src/components/AppSidebar.tsx`

**Interfaces:**
- Consumes Task 7 Provider context、现有 `ActionItem` / `WorkflowItem` 的 `Params`、现有 `ParamFields`、Button/Input/Select/Sheet/Badge/IconButton 等 UI 原子。
- Produces `RunnerView` 中的 `"scheduler"` 分支和 Config 分组入口。
- 保存时向 Provider 传入：

```ts
{
  id,
  name,
  enabled,
  cron,
  targetKind: "action" | "workflow",
  targetId,
  params: Record<string, unknown>
}
```

- [ ] **Step 1: 编写失败视图测试**

覆盖已确认验收项：

```tsx
it("Config 分组显示定时任务并进入 scheduler view", async () => {
  await user.click(screen.getByRole("button", { name: "定时任务" }));
  expect(await screen.findByRole("heading", { name: "定时任务" })).toBeInTheDocument();
});

it("显示统计、筛选和搜索结果", async () => {
  expect(screen.getByText("全部任务")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "已停用" }));
  expect(screen.getByText("disabled-schedule")).toBeInTheDocument();
  await user.clear(screen.getByRole("searchbox"));
  await user.type(screen.getByRole("searchbox"), "bg202");
  expect(screen.getByText("bg202-hourly")).toBeInTheDocument();
  expect(screen.queryByText("other-schedule")).not.toBeInTheDocument();
});

it("新建和编辑抽屉切换 action/workflow 并渲染目标参数", async () => {
  await user.click(screen.getByRole("button", { name: "新建任务" }));
  await user.click(screen.getByRole("radio", { name: "Workflow" }));
  await user.click(screen.getByRole("combobox", { name: "执行目标" }));
  await user.click(screen.getByRole("option", { name: "nightly-build" }));
  expect(screen.getByLabelText("环境")).toBeInTheDocument();
});

it("启停、保存、删除和立即执行调用 Provider 方法", async () => {
  await user.click(screen.getByRole("switch", { name: "启用" }));
  await user.click(screen.getByRole("button", { name: "立即执行" }));
  await user.click(screen.getByRole("button", { name: "保存" }));
  await user.click(screen.getByRole("button", { name: "删除" }));
  expect(mockSetScheduleEnabled).toHaveBeenCalled();
  expect(mockRunScheduleNow).toHaveBeenCalled();
  expect(mockSaveSchedule).toHaveBeenCalled();
  expect(mockDeleteSchedule).toHaveBeenCalled();
});

it("状态事件更新运行中、成功和失败展示", async () => {
  expect(screen.getByText("运行中")).toBeInTheDocument();
  expect(screen.getByText("成功")).toBeInTheDocument();
  expect(screen.getByText("失败")).toBeInTheDocument();
});

it("在窄视口不产生页面级横向溢出", async () => {
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 320 });
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
  expect(screen.getByTestId("schedule-table-scroll")).toHaveClass("overflow-x-auto");
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `cd frontend && npm test -- SchedulerView AppSidebar OutputPanel`

Expected: FAIL because view type, panel branch, sidebar entry and component do not exist。

- [ ] **Step 3: 实现列表和编辑抽屉**

页面结构按原型和规格实现：

- Header：`SidebarTrigger`、标题、刷新 IconButton、新建任务按钮。
- Summary：全部任务、已启用、正在运行、最近成功四项统计。
- Filter：全部、已启用、已停用。
- Search：按任务名称、ID、目标 ID 过滤。
- Table：状态、任务、执行目标、Cron、下次执行、最近结果、操作。
- Drawer/Sheet：名称、启用 Switch、Action/Workflow segmented control、目标 Select、Cron Input、Cron 预览、目标参数字段、保存/立即执行/删除操作。

目标列表从 Provider 已加载的 actions/workflows 元数据中取；目标切换时把参数值重置为目标 ParamSpec 的默认值，避免把旧目标参数误传给新目标。`ParamFields` 继续接收字符串值；保存前将表单值转换为 `Record<string, unknown>`，不让组件直接修改 Provider 数据。Cron 预览只调用前端轻量展示逻辑或后端返回的 `NextRun`，不可在前端复制一套宽松解析规则绕过后端校验。

表格在小屏幕使用局部横向滚动容器，页面根布局不产生横向溢出；按钮使用现有 IconButton/Tooltip，图标按钮提供 aria-label。所有用户输入通过 React JSX 渲染，不使用 `innerHTML`。

- [ ] **Step 4: 接入 view 分派和 Config 入口**

在 Provider 的 `RunnerView` union 增加 `scheduler`；`OutputPanel` 添加：

```tsx
if (view === "scheduler") return <SchedulerView />;
```

在 `AppSidebar` Config 分组增加只调用 `setView("scheduler")` 的入口，与片段、全局配置、设置并列；不在 Actions、Workflows、AI Chat 分组增加重复入口。

- [ ] **Step 5: 运行测试并做类型检查**

Run: `cd frontend && npm test -- SchedulerView AppSidebar OutputPanel && npm run typecheck`

Expected: 测试和类型检查 PASS。

---

### Task 9: 完善中文/英文文案、用户文档和跨模块回归测试

**Files:**
- Modify: `frontend/src/i18n/locales/zh.json`
- Modify: `frontend/src/i18n/locales/en.json`
- Modify: `docs/action.md`
- Modify: `docs/workflow.md`
- Create or modify: `docs/schedule.md` 或 `README.md`
- Modify: `frontend/src/components/AppSidebar.test.tsx`
- Modify: `frontend/src/components/OutputPanel.test.tsx`
- Create: `internal/api/schedules_test.go`
- Create: `internal/api/schedules_runtime_test.go`

**Interfaces:**
- Consumes all completed Go and frontend behavior。
- Produces完整用户文档和最终验收命令，不改变 Scheduler 的运行协议。

- [ ] **Step 1: 补齐 i18n key 并验证 key 集合**

中文和英文都必须覆盖以下语义：标题、描述、新建、编辑、保存、删除、启用、停用、立即执行、刷新、全部任务、已启用、已停用、正在运行、最近成功、状态、任务、执行目标、Cron、下次执行、最近结果、Action、Workflow、参数、未执行、成功、失败、运行中、保存成功、删除成功、加载失败、保存失败、立即执行失败、Cron 错误、目标错误、空列表。

Run: `node -e 'const fs=require("fs"); const zh=Object.keys(JSON.parse(fs.readFileSync("frontend/src/i18n/locales/zh.json"))); const en=Object.keys(JSON.parse(fs.readFileSync("frontend/src/i18n/locales/en.json"))); const a=zh.filter(k=>!en.includes(k)); const b=en.filter(k=>!zh.includes(k)); if(a.length||b.length){console.error({missingInEn:a,missingInZh:b}); process.exit(1)}'`

Expected: no missing keys。

- [ ] **Step 2: 更新 action/workflow/schedule 文档**

`docs/schedule.md` 至少说明：

- `schedules.yaml` 完整示例，含 action、workflow、params 和 enabled。
- Cron 五字段顺序、支持 `*`/固定值/范围/逗号列表，不支持步进和名称别名。
- 30 秒 tick、分钟去重、睡眠不补跑。
- 手动运行和调度运行共享并发拒绝规则；不排队。
- 最近运行状态只在当前 GUI 进程有效。
- Scheduler 位于 Config 分组且不绑定 LLM。
- 保存失败、未知目标、非法 Cron 的行为。

在 `docs/action.md` 和 `docs/workflow.md` 的参数章节分别补充“可作为 Scheduler 目标”说明，并明确 scheduler params 复用既有 ParamSpec 语义。

- [ ] **Step 3: 补充集成测试**

验证完整路径：保存 action schedule -> ListSchedules 返回 NextRun -> 立即执行 -> action 完成 -> `schedules:changed` payload 为 success；同样为 workflow 做一条路径。测试非法配置不落盘、reload 后 scheduler definitions 更新、手动运行不污染 LastRun。

- [ ] **Step 4: 运行完整验证**

Run:

```bash
go test ./internal/runner ./internal/registry ./internal/workflow ./internal/actionrun ./internal/schedule ./internal/api
go test -race ./...
cd frontend && npm test
cd frontend && npm run lint && npm run typecheck
cd .. && bash deploy/build.sh
```

Expected: 所有 Go 单测、竞态检测、前端测试、lint、类型检查和全量构建均 PASS；构建顺序仍由 `deploy/build.sh` 管理，Wails bindings 已在前置 Task 生成。

- [ ] **Step 5: 进行最终手工验收**

使用本地 GUI 验证：

1. Config 中能打开 Scheduler，Actions/Workflows/AI Chat 中没有重复入口。
2. 新建 action 和 workflow 任务，切换目标类型后参数字段与目标 ParamSpec 对齐。
3. 保存后 `schedules.yaml` 可读，重启 GUI 后配置仍存在。
4. 停用任务后下一次 tick 不触发；重新启用后可触发。
5. 目标运行中到点时显示失败，不生成排队任务。
6. 立即执行、成功、失败、耗时、退出码和下次执行时间在列表中可见。
7. 320px、768px、1440px 宽度下页面无根级横向溢出，表格仅在局部容器滚动。

---

## 验收映射

- 通用面板与 A 版布局：Task 8。
- Config 分组入口：Task 8、Task 9。
- action/workflow 目标和参数复用：Task 2、Task 4、Task 8。
- `schedules.yaml` 持久化：Task 2、Task 4、Task 9。
- Cron 解析、30 秒 tick、分钟去重和不补跑：Task 1、Task 3。
- CRUD、启停和立即执行：Task 4、Task 5、Task 7、Task 8。
- 最近运行结果与状态事件：Task 5、Task 7、Task 8。
- Wails bindings：Task 6。
- 文档和完整测试：Task 9。
- 不绑定 LLM、不退役 launchd、不复制运行日志：Global Constraints、Task 5、Task 9。

## 实施顺序

按 Task 1 至 Task 9 顺序执行。Task 1-3 完成并通过纯 Go 测试后再进入 API；Task 4-5 完成并通过竞态测试后生成 bindings；Task 6 完成后再写 Provider 和 UI；Task 9 作为最后的文档、回归和构建门禁。每个 Task 都应先写失败测试，再实现最小行为，最后运行该 Task 的独立验证命令；不在本计划中创建 Git 提交。
