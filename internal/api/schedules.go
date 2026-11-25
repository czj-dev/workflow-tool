// schedules.go：调度的 CRUD、投影与到点发起。调度只指向目标、不定义要做的事，
// 目标三选一（action / workflow / ai，ADR-0005）；时间规则、启停与参数覆盖只在这里。
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"sort"
	"time"

	"workflow-tool/internal/ai"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/runstore"
	"workflow-tool/internal/schedule"
	"workflow-tool/internal/target"
)

type ScheduleInput struct {
	ID         string         `json:"id"`
	Name       string         `json:"name"`
	Enabled    bool           `json:"enabled"`
	Cron       string         `json:"cron"`
	TargetKind string         `json:"targetKind"`
	TargetID   string         `json:"targetId"`
	Params     map[string]any `json:"params"`
	CatchUp    bool           `json:"catchUp"`
}

// LastRun 是一条调度最近一次真实运行的结论。跳过不进这里（见 LastSkip）。
// 状态词汇与运行记录一致：running / succeeded / failed / cancelled。
type LastRun struct {
	Status     string `json:"status"`
	StartedAt  string `json:"startedAt"`
	FinishedAt string `json:"finishedAt"`
	ExitCode   int    `json:"exitCode"`
	Duration   string `json:"duration"`
	Error      string `json:"error"`
	// RunID 是对应的运行记录，运行详情从这里进入；为空 = 没有留档。
	RunID string `json:"runId,omitempty"`
}

// LastSkip 是调度最近一次到点被跳过的时刻与原因（目标正在运行）。
// 跳过不是失败：留档并注明原因，不覆盖上一次真实运行的结果。
type LastSkip struct {
	At     string `json:"at"`
	Reason string `json:"reason"`
	RunID  string `json:"runId,omitempty"`
}

type ScheduleItem struct {
	ID         string         `json:"id"`
	Name       string         `json:"name"`
	Enabled    bool           `json:"enabled"`
	Cron       string         `json:"cron"`
	TargetKind string         `json:"targetKind"`
	TargetID   string         `json:"targetId"`
	Params     map[string]any `json:"params"`
	// CatchUp 为 true 时，应用恢复后为最近一个错过的调度时刻补跑一次。
	CatchUp  bool      `json:"catchUp"`
	NextRun  string    `json:"nextRun"`
	Running  bool      `json:"running"`
	LastRun  *LastRun  `json:"lastRun,omitempty"`
	LastSkip *LastSkip `json:"lastSkip,omitempty"`
}

type ScheduleListResult struct {
	Schedules []ScheduleItem `json:"schedules"`
	Errors    []string       `json:"errors"`
}

// runSource 标记一次运行由调度发起；nil = 手动运行。
type runSource struct {
	scheduleID string
	// origin 是发起来源：到点（schedule）或立即运行（run-now）。撞上运行中的目标时
	// 前者记跳过、后者返回错误；它也写进运行记录。
	origin string
	// token 让迟到的完成回调不覆盖同一条调度更新的那一次运行（见 startScheduleRunWithID）。
	token uint64
	// runID 是这次运行的运行记录 id（beginRun / noteRun 之后回填）。
	runID string
}

type scheduledRun struct {
	source *runSource
	token  uint64
}

type scheduleRunState struct {
	Running   bool
	Token     uint64
	StartedAt time.Time
	LastRun   *LastRun
	LastSkip  *LastSkip
}

// beginScheduledRun 登记一条调度的运行开始并通知前端：最近结果变为「运行中」且带上 run-id，
// 卡片据此进入运行态、能进运行详情实时跟踪——调度发起的运行前端没有它的输出捕获，只能
// 靠这次通知得知。source 为 nil（手动运行）时空操作。
func (s *Service) beginScheduledRun(source *runSource) {
	if source == nil || source.scheduleID == "" {
		return
	}
	started := s.startScheduleRunWithID(source.scheduleID, source.runID)
	source.token = started.token
	s.emitScheduleChanged(source.scheduleID)
}

// startScheduleRunWithID 登记一条调度的运行开始；最近结果在运行中就带上 run-id，
// 空的 run-id 表示这次运行没有留档。
func (s *Service) startScheduleRunWithID(id, runID string) *scheduledRun {
	now := time.Now()
	s.scheduleMu.Lock()
	defer s.scheduleMu.Unlock()
	state := s.scheduleRuns[id]
	var token uint64
	if state != nil {
		token = state.Token + 1
	}
	if token == 0 {
		token = 1
	}
	// 新一次运行开始即清掉上一次的跳过：卡片上「上次到点已跳过」只说明最近一次到点。
	s.scheduleRuns[id] = &scheduleRunState{
		Running:   true,
		Token:     token,
		StartedAt: now,
		LastRun: &LastRun{
			Status:    runstore.StatusRunning,
			StartedAt: now.Format(time.RFC3339Nano),
			ExitCode:  -1,
			RunID:     runID,
		},
	}
	return &scheduledRun{source: &runSource{scheduleID: id, token: token, runID: runID}, token: token}
}

func (s *Service) finishScheduleRun(source *runSource, token uint64, exitCode int, runErr error, duration time.Duration) {
	if source == nil {
		return
	}
	now := time.Now()
	// 与运行记录同一套状态词汇：超时是失败不是取消，取消不带原因。
	status, reason := runstore.Outcome(exitCode, runErr)
	last := &LastRun{
		Status:     status,
		StartedAt:  now.Add(-duration).Format(time.RFC3339Nano),
		FinishedAt: now.Format(time.RFC3339Nano),
		ExitCode:   exitCode,
		Duration:   duration.String(),
		Error:      reason,
		RunID:      source.runID,
	}
	s.scheduleMu.Lock()
	state := s.scheduleRuns[source.scheduleID]
	if state == nil || state.Token != token {
		s.scheduleMu.Unlock()
		return
	}
	if !state.StartedAt.IsZero() {
		last.StartedAt = state.StartedAt.Format(time.RFC3339Nano)
	}
	s.scheduleRuns[source.scheduleID] = &scheduleRunState{Token: state.Token, LastRun: last}
	s.scheduleMu.Unlock()
	s.emitScheduleChanged(source.scheduleID)
}

// skipScheduleRun 记下一条调度最近一次到点被跳过。只动 LastSkip：正在进行的运行
// 与上一次真实运行的结果都原样保留。这条调度此前从未运行过时也建得出来。
func (s *Service) skipScheduleRun(scheduleID, reason, runID string) {
	now := time.Now()
	s.scheduleMu.Lock()
	state := s.scheduleRuns[scheduleID]
	if state == nil {
		state = &scheduleRunState{}
		s.scheduleRuns[scheduleID] = state
	}
	state.LastSkip = &LastSkip{At: now.Format(time.RFC3339Nano), Reason: reason, RunID: runID}
	s.scheduleMu.Unlock()
}

// failScheduleStart 记一次「启动失败」：目标没在跑，运行却没能开始（未知目标、
// 输入不合法这类早于占锁的失败）。留一条 failed 运行记录，调度卡的最近结果随之更新。
// 同一条调度正有一次运行在途时不覆盖它。
func (s *Service) failScheduleStart(def schedule.Definition, origin string, runErr error) {
	kind, target, _ := def.Target()
	now := time.Now()
	last := &LastRun{Status: runstore.StatusFailed, StartedAt: now.Format(time.RFC3339Nano), FinishedAt: now.Format(time.RFC3339Nano), ExitCode: -1, Duration: "0s", Error: errStr(runErr)}
	last.RunID = s.noteRun(kind, target, def.Params, &runSource{scheduleID: def.ID, origin: origin}, runstore.StatusFailed, errStr(runErr))
	s.scheduleMu.Lock()
	state := s.scheduleRuns[def.ID]
	if state != nil && state.Running {
		s.scheduleMu.Unlock()
		return
	}
	var token uint64
	if state != nil {
		token = state.Token + 1
	}
	if token == 0 {
		token = 1
	}
	s.scheduleRuns[def.ID] = &scheduleRunState{Token: token, LastRun: last}
	s.scheduleMu.Unlock()
	s.emitScheduleChanged(def.ID)
}

func (s *Service) emitScheduleChanged(id string) {
	for _, item := range s.ListSchedules().Schedules {
		if item.ID == id {
			s.notify(eventSchedulesChanged, item)
			return
		}
	}
}

// scheduleCatalog 汇总当前已加载的全部目标，供校验 schedules.yaml 里的引用。
func (s *Service) scheduleCatalog() schedule.TargetCatalog {
	catalog := schedule.TargetCatalog{Actions: map[string]struct{}{}, Workflows: map[string]struct{}{}, AITasks: map[string]struct{}{}}
	if reg := s.actionRegistry(); reg != nil {
		for id := range reg.Actions {
			catalog.Actions[id] = struct{}{}
		}
	}
	if reg := s.workflowRegistry(); reg != nil {
		for id := range reg.Workflows {
			catalog.Workflows[id] = struct{}{}
		}
	}
	if reg := s.aiRegistry(); reg != nil {
		for id := range reg.Tasks {
			catalog.AITasks[id] = struct{}{}
		}
	}
	return catalog
}

func (s *Service) ListSchedules() ScheduleListResult {
	s.scheduleMu.Lock()
	defs, errs, runs := s.scheduleSnapshotLocked()
	s.scheduleMu.Unlock()
	return s.projectSchedules(defs, errs, runs)
}

func (s *Service) scheduleSnapshotLocked() ([]schedule.Definition, []error, map[string]*scheduleRunState) {
	// 自洽目录：只认文件里实际引用的目标种类，三张表各查各的。
	catalog := schedule.TargetCatalog{Actions: map[string]struct{}{}, Workflows: map[string]struct{}{}, AITasks: map[string]struct{}{}}
	for _, def := range s.scheduleDefs {
		switch kind, target, _ := def.Target(); kind {
		case schedule.TargetAction:
			catalog.Actions[target] = struct{}{}
		case schedule.TargetWorkflow:
			catalog.Workflows[target] = struct{}{}
		case schedule.TargetAI:
			catalog.AITasks[target] = struct{}{}
		}
	}
	defs, err := schedule.ValidateDefinitions(s.scheduleDefs, catalog)
	if err != nil {
		return nil, append([]error{}, s.scheduleErrors...), nil
	}
	errs := append([]error{}, s.scheduleErrors...)
	runs := make(map[string]*scheduleRunState, len(s.scheduleRuns))
	for id, state := range s.scheduleRuns {
		if state == nil {
			continue
		}
		copyState := &scheduleRunState{Running: state.Running, Token: state.Token, StartedAt: state.StartedAt}
		if state.LastRun != nil {
			last := *state.LastRun
			copyState.LastRun = &last
		}
		if state.LastSkip != nil {
			skip := *state.LastSkip
			copyState.LastSkip = &skip
		}
		runs[id] = copyState
	}
	return defs, errs, runs
}

// projectSchedules 把调度定义投影成前端列表。内存里的运行态优先（本次应用会话内
// 跑过的）；内存里没有结果的（应用刚启动）从运行记录回填——最近结果因此跨重启保留。
// 不持 scheduleMu：下次的到点扫描与运行记录查询都慢，CRUD 不该等它们。
func (s *Service) projectSchedules(defs []schedule.Definition, scheduleErrors []error, runs map[string]*scheduleRunState) ScheduleListResult {
	result := ScheduleListResult{Schedules: make([]ScheduleItem, 0, len(defs)), Errors: make([]string, 0, len(scheduleErrors))}
	for _, err := range scheduleErrors {
		result.Errors = append(result.Errors, err.Error())
	}
	now := time.Now()
	for _, def := range defs {
		kind, target, _ := def.Target()
		item := ScheduleItem{ID: def.ID, Name: def.Name, Enabled: def.Enabled, Cron: def.Cron, TargetKind: string(kind), TargetID: target,
			Params: def.Params, CatchUp: def.CatchUp}
		if cron, err := schedule.Parse(def.Cron); err == nil {
			if next, ok := cron.NextAfter(now); ok {
				item.NextRun = next.Format(time.RFC3339)
			}
		}
		if state := runs[def.ID]; state != nil {
			item.Running = state.Running
			item.LastRun, item.LastSkip = state.LastRun, state.LastSkip
		}
		// 最近结果排除 skipped / missed：它们不覆盖上一次真实运行的结果。
		// 应用重启后仍有执行器在跑时，回填回来的就是那条 running 的记录——卡片据此仍是运行态。
		if item.LastRun == nil {
			if rec, ok := s.runs.Latest(kind, target, def.ID, true); ok {
				item.LastRun = lastRunFromRecord(rec)
				item.Running = rec.Status == runstore.StatusRunning
			}
		}
		// 「上次到点已跳过」只说明最近一次到点：该调度最新一条记录是被跳过的才显示，
		// 之后有过真实运行就不再翻旧账。
		if item.LastSkip == nil {
			if rec, ok := s.runs.LatestScheduled(def.ID); ok && rec.Status == runstore.StatusSkipped {
				item.LastSkip = &LastSkip{At: rec.StartedAt.Format(time.RFC3339Nano), Reason: rec.Reason, RunID: rec.ID}
			}
		}
		result.Schedules = append(result.Schedules, item)
	}
	return result
}

// lastRunFromRecord 把一条运行记录的元数据转成调度卡的最近结果。
func lastRunFromRecord(rec runstore.Record) *LastRun {
	last := &LastRun{
		Status:    rec.Status,
		StartedAt: rec.StartedAt.Format(time.RFC3339Nano),
		ExitCode:  -1,
		Error:     rec.Reason,
		RunID:     rec.ID,
	}
	if rec.FinishedAt != nil {
		last.FinishedAt = rec.FinishedAt.Format(time.RFC3339Nano)
		last.Duration = rec.FinishedAt.Sub(rec.StartedAt).String()
	}
	if rec.ExitCode != nil {
		last.ExitCode = *rec.ExitCode
	}
	return last
}

func (s *Service) reconcileSchedules() {
	defs, errs := schedule.LoadFile(s.schedulePath, s.scheduleCatalog())
	defs, errs = s.validateLoadedScheduleDefinitions(defs, errs)
	s.scheduleMu.Lock()
	s.scheduleDefs = defs
	s.scheduleErrors = errs
	s.scheduler.Replace(defs)
	active := make(map[string]*scheduleRunState, len(defs))
	for _, def := range defs {
		if state := s.scheduleRuns[def.ID]; state != nil {
			active[def.ID] = state
		}
	}
	s.scheduleRuns = active
	s.scheduleMu.Unlock()
}

func (s *Service) checkedScheduleFile() ([]schedule.Definition, error) {
	defs, errs := schedule.LoadFile(s.schedulePath, s.scheduleCatalog())
	if len(errs) != 0 {
		return nil, fmt.Errorf("schedules.yaml contains errors: %w", errs[0])
	}
	return s.validateRuntimeDefinitions(defs)
}

// validateRuntimeDefinitions 按目标逐条校验 params 的形状（见 validateScheduleTargetParams）。
func (s *Service) validateRuntimeDefinitions(defs []schedule.Definition) ([]schedule.Definition, error) {
	for _, def := range defs {
		if err := s.validateScheduleTargetParams(def); err != nil {
			return nil, fmt.Errorf("schedule %q: params: %w", def.ID, err)
		}
	}
	return defs, nil
}

// validateLoadedScheduleDefinitions 同 validateRuntimeDefinitions，但加载路径上
// 单条不合格只过滤掉该条并报诊断，不影响其余调度。
func (s *Service) validateLoadedScheduleDefinitions(defs []schedule.Definition, scheduleErrors []error) ([]schedule.Definition, []error) {
	valid := make([]schedule.Definition, 0, len(defs))
	errs := append([]error{}, scheduleErrors...)
	for _, def := range defs {
		if err := s.validateScheduleTargetParams(def); err != nil {
			errs = append(errs, fmt.Errorf("schedule %q: params: %w", def.ID, err))
			continue
		}
		valid = append(valid, def)
	}
	return valid, errs
}

// validateScheduleTargetParams 按目标种类校验调度的 params——调度的 params 覆盖目标的
// 输入，所以保存与加载时都按目标校验，规则与各目标运行时接受的一致：
//   - 值的形状：动作可以是标量或 $literal 对象（字面值，不做 shell 展开）；工作流与 AI
//     任务只能是标量；
//   - 动作 / 工作流：已声明参数的取值按其声明类型校验（见 validateDeclaredParams）；
//     未声明的键是允许的——它们作为额外变量源，是动作与工作流的既有用法；
//   - AI 任务：键必须是任务已声明的参数或保留运行参数（prompt / system / resume）——
//     未声明的键报错，因为 AI 任务运行时对未声明的输入直接报错，拼错参数名不能等到
//     到点才发现。
func (s *Service) validateScheduleTargetParams(def schedule.Definition) error {
	kind, target, err := def.Target()
	if err != nil {
		return err
	}
	if err := validateScheduleParams(def.Params, kind == schedule.TargetAction); err != nil {
		return err
	}
	switch kind {
	case schedule.TargetAction:
		la, ok := s.actionRegistry().Actions[target]
		if !ok {
			return fmt.Errorf("unknown action %q", target)
		}
		if err := rejectLiteralShellSubstitution(la.Def.Command.Run, literalParamKeys(def.Params)); err != nil {
			return err
		}
		return validateDeclaredParams(la.Def.Params, def.Params, true)
	case schedule.TargetWorkflow:
		lw, ok := s.workflowRegistry().Workflows[target]
		if !ok {
			return fmt.Errorf("unknown workflow %q", target)
		}
		return validateDeclaredParams(lw.Def.Params, def.Params, false)
	case schedule.TargetAI:
		return s.validateScheduledAIParams(target, def.Params)
	}
	return nil
}

// validateDeclaredParams 按目标的参数声明校验调度里**提供了的**参数值：select 须在
// options 内，bool 须是布尔或 "true" / "false"，list / arguments 须是合法的 JSON 字符串，
// 其余是字符串类。与 internal/cli 的 coerceParams 同一套规则。
// 不在这里报错的两种情况：未声明的键（额外变量源，见上）；缺省的必填参数——它的值可以
// 来自 config.yaml 的同名键，调度没给不等于运行时没有。
// allowLiteral 为动作：值可以是 {"$literal": "..."}，按其中的字面值校验。
func validateDeclaredParams(specs []registry.ParamSpec, params map[string]any, allowLiteral bool) error {
	keys := make([]string, 0, len(params))
	for key := range params {
		keys = append(keys, key)
	}
	sort.Strings(keys) // map 遍历顺序随机：同一个文件每次报同一个键
	for _, key := range keys {
		spec, declared := findParamSpec(specs, key)
		if !declared {
			continue
		}
		value := params[key]
		text, isLiteral, err := declaredParamText(spec, key, value, allowLiteral)
		if err != nil {
			return err
		}
		switch spec.Type {
		case "select":
			if !slices.Contains(spec.Options, text) {
				return fmt.Errorf("parameter %q: value %q is not one of the options %v", key, text, spec.Options)
			}
		case "bool":
			if isLiteral || (text != "true" && text != "false") {
				return fmt.Errorf("parameter %q must be true or false", key)
			}
		case "list", "arguments":
			if _, ok := value.(string); !ok {
				return fmt.Errorf("parameter %q must use a JSON string for list/arguments values", key)
			}
			if err := registry.ValidateArrayParamValue(spec.Type, text); err != nil {
				return fmt.Errorf("parameter %q: %w", key, err)
			}
		}
		// text | path | file | textarea：字符串类参数接受任何标量（形状已由
		// validateScheduleParams 保证），没有别的可校验。
	}
	return nil
}

func findParamSpec(specs []registry.ParamSpec, id string) (registry.ParamSpec, bool) {
	for _, spec := range specs {
		if spec.ID == id {
			return spec, true
		}
	}
	return registry.ParamSpec{}, false
}

// declaredParamText 取出一个已声明参数在调度里的取值文本；值是 $literal 对象时取其中的
// 字面值（仅 allowLiteral 时合法，形状已由 validateScheduleParamValue 校验过）。
func declaredParamText(spec registry.ParamSpec, key string, value any, allowLiteral bool) (text string, isLiteral bool, err error) {
	if object, ok := value.(map[string]any); ok {
		literal, _ := object["$literal"].(string)
		if allowLiteral && spec.Type != "bool" {
			return literal, true, nil
		}
		return "", true, fmt.Errorf("parameter %q: a $literal value does not fit a %s parameter", key, paramTypeName(spec.Type))
	}
	switch v := value.(type) {
	case nil:
		return "", false, nil
	case string:
		return v, false, nil
	case bool:
		if v {
			return "true", false, nil
		}
		return "false", false, nil
	default:
		return fmt.Sprint(v), false, nil
	}
}

func paramTypeName(paramType string) string {
	if paramType == "" {
		return "text"
	}
	return paramType
}

// literalParamKeys 取出调度 params 里以 $literal 对象给出的参数键（形状已由
// validateScheduleParamValue 校验过），交给 rejectLiteralShellSubstitution。
func literalParamKeys(params map[string]any) map[string]bool {
	keys := map[string]bool{}
	for key, value := range params {
		if object, ok := value.(map[string]any); ok {
			if _, literal := object["$literal"]; literal {
				keys[key] = true
			}
		}
	}
	return keys
}

// validateScheduledAIParams 校验 AI 目标的参数键都是任务认得的输入。
func (s *Service) validateScheduledAIParams(taskID string, params map[string]any) error {
	lt, ok := s.aiRegistry().Get(taskID)
	if !ok {
		return fmt.Errorf("unknown ai task %q", taskID)
	}
	declared := make(map[string]bool, len(lt.Task.Params))
	for _, spec := range lt.Task.Params {
		declared[spec.ID] = true
	}
	keys := make([]string, 0, len(params))
	for key := range params {
		keys = append(keys, key)
	}
	// map 遍历顺序随机：排序后再报，保证同一个文件每次报同一个键。
	sort.Strings(keys)
	for _, key := range keys {
		if !declared[key] && !ai.IsReservedRunParam(key) {
			return fmt.Errorf("parameter %q is not an input of AI task %q (declared params or prompt/system/resume)", key, taskID)
		}
	}
	return nil
}

func validateScheduleParams(params map[string]any, allowLiteral bool) error {
	if _, err := json.Marshal(params); err != nil {
		return fmt.Errorf("not JSON encodable: %w", err)
	}
	for key, value := range params {
		if err := validateScheduleParamValue(key, value, allowLiteral); err != nil {
			return err
		}
	}
	return nil
}

func validateScheduleParamValue(key string, value any, allowLiteral bool) error {
	if object, ok := value.(map[string]any); ok {
		if !allowLiteral {
			return fmt.Errorf("parameter %q must be a scalar or JSON string", key)
		}
		literal, hasLiteral := object["$literal"]
		if !hasLiteral {
			return fmt.Errorf("parameter %q must be a scalar or $literal object", key)
		}
		if len(object) != 1 {
			return fmt.Errorf("parameter %q has invalid $literal object", key)
		}
		if _, ok := literal.(string); !ok {
			return fmt.Errorf("parameter %q has invalid $literal value", key)
		}
		return nil
	}
	if value != nil {
		kind := reflect.ValueOf(value).Kind()
		if kind == reflect.Map {
			return fmt.Errorf("parameter %q must be a scalar or JSON string", key)
		}
		if kind == reflect.Array || kind == reflect.Slice {
			return fmt.Errorf("parameter %q must use a JSON string for list/arguments values", key)
		}
	}
	return nil
}

func (s *Service) commitSchedulesLocked(defs []schedule.Definition) error {
	checked, err := schedule.ValidateDefinitions(defs, s.scheduleCatalog())
	if err != nil {
		return err
	}
	checked, err = s.validateRuntimeDefinitions(checked)
	if err != nil {
		return err
	}
	if err := schedule.SaveFile(s.schedulePath, checked); err != nil {
		return fmt.Errorf("save schedules: %w", err)
	}
	s.scheduleDefs = checked
	s.scheduleErrors = nil
	s.scheduler.Replace(checked)
	runs := make(map[string]*scheduleRunState, len(checked))
	for _, def := range checked {
		if state := s.scheduleRuns[def.ID]; state != nil {
			runs[def.ID] = state
		}
	}
	s.scheduleRuns = runs
	return nil
}

// SaveSchedule 新增或按 id 覆盖一条调度：校验（目标存在、params 按目标校验）通过才写回。
func (s *Service) SaveSchedule(input ScheduleInput) (ScheduleListResult, error) {
	s.scheduleMu.Lock()
	defs, err := s.checkedScheduleFile()
	if err != nil {
		s.scheduleMu.Unlock()
		return ScheduleListResult{}, err
	}
	def := schedule.Definition{ID: input.ID, Name: input.Name, Enabled: input.Enabled, Cron: input.Cron, Params: input.Params, CatchUp: input.CatchUp}
	switch schedule.TargetKind(input.TargetKind) {
	case schedule.TargetAction:
		def.Action = input.TargetID
	case schedule.TargetWorkflow:
		def.Workflow = input.TargetID
	case schedule.TargetAI:
		def.AI = input.TargetID
	default:
		s.scheduleMu.Unlock()
		return ScheduleListResult{}, fmt.Errorf("schedule %q: invalid targetKind %q (targetId %q)", input.ID, input.TargetKind, input.TargetID)
	}
	if err := s.validateScheduleTargetParams(def); err != nil {
		s.scheduleMu.Unlock()
		return ScheduleListResult{}, fmt.Errorf("schedule %q: params: %w", input.ID, err)
	}
	next := make([]schedule.Definition, 0, len(defs)+1)
	found := false
	for _, old := range defs {
		if old.ID == input.ID {
			next = append(next, def)
			found = true
		} else {
			next = append(next, old)
		}
	}
	if !found {
		next = append(next, def)
	}
	err = s.commitSchedulesLocked(next)
	s.scheduleMu.Unlock()
	if err != nil {
		return ScheduleListResult{}, err
	}
	s.emitScheduleChanged(input.ID)
	return s.ListSchedules(), nil
}

func (s *Service) DeleteSchedule(id string) (ScheduleListResult, error) {
	s.scheduleMu.Lock()
	defs, err := s.checkedScheduleFile()
	if err != nil {
		s.scheduleMu.Unlock()
		return ScheduleListResult{}, err
	}
	next := make([]schedule.Definition, 0, len(defs))
	found := false
	for _, def := range defs {
		if def.ID == id {
			found = true
		} else {
			next = append(next, def)
		}
	}
	if !found {
		s.scheduleMu.Unlock()
		return ScheduleListResult{}, fmt.Errorf("schedule %q not found", id)
	}
	if err := s.commitSchedulesLocked(next); err != nil {
		s.scheduleMu.Unlock()
		return ScheduleListResult{}, err
	}
	s.scheduleMu.Unlock()
	s.emitScheduleChanged(id)
	return s.ListSchedules(), nil
}

func (s *Service) SetScheduleEnabled(id string, enabled bool) (ScheduleListResult, error) {
	s.scheduleMu.Lock()
	defs, err := s.checkedScheduleFile()
	if err != nil {
		s.scheduleMu.Unlock()
		return ScheduleListResult{}, err
	}
	next := make([]schedule.Definition, 0, len(defs))
	found := false
	for _, def := range defs {
		if def.ID == id {
			def.Enabled = enabled
			found = true
		}
		next = append(next, def)
	}
	if !found {
		s.scheduleMu.Unlock()
		return ScheduleListResult{}, fmt.Errorf("schedule %q not found", id)
	}
	if err := s.commitSchedulesLocked(next); err != nil {
		s.scheduleMu.Unlock()
		return ScheduleListResult{}, err
	}
	s.scheduleMu.Unlock()
	s.emitScheduleChanged(id)
	return s.ListSchedules(), nil
}

// RunScheduleNow 是「立即运行」：不等到点，以该调度的参数立刻发起一次运行，
// 发起来源记为 run-now。撞上运行中的目标时把错误返回给发起人。
func (s *Service) RunScheduleNow(id string) error {
	return s.scheduler.TriggerNow(context.Background(), id)
}

// missedInstant 是调度器的「错过」回调：应用没在运行时溜走的一个调度时刻。留一条
// missed 运行记录（没有过程），不覆盖上一次真实运行的结果。
func (s *Service) missedInstant(_ context.Context, def schedule.Definition, instant time.Time) error {
	kind, id, err := def.Target()
	if err != nil {
		return err
	}
	reason := fmt.Sprintf("应用未在运行，错过 %s 的到点", instant.Format("2006-01-02 15:04"))
	runID := s.noteRun(kind, id, def.Params, &runSource{scheduleID: def.ID, origin: runstore.OriginSchedule}, runstore.StatusMissed, reason)
	s.appLog.Log("schedule.missed", map[string]any{
		"schedule_id": def.ID, "target_kind": kind, "target_id": id, "run_id": runID, "at": instant.Format(time.RFC3339),
	})
	return nil
}

// catchUp 是调度器的「补跑」回调：为最近一个错过的时刻以调度自带的参数发起一次运行，
// 发起来源仍是到点（schedule）。
func (s *Service) catchUp(_ context.Context, def schedule.Definition, instant time.Time) error {
	kind, id, _ := def.Target()
	s.appLog.Log("schedule.catch_up", map[string]any{
		"schedule_id": def.ID, "target_kind": kind, "target_id": id, "at": instant.Format(time.RFC3339),
	})
	return s.launch(def, runstore.OriginSchedule)
}

// launchSchedule 是调度到点的回调（Scheduler 的 trigger）：以调度自带的 params 发起运行，
// 发起来源为 schedule。
func (s *Service) launchSchedule(_ context.Context, def schedule.Definition) error {
	return s.launch(def, runstore.OriginSchedule)
}

// launchScheduleNow 是「立即运行」的回调：同一调度、同一份参数，发起来源为 run-now。
func (s *Service) launchScheduleNow(_ context.Context, def schedule.Definition) error {
	return s.launch(def, runstore.OriginRunNow)
}

// launch 按调度定义发起一次运行并归类结果。调度到点与立即运行都交给独立执行器
// （见 executor.go）：
//   - 发起成功：记一条到点行迹；
//   - 撞上运行中的目标（targetBusyError）：到点已留档为跳过，不算错误；立即运行把原因返回；
//   - 目标已不存在：留一条 failed 运行记录并更新调度卡的最近结果；
//   - 执行器没能拉起：运行记录与调度卡已在 launchExecutor 里落成 failed，把原因返回。
func (s *Service) launch(def schedule.Definition, origin string) error {
	kind, targetID, err := def.Target()
	if err != nil {
		return err
	}
	source := &runSource{scheduleID: def.ID, origin: origin}
	err = s.launchScheduled(kind, targetID, def.Params, source)
	var busy *targetBusyError
	switch {
	case err == nil:
		s.appLog.Log("schedule.trigger", map[string]any{
			"schedule_id": def.ID, "origin": origin, "target_kind": kind, "target_id": targetID, "run_id": source.runID,
		})
		return nil
	case errors.As(err, &busy):
		if busy.skipped {
			return nil // 到点撞上运行中的目标：已留档为跳过，不算错误
		}
		return err // 立即运行撞上：把「已在运行，已跳过」返回给发起人
	case source.runID != "":
		// 执行器没能拉起：运行记录与调度卡已在 launchExecutor 里交代过，这里只记行迹
		s.appLog.Log("schedule.executor_failed", map[string]any{
			"schedule_id": def.ID, "origin": origin, "target_kind": kind, "target_id": targetID,
			"run_id": source.runID, "error": err.Error(),
		})
		return err
	}
	s.appLog.Log("schedule.launch_failed", map[string]any{
		"schedule_id": def.ID, "origin": origin, "target_kind": kind, "target_id": targetID, "error": err.Error(),
	})
	s.failScheduleStart(def, origin, err)
	return err
}

// launchScheduled 发起一次调度运行；目标已被卸载时不拉执行器，直接报启动失败。
func (s *Service) launchScheduled(kind target.Kind, id string, params map[string]any, source *runSource) error {
	if !s.knownTarget(kind, id) {
		return fmt.Errorf("unknown %s %q", kind, id)
	}
	return s.launchExecutor(kind, id, params, source)
}

// knownTarget 报告某种类的目标当前是否已加载。
func (s *Service) knownTarget(kind target.Kind, id string) bool {
	switch kind {
	case target.Action:
		_, ok := s.actionRegistry().Actions[id]
		return ok
	case target.Workflow:
		_, ok := s.workflowRegistry().Workflows[id]
		return ok
	case target.AI:
		_, ok := s.aiRegistry().Get(id)
		return ok
	}
	return false
}
