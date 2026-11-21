package schedule

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"
)

type TriggerFunc func(context.Context, Definition) error

type Scheduler struct {
	mu          sync.Mutex
	definitions []Definition
	triggered   map[string]map[int64]struct{}
	generation  uint64
	trigger     TriggerFunc
}

func NewScheduler(defs []Definition, trigger TriggerFunc) *Scheduler {
	s := &Scheduler{trigger: trigger, triggered: make(map[string]map[int64]struct{})}
	s.Replace(defs)
	return s
}

func snapshotDefinitions(defs []Definition) ([]Definition, error) {
	result := make([]Definition, 0, len(defs))
	seen := make(map[string]struct{}, len(defs))
	for i, def := range defs {
		validated, err := validateDefinition(def, nil)
		if err != nil {
			return nil, fmt.Errorf("schedule entry %d: %w", i+1, err)
		}
		if _, duplicate := seen[validated.ID]; duplicate {
			return nil, fmt.Errorf("schedule entry %d: duplicate schedule id %q", i+1, validated.ID)
		}
		seen[validated.ID] = struct{}{}
		result = append(result, validated)
	}
	return result, nil
}

func (s *Scheduler) Replace(defs []Definition) {
	snapshot, err := snapshotDefinitions(defs)
	if err != nil {
		log.Printf("replace schedules: %v", err)
		return
	}
	ids := make(map[string]struct{}, len(snapshot))
	for _, def := range snapshot {
		ids[def.ID] = struct{}{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.definitions = snapshot
	s.generation++
	for id := range s.triggered {
		if _, exists := ids[id]; !exists {
			delete(s.triggered, id)
		}
	}
}

func scheduleMinute(instant time.Time) time.Time {
	return instant.Add(-time.Duration(instant.Second())*time.Second - time.Duration(instant.Nanosecond()))
}

func (s *Scheduler) Run(ctx context.Context, now func() time.Time, tick <-chan time.Time) {
	for {
		select {
		case <-ctx.Done():
			return
		case _, ok := <-tick:
			if !ok {
				return
			}
		}
		if ctx.Err() != nil {
			return
		}
		minute := scheduleMinute(now())
		s.mu.Lock()
		generation := s.generation
		var due []Definition
		minuteKey := minute.Unix()
		for _, def := range s.definitions {
			if !def.Enabled {
				continue
			}
			if _, triggered := s.triggered[def.ID][minuteKey]; triggered {
				continue
			}
			cron, err := Parse(def.Cron)
			if err != nil {
				log.Printf("schedule %q: invalid cron: %v", def.ID, err)
				continue
			}
			if cron.Matches(minute) {
				params, err := cloneParams(def.Params)
				if err != nil {
					log.Printf("schedule %q: invalid params: %v", def.ID, err)
					continue
				}
				due = append(due, Definition{ID: def.ID, Name: def.Name, Enabled: def.Enabled, Cron: def.Cron,
					Action: def.Action, Workflow: def.Workflow, Params: params})
			}
		}
		s.mu.Unlock()
		for _, def := range due {
			if ctx.Err() != nil {
				return
			}
			if scheduleMinute(now()).Unix() != minuteKey {
				break
			}
			s.mu.Lock()
			if s.generation != generation {
				s.mu.Unlock()
				break
			}
			history := s.triggered[def.ID]
			if _, triggered := history[minuteKey]; !def.Enabled || triggered {
				s.mu.Unlock()
				continue
			}
			if history == nil {
				history = make(map[int64]struct{})
				s.triggered[def.ID] = history
			}
			history[minuteKey] = struct{}{}
			s.mu.Unlock()
			if err := s.trigger(ctx, def); err != nil {
				log.Printf("schedule %q: trigger failed: %v", def.ID, err)
			}
		}
	}
}

func (s *Scheduler) TriggerNow(ctx context.Context, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	var found Definition
	exists := false
	for _, def := range s.definitions {
		if def.ID == id {
			found = def
			exists = true
			break
		}
	}
	if exists {
		params, err := cloneParams(found.Params)
		if err != nil {
			s.mu.Unlock()
			return fmt.Errorf("schedule %q: invalid params: %w", id, err)
		}
		found.Params = params
	}
	s.mu.Unlock()
	if !exists {
		return fmt.Errorf("schedule %q not found", id)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.trigger(ctx, found); err != nil {
		return fmt.Errorf("schedule %q: trigger failed: %w", id, err)
	}
	return nil
}
