package schedule

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"
)

// TriggerFunc 是到点发起运行的回调。收到的 Definition 是调度定义的克隆（Params 可改）。
type TriggerFunc func(context.Context, Definition) error

type Scheduler struct {
	mu          sync.Mutex
	definitions []Definition
	triggered   map[string]map[int64]struct{}
	generation  uint64
	trigger     TriggerFunc
	// nowTrigger 是「立即运行」专用的回调（nil 时回落到 trigger）。调度到点与立即运行
	// 指向同一目标，但撞上运行中的目标时处置不同：前者记为跳过，后者返回错误——
	// 调用方据此区分发起来源。
	nowTrigger TriggerFunc
	// 错过与补跑（见 missed.go）：statePath 非空时追踪每条调度上次被评估到的时刻。
	statePath string
	lastSeen  map[string]lastSeenMark
	handlers  MissedHandlers
}

func NewScheduler(defs []Definition, trigger TriggerFunc) *Scheduler {
	s := &Scheduler{trigger: trigger, triggered: make(map[string]map[int64]struct{}), lastSeen: map[string]lastSeenMark{}}
	s.Replace(defs)
	return s
}

// SetTriggerNow 指定「立即运行」（TriggerNow）使用的回调；传 nil 恢复为与到点共用 trigger。
func (s *Scheduler) SetTriggerNow(trigger TriggerFunc) {
	s.mu.Lock()
	s.nowTrigger = trigger
	s.mu.Unlock()
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
	dropped := false
	for id := range s.triggered {
		if _, exists := ids[id]; !exists {
			delete(s.triggered, id)
		}
	}
	// 被删掉的调度不再有「上次评估时刻」：同一个 id 日后重建时不继承旧历史。
	for id := range s.lastSeen {
		if _, exists := ids[id]; !exists {
			delete(s.lastSeen, id)
			dropped = true
		}
	}
	if dropped {
		s.saveSeenLocked()
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
		// 每个 tick 先对账：应用恢复后的第一个 tick 在这里补报停机期间溜走的调度时刻，
		// 之后是系统睡眠之类的 tick 断档。
		s.reconcileMissed(ctx, minute)
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
				// 整份克隆：新增目标键（如 ai）时这里不会漏拷。
				dueDef := def
				dueDef.Params = params
				due = append(due, dueDef)
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
	s.mu.Lock()
	trigger := s.nowTrigger
	if trigger == nil {
		trigger = s.trigger
	}
	s.mu.Unlock()
	if err := trigger(ctx, found); err != nil {
		return fmt.Errorf("schedule %q: trigger failed: %w", id, err)
	}
	return nil
}
