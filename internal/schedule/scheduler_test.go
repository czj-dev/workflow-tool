package schedule

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func schedulerTime(minute, second int) time.Time {
	return time.Date(2026, 11, 12, 10, minute, second, 0, time.UTC)
}

func runSchedulerTicks(s *Scheduler, times ...time.Time) {
	for _, instant := range times {
		ticks := make(chan time.Time, 1)
		ticks <- instant
		close(ticks)
		s.Run(context.Background(), func() time.Time { return instant }, ticks)
	}
}

func TestSchedulerTriggersEnabledScheduleOncePerMinute(t *testing.T) {
	var triggered []string
	s := NewScheduler([]Definition{{ID: "a", Name: "A", Enabled: true, Cron: "7 10 * * *", Action: "run"}}, func(_ context.Context, def Definition) error {
		triggered = append(triggered, def.ID)
		return nil
	})
	runSchedulerTicks(s, schedulerTime(7, 1), schedulerTime(7, 29), schedulerTime(7, 59), schedulerTime(7, 1).Add(24*time.Hour))
	if !reflect.DeepEqual(triggered, []string{"a", "a"}) {
		t.Fatalf("triggered = %v, want one per matching minute", triggered)
	}
}

func TestSchedulerRunHandlesMultipleTicksWithoutRestart(t *testing.T) {
	var triggered int
	s := NewScheduler([]Definition{{ID: "a", Name: "A", Enabled: true, Cron: "* * * * *", Action: "run"}}, func(context.Context, Definition) error {
		triggered++
		return nil
	})
	ticks := make(chan time.Time, 3)
	for range 3 {
		ticks <- time.Time{}
	}
	close(ticks)
	instants := []time.Time{
		schedulerTime(7, 1), schedulerTime(7, 29),
		schedulerTime(7, 59), schedulerTime(8, 1), schedulerTime(8, 29),
	}
	index := 0
	s.Run(context.Background(), func() time.Time {
		instant := instants[index]
		index++
		return instant
	}, ticks)
	if triggered != 2 || index != len(instants) {
		t.Fatalf("triggered %d times using %d clock samples, want 2 across three ticks with %d samples", triggered, index, len(instants))
	}
}

func TestSchedulerConcurrentRunsTriggerSameMinuteOnce(t *testing.T) {
	instant := schedulerTime(7, 1)
	var triggered atomic.Int32
	s := NewScheduler([]Definition{{ID: "a", Name: "A", Enabled: true, Cron: "* * * * *", Action: "run"}}, func(context.Context, Definition) error {
		triggered.Add(1)
		return nil
	})
	ready := make(chan struct{}, 2)
	release := make(chan struct{})
	var runs sync.WaitGroup
	for range 2 {
		runs.Add(1)
		go func() {
			defer runs.Done()
			ticks := make(chan time.Time, 1)
			ticks <- instant
			close(ticks)
			calls := 0
			s.Run(context.Background(), func() time.Time {
				calls++
				if calls == 1 {
					ready <- struct{}{}
					<-release
				}
				return instant
			}, ticks)
		}()
	}
	<-ready
	<-ready
	close(release)
	runs.Wait()
	if got := triggered.Load(); got != 1 {
		t.Fatalf("triggered %d times across concurrent runs, want once", got)
	}
}

func TestSchedulerDispatchComparesWallMinuteAcrossLocations(t *testing.T) {
	instant := time.Now()
	instant = instant.Add(-time.Duration(instant.Second())*time.Second - time.Duration(instant.Nanosecond()))
	_, offset := instant.Zone()
	current := instant.Add(time.Second)
	var triggered []string
	s := NewScheduler([]Definition{
		{ID: "a", Name: "A", Enabled: true, Cron: "* * * * *", Action: "first"},
		{ID: "b", Name: "B", Enabled: true, Cron: "* * * * *", Action: "second"},
	}, func(_ context.Context, def Definition) error {
		triggered = append(triggered, def.ID)
		if def.ID == "a" {
			current = instant.Add(29 * time.Second).In(time.FixedZone("other", offset))
		}
		return nil
	})
	ticks := make(chan time.Time, 1)
	ticks <- instant
	close(ticks)
	s.Run(context.Background(), func() time.Time { return current }, ticks)
	if !reflect.DeepEqual(triggered, []string{"a", "b"}) {
		t.Fatalf("triggered = %v, want both callbacks in same wall minute", triggered)
	}
}

func TestSchedulerDedupIgnoresMonotonicClockAndLocation(t *testing.T) {
	base := time.Now()
	base = base.Add(-time.Duration(base.Second())*time.Second - time.Duration(base.Nanosecond()))
	_, offset := base.Zone()
	var triggered int
	s := NewScheduler([]Definition{{ID: "a", Name: "A", Enabled: true, Cron: "* * * * *", Action: "run"}}, func(context.Context, Definition) error {
		triggered++
		return nil
	})
	runSchedulerTicks(s, base.Add(time.Second), base.Add(29*time.Second), base.Add(59*time.Second).In(time.FixedZone("other", offset)))
	if triggered != 1 {
		t.Fatalf("triggered %d times in same real minute, want 1", triggered)
	}
}

func TestSchedulerMatchesLocalMinuteWithSecondOffset(t *testing.T) {
	zone := time.FixedZone("historical", 30)
	local := time.Date(2026, 11, 12, 10, 7, 1, 0, zone)
	var triggered []string
	s := NewScheduler([]Definition{{ID: "a", Name: "A", Enabled: true, Cron: "7 10 * * *", Action: "run"}}, func(_ context.Context, def Definition) error {
		triggered = append(triggered, def.ID)
		return nil
	})
	runSchedulerTicks(s, local)
	if !reflect.DeepEqual(triggered, []string{"a"}) {
		t.Fatalf("triggered = %v, want 10:07 local match despite zone second offset", triggered)
	}
}

func TestSchedulerSkipsDisabledSchedule(t *testing.T) {
	called := false
	s := NewScheduler([]Definition{{ID: "a", Name: "A", Cron: "7 10 * * *", Action: "run"}}, func(context.Context, Definition) error {
		called = true
		return nil
	})
	runSchedulerTicks(s, schedulerTime(7, 1))
	if called {
		t.Fatal("disabled schedule triggered")
	}
}

func TestSchedulerDoesNotBackfillMissedMinutes(t *testing.T) {
	called := false
	s := NewScheduler([]Definition{{ID: "a", Name: "A", Enabled: true, Cron: "7 10 * * *", Action: "run"}}, func(context.Context, Definition) error {
		called = true
		return nil
	})
	runSchedulerTicks(s, schedulerTime(8, 1))
	if called {
		t.Fatal("missed minute was backfilled")
	}
}

func TestSchedulerContinuesAfterTriggerError(t *testing.T) {
	var triggered []string
	s := NewScheduler([]Definition{
		{ID: "a", Name: "A", Enabled: true, Cron: "7 10 * * *", Action: "first"},
		{ID: "b", Name: "B", Enabled: true, Cron: "7 10 * * *", Action: "second"},
	}, func(_ context.Context, def Definition) error {
		triggered = append(triggered, def.ID)
		if def.ID == "a" {
			return errors.New("trigger failed")
		}
		return nil
	})
	runSchedulerTicks(s, schedulerTime(7, 1), schedulerTime(7, 29))
	if !reflect.DeepEqual(triggered, []string{"a", "b"}) {
		t.Fatalf("triggered = %v, want both attempted once", triggered)
	}
}

func TestSchedulerDropsPendingTriggersAfterMinutePasses(t *testing.T) {
	current := schedulerTime(7, 1)
	var triggered []string
	s := NewScheduler([]Definition{
		{ID: "a", Name: "A", Enabled: true, Cron: "7 10 * * *", Action: "first"},
		{ID: "b", Name: "B", Enabled: true, Cron: "7,8 10 * * *", Action: "second"},
	}, func(_ context.Context, def Definition) error {
		triggered = append(triggered, def.ID)
		if def.ID == "a" {
			current = schedulerTime(8, 1)
		}
		return nil
	})
	ticks := make(chan time.Time, 1)
	ticks <- current
	close(ticks)
	s.Run(context.Background(), func() time.Time { return current }, ticks)
	if !reflect.DeepEqual(triggered, []string{"a"}) {
		t.Fatalf("triggered = %v, want only first task in original minute", triggered)
	}
	runSchedulerTicks(s, schedulerTime(8, 1))
	if !reflect.DeepEqual(triggered, []string{"a", "b"}) {
		t.Fatalf("triggered = %v, want delayed task on current minute's next tick", triggered)
	}
}

func TestSchedulerReplaceRemovesDeletedDefinition(t *testing.T) {
	var triggered []string
	s := NewScheduler([]Definition{{ID: "a", Name: "A", Enabled: true, Cron: "7 10 * * *", Action: "first"}}, func(_ context.Context, def Definition) error {
		triggered = append(triggered, def.ID)
		return nil
	})
	s.Replace([]Definition{{ID: "b", Name: "B", Enabled: true, Cron: "8 10 * * *", Action: "second"}})
	runSchedulerTicks(s, schedulerTime(7, 1), schedulerTime(8, 1))
	if !reflect.DeepEqual(triggered, []string{"b"}) {
		t.Fatalf("triggered = %v, want only replacement", triggered)
	}
}

func TestSchedulerDueDefinitionCarriesAITargetAndParams(t *testing.T) {
	var got Definition
	s := NewScheduler([]Definition{{ID: "a", Name: "A", Enabled: true, Cron: "7,8 10 * * *", AI: "review-bot",
		Params: map[string]any{"prompt": "只看崩溃线程", "TOPIC": "crash"}}}, func(_ context.Context, def Definition) error {
		got = def
		return nil
	})
	runSchedulerTicks(s, schedulerTime(7, 1))
	if got.AI != "review-bot" || got.Action != "" || got.Workflow != "" || got.Params["prompt"] != "只看崩溃线程" || got.Params["TOPIC"] != "crash" {
		t.Fatalf("due definition lost its AI target or params: %+v", got)
	}
	// 传给回调的是克隆：回调改动不得污染调度定义
	got.Params["TOPIC"] = "mutated"
	runSchedulerTicks(s, schedulerTime(8, 1))
	if got.Params["TOPIC"] != "crash" {
		t.Fatalf("definition params mutated through trigger: %+v", got.Params)
	}
}

func TestSchedulerTriggerNowUsesDedicatedCallback(t *testing.T) {
	def := []Definition{{ID: "a", Name: "A", Enabled: true, Cron: "7 10 * * *", AI: "review-bot"}}
	var scheduled, now []Definition
	s := NewScheduler(def, func(_ context.Context, d Definition) error {
		scheduled = append(scheduled, d)
		return nil
	})
	s.SetTriggerNow(func(_ context.Context, d Definition) error {
		now = append(now, d)
		return nil
	})
	runSchedulerTicks(s, schedulerTime(7, 1))
	if err := s.TriggerNow(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if len(scheduled) != 1 || len(now) != 1 || scheduled[0].AI != "review-bot" || now[0].AI != "review-bot" {
		t.Fatalf("scheduled=%v now=%v", scheduled, now)
	}
}

func TestSchedulerTriggerNowFallsBackToSharedTrigger(t *testing.T) {
	calls := 0
	s := NewScheduler([]Definition{{ID: "a", Name: "A", Enabled: true, Cron: "7 10 * * *", Action: "run"}}, func(context.Context, Definition) error {
		calls++
		return nil
	})
	if err := s.TriggerNow(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want shared trigger", calls)
	}
}

func TestSchedulerTriggerNowBypassesScheduleAndReturnsErrors(t *testing.T) {
	wantErr := errors.New("trigger failed")
	var triggered []string
	s := NewScheduler([]Definition{{ID: "a", Name: "A", Cron: "7 10 * * *", Action: "run"}}, func(_ context.Context, def Definition) error {
		triggered = append(triggered, def.ID)
		return wantErr
	})
	if err := s.TriggerNow(context.Background(), "missing"); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("missing target error = %v", err)
	}
	runSchedulerTicks(s, schedulerTime(7, 1))
	for i := 0; i < 2; i++ {
		if err := s.TriggerNow(context.Background(), "a"); !errors.Is(err, wantErr) {
			t.Fatalf("TriggerNow error = %v, want wrapped trigger error", err)
		}
	}
	if !reflect.DeepEqual(triggered, []string{"a", "a"}) {
		t.Fatalf("triggered = %v, want manual triggers even when disabled", triggered)
	}
}

func TestSchedulerTriggerNowSkipsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	called := false
	s := NewScheduler([]Definition{{ID: "a", Name: "A", Cron: "* * * * *", Action: "run"}}, func(context.Context, Definition) error {
		called = true
		return nil
	})
	if err := s.TriggerNow(ctx, "a"); !errors.Is(err, context.Canceled) {
		t.Fatalf("TriggerNow error = %v, want context.Canceled", err)
	}
	if called {
		t.Fatal("TriggerNow invoked callback after cancellation")
	}
}

func TestSchedulerSnapshotIsIndependentOfInputAndTrigger(t *testing.T) {
	params := map[string]any{"nested": map[string]any{"key": "original"}}
	defs := []Definition{{ID: "a", Name: "A", Enabled: true, Cron: "* * * * *", Action: "run", Params: params}}
	var values []string
	s := NewScheduler(defs, func(_ context.Context, def Definition) error {
		values = append(values, def.Params["nested"].(map[string]any)["key"].(string))
		def.Params["nested"].(map[string]any)["key"] = "changed by trigger"
		return nil
	})
	params["nested"].(map[string]any)["key"] = "changed by caller"
	defs[0].Action = "changed"
	runSchedulerTicks(s, schedulerTime(7, 1), schedulerTime(8, 1))
	if !reflect.DeepEqual(values, []string{"original", "original"}) {
		t.Fatalf("trigger values = %v, want isolated params", values)
	}
	s.Replace([]Definition{{ID: "b", Name: "B", Enabled: true, Cron: "* * * * *", Action: "run", Params: params}})
	params["nested"].(map[string]any)["key"] = "changed after replace"
	if err := s.TriggerNow(context.Background(), "b"); err != nil {
		t.Fatal(err)
	}
	if values[2] != "changed by caller" {
		t.Fatalf("replacement snapshot value = %q", values[2])
	}
}

func TestSchedulerClockRollbackDoesNotRetriggerSameMinute(t *testing.T) {
	var triggered []time.Time
	current := schedulerTime(7, 1)
	s := NewScheduler([]Definition{{ID: "a", Name: "A", Enabled: true, Cron: "* * * * *", Action: "run"}}, func(context.Context, Definition) error {
		triggered = append(triggered, current.Truncate(time.Minute))
		return nil
	})
	times := []time.Time{schedulerTime(7, 1), schedulerTime(8, 1), schedulerTime(7, 29)}
	for _, instant := range times {
		current = instant
		runSchedulerTicks(s, instant)
	}
	if !reflect.DeepEqual(triggered, []time.Time{schedulerTime(7, 0), schedulerTime(8, 0)}) {
		t.Fatalf("triggered at %v, want each minute once despite clock rollback", triggered)
	}
}

func TestSchedulerClockRollbackRunsPreviouslyUnseenMinute(t *testing.T) {
	current := schedulerTime(0, 1).Add(2 * time.Hour)
	var triggered []time.Time
	s := NewScheduler([]Definition{{ID: "a", Name: "A", Enabled: true, Cron: "* * * * *", Action: "run"}}, func(context.Context, Definition) error {
		triggered = append(triggered, current)
		return nil
	})
	times := []time.Time{current, current.Add(-time.Hour), current}
	for _, instant := range times {
		current = instant
		runSchedulerTicks(s, instant)
	}
	if !reflect.DeepEqual(triggered, times[:2]) {
		t.Fatalf("triggered at %v, want new rollback minute but not repeated 12:00", triggered)
	}
}

func TestSchedulerNeverRetriggersOldMinuteAfterManyTicks(t *testing.T) {
	const triggerCount = 1441
	var count int
	s := NewScheduler([]Definition{{ID: "a", Name: "A", Enabled: true, Cron: "* * * * *", Action: "run"}}, func(context.Context, Definition) error {
		count++
		return nil
	})
	first := schedulerTime(0, 0)
	for i := 0; i < triggerCount; i++ {
		runSchedulerTicks(s, first.Add(time.Duration(i)*time.Minute))
	}
	runSchedulerTicks(s, first)
	if count != triggerCount {
		t.Fatalf("triggered %d times, want %d unique minutes even after rollback", count, triggerCount)
	}
}

func TestSchedulerCancellationStopsPendingTriggers(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var triggered []string
	s := NewScheduler([]Definition{
		{ID: "a", Name: "A", Enabled: true, Cron: "* * * * *", Action: "first"},
		{ID: "b", Name: "B", Enabled: true, Cron: "* * * * *", Action: "second"},
	}, func(_ context.Context, def Definition) error {
		triggered = append(triggered, def.ID)
		cancel()
		return nil
	})
	tick := make(chan time.Time, 1)
	tick <- time.Time{}
	s.Run(ctx, func() time.Time { return schedulerTime(7, 1) }, tick)
	if !reflect.DeepEqual(triggered, []string{"a"}) {
		t.Fatalf("triggered = %v, want no callbacks after cancellation", triggered)
	}
}

func TestSchedulerCancellationLeavesPendingMinuteAvailable(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var triggered []string
	s := NewScheduler([]Definition{
		{ID: "a", Name: "A", Enabled: true, Cron: "* * * * *", Action: "first"},
		{ID: "b", Name: "B", Enabled: true, Cron: "* * * * *", Action: "second"},
	}, func(_ context.Context, def Definition) error {
		triggered = append(triggered, def.ID)
		if def.ID == "a" {
			cancel()
		}
		return nil
	})
	tick := make(chan time.Time, 1)
	tick <- time.Time{}
	s.Run(ctx, func() time.Time { return schedulerTime(7, 1) }, tick)
	runSchedulerTicks(s, schedulerTime(7, 29))
	if !reflect.DeepEqual(triggered, []string{"a", "b"}) {
		t.Fatalf("triggered = %v, want canceled pending definition on next run", triggered)
	}
}

func TestSchedulerRejectsStructurallyInvalidReplacement(t *testing.T) {
	valid := Definition{ID: "original", Name: "Original", Enabled: true, Cron: "* * * * *", Action: "run"}
	for _, tc := range []struct {
		name string
		defs []Definition
	}{
		{"invalid id", []Definition{{ID: "UPPER", Name: "Invalid", Cron: "* * * * *", Action: "run"}}},
		{"missing name", []Definition{{ID: "invalid", Cron: "* * * * *", Action: "run"}}},
		{"invalid cron", []Definition{{ID: "invalid", Name: "Invalid", Cron: "bad", Action: "run"}}},
		{"missing target", []Definition{{ID: "invalid", Name: "Invalid", Cron: "* * * * *"}}},
		{"both targets", []Definition{{ID: "invalid", Name: "Invalid", Cron: "* * * * *", Action: "run", Workflow: "flow"}}},
		{"duplicate id", []Definition{
			{ID: "duplicate", Name: "Duplicate", Cron: "* * * * *", Action: "first"},
			{ID: "duplicate", Name: "Duplicate", Cron: "* * * * *", Action: "second"},
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var triggered []string
			s := NewScheduler([]Definition{valid}, func(_ context.Context, def Definition) error {
				triggered = append(triggered, def.ID)
				return nil
			})
			s.Replace(tc.defs)
			runSchedulerTicks(s, schedulerTime(7, 1))
			if !reflect.DeepEqual(triggered, []string{"original"}) {
				t.Fatalf("triggered = %v, want previous snapshot after invalid replacement", triggered)
			}
		})
	}
}

func TestSchedulerAllowsUnresolvedTargetForServiceCatalogValidation(t *testing.T) {
	var triggered []string
	s := NewScheduler([]Definition{{ID: "unknown", Name: "Unknown", Cron: "* * * * *", Action: "not-in-catalog"}}, func(_ context.Context, def Definition) error {
		triggered = append(triggered, def.Action)
		return nil
	})
	if err := s.TriggerNow(context.Background(), "unknown"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(triggered, []string{"not-in-catalog"}) {
		t.Fatalf("triggered = %v, target catalog should be validated by Service", triggered)
	}
}

func TestSchedulerInvalidReplacementKeepsPreviousSnapshot(t *testing.T) {
	cyclic := map[string]any{}
	cyclic["self"] = cyclic
	var triggered []string
	s := NewScheduler([]Definition{{ID: "original", Name: "Original", Enabled: true, Cron: "* * * * *", Action: "run"}}, func(_ context.Context, def Definition) error {
		triggered = append(triggered, def.ID)
		return nil
	})
	s.Replace([]Definition{
		{ID: "bad", Name: "Bad", Enabled: true, Cron: "* * * * *", Action: "run", Params: cyclic},
		{ID: "good", Name: "Good", Enabled: true, Cron: "* * * * *", Action: "run"},
	})
	runSchedulerTicks(s, schedulerTime(7, 1))
	if !reflect.DeepEqual(triggered, []string{"original"}) {
		t.Fatalf("triggered = %v, want unchanged snapshot after invalid replacement", triggered)
	}
}

func TestSchedulerReplaceDropsPendingTriggersFromOldSnapshot(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	completed := make(chan struct{})
	var triggered []string
	s := NewScheduler([]Definition{
		{ID: "a", Name: "A", Enabled: true, Cron: "* * * * *", Action: "first"},
		{ID: "b", Name: "B", Enabled: true, Cron: "* * * * *", Action: "second"},
	}, func(_ context.Context, def Definition) error {
		triggered = append(triggered, def.ID)
		if def.ID == "a" {
			close(entered)
			<-release
		}
		return nil
	})
	go func() {
		defer close(completed)
		runSchedulerTicks(s, schedulerTime(7, 1))
	}()
	<-entered
	s.Replace([]Definition{{ID: "a", Name: "A", Enabled: true, Cron: "* * * * *", Action: "first"}})
	close(release)
	<-completed
	if !reflect.DeepEqual(triggered, []string{"a"}) {
		t.Fatalf("triggered = %v, want pending deleted schedule skipped", triggered)
	}
}

func TestSchedulerPendingDefinitionCanRunOnNextTickAfterReplace(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	completed := make(chan struct{})
	var triggered []string
	defs := []Definition{
		{ID: "a", Name: "A", Enabled: true, Cron: "* * * * *", Action: "first"},
		{ID: "b", Name: "B", Enabled: true, Cron: "* * * * *", Action: "second"},
	}
	s := NewScheduler(defs, func(_ context.Context, def Definition) error {
		triggered = append(triggered, def.ID)
		if def.ID == "a" {
			close(entered)
			<-release
		}
		return nil
	})
	go func() {
		defer close(completed)
		runSchedulerTicks(s, schedulerTime(7, 1))
	}()
	<-entered
	s.Replace(defs)
	close(release)
	<-completed
	runSchedulerTicks(s, schedulerTime(7, 29))
	if !reflect.DeepEqual(triggered, []string{"a", "b"}) {
		t.Fatalf("triggered = %v, want pending definition retried on next tick", triggered)
	}
}

func TestSchedulerReplaceCanRunDuringTrigger(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	completed := make(chan struct{})
	var mu sync.Mutex
	var triggered []string
	s := NewScheduler([]Definition{{ID: "a", Name: "A", Enabled: true, Cron: "* * * * *", Action: "run"}}, func(_ context.Context, def Definition) error {
		mu.Lock()
		triggered = append(triggered, def.ID)
		mu.Unlock()
		if def.ID == "a" {
			close(entered)
			<-release
		}
		return nil
	})
	go func() {
		defer close(completed)
		runSchedulerTicks(s, schedulerTime(7, 1))
	}()
	<-entered
	s.Replace([]Definition{{ID: "b", Name: "B", Enabled: true, Cron: "* * * * *", Action: "run"}})
	close(release)
	<-completed
	runSchedulerTicks(s, schedulerTime(8, 1))
	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(triggered, []string{"a", "b"}) {
		t.Fatalf("triggered = %v, want old trigger to finish and replacement to run", triggered)
	}
}
