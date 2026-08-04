// internal/runner/sleep_runner_test.go
package runner

import (
	"context"
	"testing"
	"time"
)

func TestSleepRunner_EmitsAndWaits(t *testing.T) {
	var emitted []string
	emit := func(stream, line string) { emitted = append(emitted, stream+":"+line) }

	r := &SleepRunner{Seconds: 1}
	start := time.Now()
	res := r.Run(context.Background(), nil, emit)
	elapsed := time.Since(start)

	if res.ExitCode != 0 {
		t.Fatalf("expected exit 0, got %d", res.ExitCode)
	}
	if res.Err != nil {
		t.Fatalf("unexpected error: %v", res.Err)
	}
	if elapsed < 900*time.Millisecond {
		t.Fatalf("sleep too short: %v", elapsed)
	}
	if len(emitted) != 1 || emitted[0] != "stdout:sleep 1s" {
		t.Fatalf("unexpected emit: %v", emitted)
	}
}

func TestSleepRunner_CancelledEarly(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // 立即取消

	r := &SleepRunner{Seconds: 10}
	start := time.Now()
	res := r.Run(ctx, nil, func(_, _ string) {})
	elapsed := time.Since(start)

	if elapsed > 500*time.Millisecond {
		t.Fatalf("should return immediately on cancel, took %v", elapsed)
	}
	if res.ExitCode != -1 {
		t.Fatalf("expected exit -1 on cancel, got %d", res.ExitCode)
	}
}
