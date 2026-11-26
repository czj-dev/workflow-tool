package schedule

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"time"
)

// 错过（missed）与补跑（catch_up）。
//
// 调度器把每条调度「上次被评估到的时刻」持久化到应用目录：每个 tick 过后它就是当前这一
// 分钟。应用恢复后，从上次评估到的时刻到现在的每一个到点都是错过——逐个报给
// MissedHandlers.Missed（应用为每个错过的时刻留一条 missed 运行记录）；开了 catch_up
// 的调度另为最近一个错过的时刻补发一次运行（CatchUp）。
//
// 应用开着但系统睡眠时 tick 会断档，断档里的到点同样被当作错过报出。

// MaxMissedPerSchedule 是一条调度一次恢复最多报出多少个错过的时刻。每分钟一条的调度
// 停用一个月就是四万多个，逐个留档没有意义——只保留最近的这些，更早的丢弃。
const MaxMissedPerSchedule = 50

// MissedHandlers 是应用对「错过」的处置。
type MissedHandlers struct {
	// Missed 报告一个错过的调度时刻：instant 是本该到点的时刻。
	Missed func(ctx context.Context, def Definition, instant time.Time) error
	// CatchUp 请求为 instant（最近一个错过的时刻）补发一次运行；只在 def.CatchUp 为真
	// 且确有错过时调用，在全部 Missed 之后。
	CatchUp func(ctx context.Context, def Definition, instant time.Time) error
}

// lastSeenMark 是一条调度上次被评估到的时刻，连同当时的 enabled 与 cron——两者任一改过，
// 旧时刻就不能再用（重新启用或改时间规则之后，不按新规则去翻旧账）。
type lastSeenMark struct {
	Seen    time.Time `json:"seen"`
	Cron    string    `json:"cron"`
	Enabled bool      `json:"enabled"`
}

// TrackMissed 开启错过追踪：statePath 是持久化「上次评估到的时刻」的文件，每次 tick
// 推进时原子改写。不调用则调度器不报错过、不写文件（行为与追踪之前完全一致）。
func (s *Scheduler) TrackMissed(statePath string, handlers MissedHandlers) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.statePath, s.handlers = statePath, handlers
	s.loadSeenLocked()
}

// reconcileMissed 报出从上次评估到 minute 之间溜走的到点，再把每条调度的「上次评估
// 时刻」推进到 minute。当前这一分钟不属于错过——它由调用方按常规路径评估。
func (s *Scheduler) reconcileMissed(ctx context.Context, minute time.Time) {
	if s.statePath == "" {
		return
	}
	s.mu.Lock()
	changed := false
	for _, def := range s.definitions {
		mark, hasMark := s.lastSeen[def.ID]
		if hasMark && mark.Seen.Before(minute) && mark.Cron == def.Cron && mark.Enabled == def.Enabled && def.Enabled {
			s.reportMissed(ctx, def, mark.Seen, minute)
		}
		// 时钟回拨（minute 早于已记下的时刻）不动记录：否则时间回到原处后会把处理过的
		// 时刻再报一遍。
		if !hasMark || minute.After(mark.Seen) {
			s.lastSeen[def.ID] = lastSeenMark{Seen: minute, Cron: def.Cron, Enabled: def.Enabled}
			changed = true
		}
	}
	if changed {
		s.saveSeenLocked()
	}
	s.mu.Unlock()
}

// reportMissed 报出 (after, before) 之间的到点，按需补跑。调用方须持有 s.mu；回调期间
// 不持锁（回调会去发起运行）。
func (s *Scheduler) reportMissed(ctx context.Context, def Definition, after, before time.Time) {
	cron, err := Parse(def.Cron)
	if err != nil {
		return
	}
	missed := dueBetween(cron, after, before, MaxMissedPerSchedule)
	if len(missed) == 0 {
		return
	}
	s.mu.Unlock()
	defer s.mu.Lock()
	for _, instant := range missed {
		if ctx.Err() != nil {
			return
		}
		if err := s.handlers.Missed(ctx, cloneDefinition(def), instant); err != nil {
			log.Printf("schedule %q: report missed instant: %v", def.ID, err)
		}
	}
	latest := missed[len(missed)-1]
	if def.CatchUp {
		if err := s.handlers.CatchUp(ctx, cloneDefinition(def), latest); err != nil {
			log.Printf("schedule %q: catch up: %v", def.ID, err)
		}
	}
}

// dueBetween 返回 (after, before) 之间的到点时刻，按时间升序；超过 limit 个时只保留最近
// 的 limit 个。
func dueBetween(cron Cron, after, before time.Time, limit int) []time.Time {
	var due []time.Time
	for t, ok := cron.NextAfter(after); ok && t.Before(before); t, ok = cron.NextAfter(t) {
		due = append(due, t)
		if len(due) > limit {
			due = due[1:]
		}
	}
	return due
}

// cloneDefinition 复制定义供回调使用（沿用 trigger 的约定：回调拿到的是克隆）。
func cloneDefinition(def Definition) Definition {
	params, err := cloneParams(def.Params)
	if err == nil {
		def.Params = params
	}
	return def
}

// loadSeenLocked 读回上次评估到的时刻。文件不存在或读不懂都当作没有历史：宁可漏报
// 错过，也不凭残缺的状态编造。调用方须持有 s.mu。
func (s *Scheduler) loadSeenLocked() {
	data, err := os.ReadFile(s.statePath)
	if err != nil {
		return
	}
	var marks map[string]lastSeenMark
	if err := json.Unmarshal(data, &marks); err != nil {
		log.Printf("schedule state %q: unreadable, starting without history: %v", s.statePath, err)
		return
	}
	for id, mark := range marks {
		if !mark.Seen.IsZero() {
			s.lastSeen[id] = mark
		}
	}
}

// saveSeenLocked 原子改写状态文件：先写同目录临时文件再改名。调用方须持有 s.mu。
func (s *Scheduler) saveSeenLocked() {
	data, err := json.Marshal(s.lastSeen)
	if err == nil {
		err = os.MkdirAll(filepath.Dir(s.statePath), 0o755)
	}
	var tmp *os.File
	if err == nil {
		tmp, err = os.CreateTemp(filepath.Dir(s.statePath), "."+filepath.Base(s.statePath)+".*.tmp")
	}
	if err == nil {
		_, err = tmp.Write(data)
		err = errors.Join(err, tmp.Close())
	}
	if err == nil {
		err = os.Rename(tmp.Name(), s.statePath)
	}
	if err != nil {
		log.Printf("schedule state %q: save failed: %v", s.statePath, err)
		if tmp != nil {
			_ = os.Remove(tmp.Name())
		}
	}

}
