package actionrun

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"workflow-tool/internal/registry"
)

// newTestRouter 造一个全注入的 router：skills 固定集、home=tmp、账本在 tmp 下。
func newTestRouter(t *testing.T, skills map[string]registry.SkillMeta) (*SkillRouter, string) {
	t.Helper()
	home := t.TempDir()
	ledger := filepath.Join(t.TempDir(), "skills.synced.json")
	return &SkillRouter{
		Skills:     func() map[string]registry.SkillMeta { return skills },
		HomeDir:    func() string { return home },
		LedgerPath: ledger,
	}, home
}

func TestRouteScopesAndCwdFallback(t *testing.T) {
	skills := map[string]registry.SkillMeta{
		"bug-analyze": {Scope: "project", Dir: `/src/skills/bug-analyze`},
		"git-style":   {Scope: "user", Dir: `/src/skills/user/git-style`},
	}
	router, home := newTestRouter(t, skills)
	agentCwd := `D:\proj`

	items, rep, err := router.Route([]string{"bug-analyze", "git-style"}, agentCwd, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Warnings) != 0 {
		t.Fatalf("ducc 默认 CLI 不应警告: %v", rep.Warnings)
	}
	if len(items) != 2 {
		t.Fatalf("应产出 2 条, got %+v", items)
	}
	if items[0].DstDir != filepath.Join(agentCwd, ".claude", "skills", "bug-analyze") {
		t.Fatalf("project 级目标不符: %s", items[0].DstDir)
	}
	if items[1].DstDir != filepath.Join(home, ".claude", "skills", "git-style") {
		t.Fatalf("user 级目标不符: %s", items[1].DstDir)
	}

	// cwd 为空：不传 agentCwd（空串）应报错？不——空由 Build 兜底 BaseDir 后传入，
	// Route 收到的恒非空；这里验证 cli 大小写归一。
	items, _, err = router.Route([]string{"bug-analyze"}, agentCwd, "Claude")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(items[0].DstDir, ".claude") {
		t.Fatalf("Claude 大小写归一后应命中 claude 条目: %s", items[0].DstDir)
	}
}

func TestRouteCodexDualRoot(t *testing.T) {
	skills := map[string]registry.SkillMeta{
		"x": {Scope: "project", Dir: `/src/skills/x`},
	}
	router, _ := newTestRouter(t, skills)

	items, _, err := router.Route([]string{"x"}, `D:\p`, "codex")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("codex 双根应产出 2 条, got %+v", items)
	}
	if !strings.Contains(items[0].DstDir, ".codex") || !strings.Contains(items[1].DstDir, ".agents") {
		t.Fatalf("codex 双根目标不符: %+v", items)
	}
}

func TestRouteUnknownCLIFallback(t *testing.T) {
	skills := map[string]registry.SkillMeta{
		"x": {Scope: "project", Dir: `/src/skills/x`},
	}
	router, _ := newTestRouter(t, skills)

	items, rep, err := router.Route([]string{"x"}, `D:\p`, "somecc")
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Warnings) != 1 || !strings.Contains(rep.Warnings[0], "somecc") {
		t.Fatalf("未知 CLI 应有一条警告: %v", rep.Warnings)
	}
	if !strings.Contains(items[0].DstDir, ".claude") {
		t.Fatalf("未知 CLI 应回退 .claude/skills: %s", items[0].DstDir)
	}
}

func TestRouteMissingSkillErrors(t *testing.T) {
	router, _ := newTestRouter(t, map[string]registry.SkillMeta{})
	if _, _, err := router.Route([]string{"ghost"}, `D:\p`, ""); err == nil {
		t.Fatal("源缺失应报错（动作失败）")
	}
}

// TestRouteUserScopeWithoutHomeErrors 锁定 Route 仅有的两个 error 分支之一：
// HomeDir 为空且 skills 含 user 级条目时，user 级目标根无法确定，应报错（动作失败）。
func TestRouteUserScopeWithoutHomeErrors(t *testing.T) {
	skills := map[string]registry.SkillMeta{
		"git-style": {Scope: "user", Dir: `/src/skills/user/git-style`},
	}
	router, _ := newTestRouter(t, skills)
	router.HomeDir = func() string { return "" }
	if _, _, err := router.Route([]string{"git-style"}, `D:\p`, ""); err == nil {
		t.Fatal("HomeDir 空且含 user 级 skill 应报错（动作失败）")
	}
}

func TestRecordLedgerSelfClean(t *testing.T) {
	skills := map[string]registry.SkillMeta{
		"x": {Scope: "project", Dir: `/src/skills/x`},
	}
	router, _ := newTestRouter(t, skills)

	rootA := filepath.Join(t.TempDir(), "proj") // 项目根（agent cwd 侧）
	rootB := filepath.Join(t.TempDir(), "home") // 另一根（user 侧）
	items := []SyncItem{
		{ID: "x", Scope: "project", SrcDir: `/src/skills/x`,
			DstDir: filepath.Join(rootA, ".claude", "skills", "x")},
		{ID: "y", Scope: "user", SrcDir: `/src/skills/user/y`,
			DstDir: filepath.Join(rootB, ".claude", "skills", "y")}, // y 不在源
	}
	if err := router.Record(items); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(router.LedgerPath)
	if err != nil {
		t.Fatal(err)
	}
	var ledger map[string][]string
	if err := json.Unmarshal(data, &ledger); err != nil {
		t.Fatal(err)
	}
	if len(ledger) != 1 {
		t.Fatalf("陈旧条目应被自洁，只剩 1 个根: %+v", ledger)
	}
	key := normalizeLedgerPath(filepath.Dir(items[0].DstDir))
	if got := ledger[key]; len(got) != 1 || got[0] != "x" {
		t.Fatalf("账本内容不符: %v", got)
	}
}
