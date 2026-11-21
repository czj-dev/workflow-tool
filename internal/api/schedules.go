package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"

	"workflow-tool/internal/schedule"
)

type ScheduleInput struct {
	ID         string         `json:"id"`
	Name       string         `json:"name"`
	Enabled    bool           `json:"enabled"`
	Cron       string         `json:"cron"`
	TargetKind string         `json:"targetKind"`
	TargetID   string         `json:"targetId"`
	Params     map[string]any `json:"params"`
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

type runSource struct {
	scheduleID string
	token      uint64
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
}

func (s *Service) startScheduleRun(id string) *scheduledRun {
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
	s.scheduleRuns[id] = &scheduleRunState{
		Running:   true,
		Token:     token,
		StartedAt: now,
		LastRun: &LastRun{
			Status:    "running",
			StartedAt: now.Format(time.RFC3339Nano),
			ExitCode:  -1,
		},
	}
	return &scheduledRun{source: &runSource{scheduleID: id, token: token}, token: token}
}

func (s *Service) finishScheduleRun(source *runSource, token uint64, exitCode int, runErr error, duration time.Duration) {
	if source == nil {
		return
	}
	now := time.Now()
	status := "success"
	if exitCode != 0 {
		status = "failed"
		if errors.Is(runErr, context.Canceled) || errors.Is(runErr, context.DeadlineExceeded) {
			status = "cancelled"
		}
	}
	last := &LastRun{
		Status:     status,
		StartedAt:  now.Add(-duration).Format(time.RFC3339Nano),
		FinishedAt: now.Format(time.RFC3339Nano),
		ExitCode:   exitCode,
		Duration:   duration.String(),
		Error:      errStr(runErr),
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

func (s *Service) failScheduleStart(id string, runErr error) {
	now := time.Now()
	last := &LastRun{Status: "failed", StartedAt: now.Format(time.RFC3339Nano), FinishedAt: now.Format(time.RFC3339Nano), ExitCode: -1, Duration: "0s", Error: errStr(runErr)}
	s.scheduleMu.Lock()
	state := s.scheduleRuns[id]
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
	s.scheduleRuns[id] = &scheduleRunState{Token: token, LastRun: last}
	s.scheduleMu.Unlock()
	s.emitScheduleChanged(id)
}

func (s *Service) emitScheduleChanged(id string) {
	if s.scheduleEmit == nil {
		return
	}
	for _, item := range s.ListSchedules().Schedules {
		if item.ID == id {
			s.scheduleEmit("schedules:changed", item)
			return
		}
	}
}

func (s *Service) scheduleCatalog() schedule.TargetCatalog {
	catalog := schedule.TargetCatalog{Actions: map[string]struct{}{}, Workflows: map[string]struct{}{}}
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
	return catalog
}

func (s *Service) ListSchedules() ScheduleListResult {
	s.scheduleMu.Lock()
	defs, errs, runs := s.scheduleSnapshotLocked()
	s.scheduleMu.Unlock()
	return projectSchedules(defs, errs, runs)
}

func (s *Service) scheduleSnapshotLocked() ([]schedule.Definition, []error, map[string]*scheduleRunState) {
	catalog := schedule.TargetCatalog{Actions: map[string]struct{}{}, Workflows: map[string]struct{}{}}
	for _, def := range s.scheduleDefs {
		if def.Action != "" {
			catalog.Actions[def.Action] = struct{}{}
		} else {
			catalog.Workflows[def.Workflow] = struct{}{}
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
		runs[id] = copyState
	}
	return defs, errs, runs
}

func projectSchedules(defs []schedule.Definition, scheduleErrors []error, runs map[string]*scheduleRunState) ScheduleListResult {
	result := ScheduleListResult{Schedules: make([]ScheduleItem, 0, len(defs)), Errors: make([]string, 0, len(scheduleErrors))}
	for _, err := range scheduleErrors {
		result.Errors = append(result.Errors, err.Error())
	}
	now := time.Now()
	for _, def := range defs {
		kind, target, _ := def.Target()
		item := ScheduleItem{ID: def.ID, Name: def.Name, Enabled: def.Enabled, Cron: def.Cron, TargetKind: string(kind), TargetID: target, Params: def.Params}
		if cron, err := schedule.Parse(def.Cron); err == nil {
			if next, ok := cron.NextAfter(now); ok {
				item.NextRun = next.Format(time.RFC3339)
			}
		}
		if state := runs[def.ID]; state != nil {
			item.Running = state.Running
			if state.LastRun != nil {
				last := *state.LastRun
				item.LastRun = &last
			}
		}
		result.Schedules = append(result.Schedules, item)
	}
	return result
}

func (s *Service) reconcileSchedules() {
	defs, errs := schedule.LoadFile(s.schedulePath, s.scheduleCatalog())
	defs, errs = validateLoadedScheduleDefinitions(defs, errs)
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
	return validateRuntimeDefinitions(defs)
}

func validateRuntimeDefinitions(defs []schedule.Definition) ([]schedule.Definition, error) {
	for _, def := range defs {
		if err := validateScheduleParams(def.Params, def.Action != ""); err != nil {
			return nil, fmt.Errorf("schedule %q: params: %w", def.ID, err)
		}
	}
	return defs, nil
}

func validateLoadedScheduleDefinitions(defs []schedule.Definition, scheduleErrors []error) ([]schedule.Definition, []error) {
	valid := make([]schedule.Definition, 0, len(defs))
	errors := append([]error{}, scheduleErrors...)
	for _, def := range defs {
		if err := validateScheduleParams(def.Params, def.Action != ""); err != nil {
			errors = append(errors, fmt.Errorf("schedule %q: params: %w", def.ID, err))
			continue
		}
		valid = append(valid, def)
	}
	return valid, errors
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
	checked, err = validateRuntimeDefinitions(checked)
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

func (s *Service) SaveSchedule(input ScheduleInput) (ScheduleListResult, error) {
	s.scheduleMu.Lock()
	defs, err := s.checkedScheduleFile()
	if err != nil {
		s.scheduleMu.Unlock()
		return ScheduleListResult{}, err
	}
	def := schedule.Definition{ID: input.ID, Name: input.Name, Enabled: input.Enabled, Cron: input.Cron, Params: input.Params}
	switch schedule.TargetKind(input.TargetKind) {
	case schedule.TargetAction:
		def.Action = input.TargetID
	case schedule.TargetWorkflow:
		def.Workflow = input.TargetID
	default:
		s.scheduleMu.Unlock()
		return ScheduleListResult{}, fmt.Errorf("schedule %q: invalid targetKind %q (targetId %q)", input.ID, input.TargetKind, input.TargetID)
	}
	if err := validateScheduleParams(def.Params, def.Action != ""); err != nil {
		s.scheduleMu.Unlock()
		return ScheduleListResult{}, fmt.Errorf("schedule %q: params: %w", input.ID, err)
	}
	if def.Action != "" {
		if err := s.validateScheduledActionParams(def.Action, def.Params); err != nil {
			s.scheduleMu.Unlock()
			return ScheduleListResult{}, fmt.Errorf("schedule %q: %w", input.ID, err)
		}
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

func (s *Service) validateScheduledActionParams(actionID string, params map[string]any) error {
	reg := s.actionRegistry()
	action, ok := reg.Actions[actionID]
	if !ok {
		return fmt.Errorf("unknown action %q", actionID)
	}
	for key, value := range params {
		if object, ok := value.(map[string]any); ok {
			if _, literal := object["$literal"]; literal && strings.Contains(action.Def.Command.Run, "${"+key+"}") {
				return fmt.Errorf("parameter %q is literal but action command interpolates it", key)
			}
		}
	}
	return nil
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

func (s *Service) RunScheduleNow(id string) error {
	return s.scheduler.TriggerNow(context.Background(), id)
}

func (s *Service) launchSchedule(_ context.Context, def schedule.Definition) error {
	kind, target, err := def.Target()
	if err != nil {
		return err
	}
	source := &runSource{scheduleID: def.ID}
	switch kind {
	case schedule.TargetAction:
		return s.runAction(target, def.Params, source)
	case schedule.TargetWorkflow:
		return s.runWorkflow(target, def.Params, source)
	default:
		err := fmt.Errorf("schedule %q: unsupported target %q", def.ID, kind)
		s.failScheduleStart(def.ID, err)
		return err
	}
}
