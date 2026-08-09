package api

import (
	"path/filepath"
	"testing"

	"workflow-tool/internal/registry"
)

// TestActionsDirectoryValidates 确保仓库根的 actions/ 下所有 YAML 能通过 registry.Load
// （解析 + Validate 三选一互斥 + param type 校验）。新增 command.adb action 后尤其重要。
func TestActionsDirectoryValidates(t *testing.T) {
	// repo root = ../.. 相对于 internal/api
	dir := filepath.Join("..", "..", "actions")
	reg := registry.Load(dir, "")
	if len(reg.Errors) > 0 {
		for _, e := range reg.Errors {
			t.Errorf("action load error in %s: %s", e.File, e.Error)
		}
	}
	if len(reg.Actions) == 0 {
		t.Fatal("no actions loaded from actions/")
	}
	// 至少覆盖四个域的 command.adb action
	want := []string{"adb-install", "adb-logcat", "adb-scrcpy",
		"adb-logcat-stream", "adb-list-files", "adb-push", "adb-screenshot"}
	for _, id := range want {
		la, ok := reg.Actions[id]
		if !ok {
			t.Errorf("action %q not loaded", id)
			continue
		}
		if la.Def.Command.Adb.Operation == "" {
			t.Errorf("action %q has no command.adb.operation", id)
		}
	}
	t.Logf("loaded %d actions, all validate OK", len(reg.Actions))
}
