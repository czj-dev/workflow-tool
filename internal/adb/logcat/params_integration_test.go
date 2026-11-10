package logcat

import (
	"strings"
	"testing"

	"workflow-tool/internal/adb"
)

func TestInvalidTagStopsLogcatOperationsBeforeSideEffects(t *testing.T) {
	for _, tc := range []struct {
		name   string
		handle func(*adb.OpContext) adb.OpResult
		params map[string]any
	}{
		{name: "stream", handle: handleStream, params: map[string]any{"TAG": "old tag"}},
		{name: "batch", handle: handleBatch, params: map[string]any{"TAG": "old tag", "LOGS_DIR": t.TempDir()}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var stderr string
			op := &adb.OpContext{Params: tc.params, Emit: func(stream, line string) {
				if stream == "stderr" {
					stderr = line
				}
			}}
			res := tc.handle(op)
			if res.ExitCode != 2 || res.Err == nil || !strings.Contains(stderr, "TAG") {
				t.Fatalf("invalid TAG should stop with a visible error: %+v, stderr %q", res, stderr)
			}
		})
	}
}
