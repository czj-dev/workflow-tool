package adb_test

import (
	"testing"

	"workflow-tool/internal/adb"

	// 触发各域 init() 自登记。与 main.go 的 blank import 对称。
	_ "workflow-tool/internal/adb/file"
	_ "workflow-tool/internal/adb/foreground"
	_ "workflow-tool/internal/adb/input"
	_ "workflow-tool/internal/adb/logcat"
	_ "workflow-tool/internal/adb/package"
	_ "workflow-tool/internal/adb/scrcpy"
)

// TestOperationsRegistered 确认四个域子包的 init() 都跑过、operation 表非空、
// 且关键 operation 名都在（若有重名会在启动时 panic，此测试根本跑不到）。
func TestOperationsRegistered(t *testing.T) {
	ops := adb.RegisteredOperations()
	if len(ops) < 29 {
		t.Fatalf("expected at least 29 registered operations, got %d: %v", len(ops), ops)
	}

	want := []string{
		// package (9)
		"install-package", "uninstall-package", "list-packages",
		"enable-package", "disable-package", "clear-data",
		"force-stop", "pull-apk", "package-details",
		// logcat (2)
		"logcat-stream", "logcat-batch",
		// file (10)
		"push", "pull", "push-multiple", "pull-multiple",
		"list-files", "mkdir", "delete", "rename",
		"directory-size", "storage-info",
		// scrcpy (6)
		"scrcpy-start", "scrcpy-record-start", "scrcpy-record-stop",
		"clipboard-set", "clipboard-get", "screenshot",
		// foreground (1)
		"foreground-info",
		// input (1)
		"input-text",
	}
	set := make(map[string]bool, len(ops))
	for _, op := range ops {
		set[op] = true
	}
	for _, w := range want {
		if !set[w] {
			t.Errorf("operation %q not registered", w)
		}
	}
}
