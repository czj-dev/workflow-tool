package schedule

import (
	"strings"
	"testing"
	"time"
)

func TestParseAndMatch(t *testing.T) {
	cron, err := Parse("7 10-19 * * 1-5")
	if err != nil {
		t.Fatal(err)
	}
	if !cron.Matches(time.Date(2026, 11, 13, 10, 7, 0, 0, time.Local)) {
		t.Fatal("expected Friday 10:07 to match")
	}
	if cron.Matches(time.Date(2026, 11, 14, 10, 7, 0, 0, time.Local)) {
		t.Fatal("expected Saturday 10:07 not to match")
	}
}

func TestParseSupportsListsAndRanges(t *testing.T) {
	cron, err := Parse("3,7 10-19 1-5 1,6,12 1-5")
	if err != nil {
		t.Fatal(err)
	}
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

func TestParseRejectsMalformedFields(t *testing.T) {
	for _, expr := range []string{
		"", "* * * *", "* * * * * *", "* * * * *,", "* * * * ,1", "* * * * 3-1",
		"* * 0 * *", "* * 32 * *", "* * * 0 *", "* * * 13 *", "* * * * 7", "* * * * Mon",
		"* * * * 1-2-3", "* * * * 1/2", "+1 * * * *", "1-+2 * * * *",
	} {
		if _, err := Parse(expr); err == nil {
			t.Errorf("Parse(%q) unexpectedly succeeded", expr)
		}
	}
}

func TestParseRejectsOversizedExpression(t *testing.T) {
	expr := strings.Repeat("0,", 300) + "0 * * * *"
	if _, err := Parse(expr); err == nil {
		t.Fatal("expected oversized expression to be rejected")
	}
}

func TestMatchesVixieDaySemantics(t *testing.T) {
	weekday := time.Date(2026, 11, 13, 10, 7, 0, 0, time.UTC)  // Friday, not the 12th
	monthday := time.Date(2026, 11, 12, 10, 7, 0, 0, time.UTC) // Thursday, the 12th
	neither := time.Date(2026, 11, 14, 10, 7, 0, 0, time.UTC)
	for _, tc := range []struct {
		name            string
		expr            string
		day, fri, other bool
	}{
		{"both restricted: either matches", "7 10 12 * 5", true, true, false},
		{"only weekday restricted", "7 10 * * 5", false, true, false},
		{"only monthday restricted", "7 10 12 * *", true, false, false},
		{"both wildcard", "7 10 * * *", true, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cron, err := Parse(tc.expr)
			if err != nil {
				t.Fatal(err)
			}
			if got := cron.Matches(monthday); got != tc.day {
				t.Errorf("Thursday 12: got %v, want %v", got, tc.day)
			}
			if got := cron.Matches(weekday); got != tc.fri {
				t.Errorf("Friday 13: got %v, want %v", got, tc.fri)
			}
			if got := cron.Matches(neither); got != tc.other {
				t.Errorf("Saturday 14: got %v, want %v", got, tc.other)
			}
		})
	}
}

func TestMatchesSundayZero(t *testing.T) {
	cron, err := Parse("7 10 * * 0")
	if err != nil {
		t.Fatal(err)
	}
	if !cron.Matches(time.Date(2026, 11, 15, 10, 7, 0, 0, time.UTC)) {
		t.Fatal("Sunday should match weekday 0")
	}
}

func TestDefinitionTarget(t *testing.T) {
	for _, tc := range []struct {
		name string
		def  Definition
		kind TargetKind
		id   string
		fail bool
	}{
		{"action", Definition{Action: "run-a"}, TargetAction, "run-a", false},
		{"workflow", Definition{Workflow: "flow-a"}, TargetWorkflow, "flow-a", false},
		{"missing", Definition{}, "", "", true},
		{"ambiguous", Definition{Action: "run-a", Workflow: "flow-a"}, "", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			kind, id, err := tc.def.Target()
			if (err != nil) != tc.fail || kind != tc.kind || id != tc.id {
				t.Fatalf("Target() = %q, %q, %v; want %q, %q, fail=%v", kind, id, err, tc.kind, tc.id, tc.fail)
			}
		})
	}
}

func TestNextAfterUsesTheNextMinute(t *testing.T) {
	cron, err := Parse("7 * * * *")
	if err != nil {
		t.Fatal(err)
	}
	got, ok := cron.NextAfter(time.Date(2026, 11, 11, 10, 8, 30, 0, time.Local))
	if !ok || !got.Equal(time.Date(2026, 11, 11, 11, 7, 0, 0, time.Local)) {
		t.Fatalf("unexpected next run: %v, %v", got, ok)
	}
}

func TestNextAfterPreservesLocationAndExcludesCurrentMinute(t *testing.T) {
	location := time.FixedZone("local-test", 9*60*60)
	cron, err := Parse("7 * * * *")
	if err != nil {
		t.Fatal(err)
	}
	got, ok := cron.NextAfter(time.Date(2026, 11, 11, 10, 7, 0, 0, location))
	if !ok || !got.Equal(time.Date(2026, 11, 11, 11, 7, 0, 0, location)) || got.Location() != location {
		t.Fatalf("unexpected next run: %v, %v", got, ok)
	}
}

func TestNextAfterAlignsToLocalMinuteWithSecondOffset(t *testing.T) {
	location := time.FixedZone("offset-with-seconds", 9*60*60+30)
	cron, err := Parse("9 10 * * *")
	if err != nil {
		t.Fatal(err)
	}
	got, ok := cron.NextAfter(time.Date(2026, 11, 11, 10, 8, 15, 0, location))
	want := time.Date(2026, 11, 11, 10, 9, 0, 0, location)
	if !ok || !got.Equal(want) || got.Location() != location {
		t.Fatalf("next run = %v, %v; want %v", got, ok, want)
	}
	got, ok = cron.NextAfter(want)
	want = want.AddDate(0, 0, 1)
	if !ok || !got.Equal(want) || got.Location() != location {
		t.Fatalf("next run after current match = %v, %v; want %v", got, ok, want)
	}
}

func TestNextAfterStopsAtOneYear(t *testing.T) {
	cron, err := Parse("0 0 30 2 *") // February 30 never occurs.
	if err != nil {
		t.Fatal(err)
	}
	got, ok := cron.NextAfter(time.Date(2026, 11, 11, 10, 8, 0, 0, time.UTC))
	if ok || !got.IsZero() {
		t.Fatalf("expected no run within a year, got %v, %v", got, ok)
	}
}
