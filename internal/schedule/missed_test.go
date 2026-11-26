package schedule

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 错过（missed）与补跑（catch_up）：调度器持久化每条调度上次被评估到的时刻；应用恢复后
// 把其间溜走的到点逐个报出来，开了补跑的调度只为最近一个错过的时刻补发一次运行。

func everyMinute(id string, catchUp bool) Definition {
	return Definition{ID: id, Name: id, Enabled: true, Cron: "* * * * *", Action: "run", CatchUp: catchUp}
}

// missedRig 把「应用的一次生命周期」收进一个调度器，并记下它报出的错过与补跑。
type missedRig struct {
	statePath string
	missed    map[string][]time.Time
	catchUps  map[string][]time.Time
	triggered []string
}

func newMissedRig(t *testing.T) *missedRig {
	t.Helper()
	return &missedRig{
		statePath: filepath.Join(t.TempDir(), "schedules.state.json"),
		missed:    map[string][]time.Time{},
		catchUps:  map[string][]time.Time{},
	}
}

// life 起一个调度器（= 应用的一次生命周期），按给定的时刻各走一个 tick。
func (r *missedRig) life(defs ...Definition) *Scheduler {
	s := NewScheduler(defs, func(_ context.Context, def Definition) error {
		r.triggered = append(r.triggered, def.ID)
		return nil
	})
	s.TrackMissed(r.statePath, MissedHandlers{
		Missed: func(_ context.Context, def Definition, instant time.Time) error {
			r.missed[def.ID] = append(r.missed[def.ID], instant)
			return nil
		},
		CatchUp: func(_ context.Context, def Definition, instant time.Time) error {
			r.catchUps[def.ID] = append(r.catchUps[def.ID], instant)
			return nil
		},
	})
	return s
}

// 应用 10:07 还在，10:30 才恢复：其间的每个到点都是错过，逐个报出。
func TestMissedInstantsAreReportedAfterDowntime(t *testing.T) {
	rig := newMissedRig(t)
	runSchedulerTicks(rig.life(everyMinute("a", false)), schedulerTime(7, 5))

	// 恢复后的第一个 tick：先报 10:08 到 10:29 的错过，再照常评估当前这一分钟
	restored := rig.life(everyMinute("a", false))
	runSchedulerTicks(restored, schedulerTime(30, 1), schedulerTime(30, 31))

	missed := rig.missed["a"]
	if len(missed) != 22 || !first(missed).Equal(schedulerTime(8, 0)) || !last(missed).Equal(schedulerTime(29, 0)) {
		t.Fatalf("missed = %d instants from %s to %s, want 22 from 10:08 to 10:29", len(missed), first(missed), last(missed))
	}
	// 当前这一分钟（10:30）不是错过：它照常触发，且同一分钟的两个 tick 只触发一次
	if len(rig.triggered) != 2 || rig.triggered[0] != "a" || rig.triggered[1] != "a" {
		t.Fatalf("triggered = %v, want the 10:07 run and one 10:30 run", rig.triggered)
	}
	if len(rig.catchUps["a"]) != 0 {
		t.Fatalf("catch-up must stay off by default: %v", rig.catchUps["a"])
	}
}

// 补跑开启：只为最近一个错过的时刻补发一次运行。
func TestCatchUpRunsOnceForTheLatestMissedInstant(t *testing.T) {
	rig := newMissedRig(t)
	def := everyMinute("a", true)
	runSchedulerTicks(rig.life(def), schedulerTime(7, 5))
	runSchedulerTicks(rig.life(def), schedulerTime(9, 1))

	if got := rig.catchUps["a"]; len(got) != 1 || !got[0].Equal(schedulerTime(8, 0)) {
		t.Fatalf("catch-ups = %v, want exactly one for 10:08", got)
	}
	if len(rig.missed["a"]) != 1 || !rig.missed["a"][0].Equal(schedulerTime(8, 0)) {
		t.Fatalf("the caught-up instant is still recorded as missed: %v", rig.missed["a"])
	}
	// 补跑不占当前这一分钟的正常触发
	if len(rig.triggered) != 2 {
		t.Fatalf("triggered = %v, want the 10:07 run, the catch-up is reported separately, and the 10:09 run", rig.triggered)
	}
}

// 错过的时刻太多时只保留最近的若干个：每分钟一条的调度停用一个月，不该落下四万条记录。
func TestMissedReportingIsCappedToTheMostRecent(t *testing.T) {
	rig := newMissedRig(t)
	runSchedulerTicks(rig.life(everyMinute("a", false)), schedulerTime(7, 5))
	// 恢复时刻取三十天以后
	restoredAt := schedulerTime(7, 5).Add(30 * 24 * time.Hour)
	runSchedulerTicks(rig.life(everyMinute("a", false)), restoredAt)

	missed := rig.missed["a"]
	if len(missed) != MaxMissedPerSchedule || !last(missed).Equal(restoredAt.Truncate(time.Minute).Add(-time.Minute)) {
		t.Fatalf("missed = %d instants ending at %s, want the %d most recent ending right before %s",
			len(missed), last(missed), MaxMissedPerSchedule, restoredAt)
	}
}

// 调度停用期间不算错过：停用时时刻照常推进，重新启用后不翻旧账。
func TestDisabledPeriodIsNotMissed(t *testing.T) {
	rig := newMissedRig(t)
	on := everyMinute("a", false)
	off := on
	off.Enabled = false
	runSchedulerTicks(rig.life(on), schedulerTime(7, 5))
	// 应用一直开着，10:08 把它停掉，10:10 再启用
	s := rig.life(off)
	runSchedulerTicks(s, schedulerTime(8, 1))
	s.Replace([]Definition{on})
	runSchedulerTicks(s, schedulerTime(10, 1))
	if len(rig.missed["a"]) != 0 {
		t.Fatalf("minutes spent disabled were reported as missed: %v", rig.missed["a"])
	}

	// 停用期间应用退出、恢复后仍停用，再启用：同样不算错过
	runSchedulerTicks(rig.life(off), schedulerTime(8, 1))
	s = rig.life(off)
	runSchedulerTicks(s, schedulerTime(40, 1))
	s.Replace([]Definition{on})
	runSchedulerTicks(s, schedulerTime(50, 1))
	if len(rig.missed["a"]) != 0 {
		t.Fatalf("downtime while disabled was reported as missed after re-enabling: %v", rig.missed["a"])
	}
}

// 改了时间规则的调度没有「上次到点」可言：不按新规则去翻旧账。
func TestChangedCronHasNoHistory(t *testing.T) {
	rig := newMissedRig(t)
	runSchedulerTicks(rig.life(everyMinute("a", false)), schedulerTime(7, 5))
	changed := everyMinute("a", false)
	changed.Cron = "5 * * * *"
	runSchedulerTicks(rig.life(changed), schedulerTime(9, 1))
	if len(rig.missed["a"]) != 0 {
		t.Fatalf("a changed cron reported missed instants: %v", rig.missed["a"])
	}
}

// 没有持久化状态（上一次运行早于本功能，或调度刚建）：不编造错过。
func TestNoHistoryMeansNothingMissed(t *testing.T) {
	rig := newMissedRig(t)
	runSchedulerTicks(rig.life(everyMinute("a", false)), schedulerTime(7, 5))
	if len(rig.missed["a"]) != 0 {
		t.Fatalf("first ever tick reported missed instants: %v", rig.missed["a"])
	}
	if _, err := os.Stat(rig.statePath); err != nil {
		t.Fatalf("state file not written after the first tick: %v", err)
	}
}

// 没开错过追踪的调度器行为不变：不报错过、不写状态文件。
func TestSchedulerWithoutTrackingReportsNothing(t *testing.T) {
	rig := newMissedRig(t)
	s := NewScheduler([]Definition{everyMinute("a", false)}, func(context.Context, Definition) error { return nil })
	runSchedulerTicks(s, schedulerTime(7, 5), schedulerTime(30, 1))
	if _, err := os.Stat(rig.statePath); !os.IsNotExist(err) {
		t.Fatalf("state file written without tracking: %v", err)
	}
}

// 删掉调度后它的状态一并清掉；同一个 id 日后重建时不继承旧历史。
func TestReplaceDropsStateOfRemovedSchedules(t *testing.T) {
	rig := newMissedRig(t)
	s := rig.life(everyMinute("a", false))
	runSchedulerTicks(s, schedulerTime(7, 5))
	s.Replace(nil)
	if _, err := os.Stat(rig.statePath); os.IsNotExist(err) {
		t.Fatal("state file should still exist (now empty)")
	}
	runSchedulerTicks(rig.life(everyMinute("a", false)), schedulerTime(30, 1))
	if len(rig.missed["a"]) != 0 {
		t.Fatalf("a re-created schedule inherited the deleted one's history: %v", rig.missed["a"])
	}
}

// 时钟回拨不是错过，也不能把「上次评估时刻」改早——否则时间回到原处后会把处理过的时刻
// 再报一遍。
func TestClockRollbackIsNotMissedAndDoesNotRewindHistory(t *testing.T) {
	rig := newMissedRig(t)
	s := rig.life(everyMinute("a", false))
	runSchedulerTicks(s, schedulerTime(30, 1))
	runSchedulerTicks(s, schedulerTime(10, 1))
	if len(rig.missed["a"]) != 0 {
		t.Fatalf("a clock rollback was reported as missed instants: %v", rig.missed["a"])
	}
	if mark := s.lastSeen["a"]; !mark.Seen.Equal(schedulerTime(30, 0)) {
		t.Fatalf("rollback rewound the history to %s", mark.Seen)
	}
	// 时间回到原处之后：10:31 起才是没被评估过的时刻
	runSchedulerTicks(s, schedulerTime(45, 1))
	missed := rig.missed["a"]
	if len(missed) != 14 || !first(missed).Equal(schedulerTime(31, 0)) || !last(missed).Equal(schedulerTime(44, 0)) {
		t.Fatalf("missed after the clock recovers = %v, want 10:31 through 10:44", missed)
	}
}

// catch_up 是 schedules.yaml 里的字段，存取往返保真，缺省为 false。
func TestCatchUpRoundTripsThroughTheFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "schedules.yaml")
	if err := SaveFile(path, []Definition{
		{ID: "on", Name: "On", Enabled: true, Cron: "0 2 * * *", Action: "run", CatchUp: true},
		{ID: "off", Name: "Off", Enabled: true, Cron: "0 3 * * *", Action: "run"},
	}); err != nil {
		t.Fatal(err)
	}
	defs, errs := LoadFile(path, TargetCatalog{Actions: map[string]struct{}{"run": {}}})
	if len(errs) != 0 || len(defs) != 2 {
		t.Fatalf("LoadFile = %v, %v", defs, errs)
	}
	if !defs[0].CatchUp || defs[1].CatchUp {
		t.Fatalf("CatchUp = %v / %v, want true / false", defs[0].CatchUp, defs[1].CatchUp)
	}
	body, _ := os.ReadFile(path)
	if strings.Contains(string(body), "catch_up: false") || !strings.Contains(string(body), "catch_up: true") {
		t.Fatalf("only an enabled catch_up should be written: %s", body)
	}
}

func first(instants []time.Time) time.Time { return instants[0] }
func last(instants []time.Time) time.Time  { return instants[len(instants)-1] }
