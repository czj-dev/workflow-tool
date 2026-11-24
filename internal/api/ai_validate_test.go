package api

import (
	"path/filepath"
	"testing"

	"workflow-tool/internal/ai"
	"workflow-tool/internal/registry"
)

// TestAiDirectoryValidates 确保仓库根的 ai/ 下所有任务能通过 ai.Load（严格解析 + 校验 +
// skills 引用校验）。skills 由动作加载扫出，与 api.New 的组装顺序一致。
func TestAiDirectoryValidates(t *testing.T) {
	root := filepath.Join("..", "..")
	actions := registry.Load(filepath.Join(root, "actions"), root)
	aiReg := ai.Load(filepath.Join(root, "ai"), actions.Skills)
	if len(aiReg.Errors) > 0 {
		for _, e := range aiReg.Errors {
			t.Errorf("ai task load error in %s: %s", e.File, e.Error)
		}
	}
	if len(aiReg.Tasks) == 0 {
		t.Fatal("no ai tasks loaded from ai/")
	}
	// M1 从 actions/ 迁来的 5 个任务：id 不变，且只存在于 ai/（迁移是搬家不是复制）
	migrated := []string{"claude-ask", "claude-bug-analyze", "claude-card-transfrom",
		"demo-llm-skill", "xdzs-verify-fix"}
	for _, id := range migrated {
		if _, ok := aiReg.Get(id); !ok {
			t.Errorf("ai task %q not loaded", id)
		}
		if _, ok := actions.Actions[id]; ok {
			t.Errorf("%q exists in both actions/ and ai/", id)
		}
	}
	t.Logf("loaded %d ai tasks, all validate OK", len(aiReg.Tasks))
}
