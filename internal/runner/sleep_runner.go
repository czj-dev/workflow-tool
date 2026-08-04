// internal/runner/sleep_runner.go
package runner

import (
	"context"
	"fmt"
	"time"
)

// SleepRunner 是 CustomRunner，sleep 指定秒数后返回。
type SleepRunner struct {
	Seconds int
}

func (r *SleepRunner) Run(ctx context.Context, _ map[string]any, emit EmitFunc) Result {
	start := time.Now()
	emit("stdout", fmt.Sprintf("sleep %ds", r.Seconds))

	select {
	case <-time.After(time.Duration(r.Seconds) * time.Second):
		return Result{ExitCode: 0, Duration: time.Since(start)}
	case <-ctx.Done():
		return Result{ExitCode: -1, Err: ctx.Err(), Duration: time.Since(start)}
	}
}
