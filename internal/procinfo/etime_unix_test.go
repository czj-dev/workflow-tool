//go:build !windows

package procinfo

import (
	"testing"
	"time"
)

// etime 形如 [[dd-]hh:]mm:ss；按它反推的启动时刻与真值相差不超过一秒的粒度。
func TestStartFromElapsedParsesEveryWidth(t *testing.T) {
	now := time.Date(2026, 11, 25, 10, 30, 0, 0, time.UTC)
	cases := map[string]time.Duration{
		"00:07":        7 * time.Second,
		"01:02:03":     time.Hour + 2*time.Minute + 3*time.Second,
		"3-01:02:03":   3*24*time.Hour + time.Hour + 2*time.Minute + 3*time.Second,
		"999-00:00:01": 999*24*time.Hour + time.Second,
	}
	for text, elapsed := range cases {
		got, ok := startFromElapsed(text, now)
		if !ok {
			t.Fatalf("%q did not parse", text)
		}
		if want := now.Add(-elapsed); !got.Equal(want) {
			t.Fatalf("%q → %s, want %s", text, got, want)
		}
	}
	for _, text := range []string{"", "garbage", "1:2:3:4", "-1-00:00", "aa:bb"} {
		if _, ok := startFromElapsed(text, now); ok {
			t.Fatalf("%q must not parse as a live process", text)
		}
	}
}
