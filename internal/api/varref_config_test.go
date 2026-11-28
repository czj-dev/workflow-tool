package api

import (
	"os"
	"path/filepath"
	"testing"

	"workflow-tool/internal/registry"
	"workflow-tool/internal/workflow"
)

// TestGetVarReferenceCountsCoversGlobalConfigValues 校验 config.yaml 值之间的内联
// 引用（DOCS: ${USER}/Documents）被正确计数。config 值是运行时变量查找源的终值，
// 值内引用在 runner.Expand 时会展开——漏扫会让 DOCS/USER 在全局配置页显示「未使用」。
// 复现场景：config.yaml 改用 ${DOCS}/${USER} 引用链后，全局配置页计数未更新。
func TestGetVarReferenceCountsCoversGlobalConfigValues(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "actions"), 0755); err != nil {
		t.Fatal(err)
	}
	cfg := "DOCS: ${USER}/Documents\nLOGS_DIR: ${DOCS}/Logs\nOUTPUT_DIR: ${DOCS}/docs\nUSER: /home/u\n"
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(cfg), 0644); err != nil {
		t.Fatal(err)
	}
	svc := New(registry.Load(filepath.Join(dir, "actions"), dir),
		workflow.Load(filepath.Join(dir, "workflows")), dir,
		filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
	counts := svc.GetVarReferenceCounts()
	// DOCS 被 LOGS_DIR / OUTPUT_DIR 引用；USER 被 DOCS 引用
	if c := counts["DOCS"]; c != 2 {
		t.Errorf("DOCS 应被 config 值引用 2 次，got %d（counts=%+v）", c, counts)
	}
	if c := counts["USER"]; c != 1 {
		t.Errorf("USER 应被 config 值引用 1 次，got %d（counts=%+v）", c, counts)
	}
}