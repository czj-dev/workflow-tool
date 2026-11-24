package registry

import (
	"os"
	"path/filepath"
	"testing"
)

// writeSkill 在 baseDir/skills 下造一个 skill（scope 决定是否落 user/ 分区）。
func writeSkill(t *testing.T, baseDir, id, scope, content string) {
	t.Helper()
	sub := filepath.Join(baseDir, "skills")
	if scope == "user" {
		sub = filepath.Join(sub, "user")
	}
	dir := filepath.Join(sub, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if content != "" {
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// writeAction 写一个最小可加载的动作 YAML。skills 扫描由 registry.Load 顺带完成，
// 这里只需要动作目录里有一个合法动作，确认加载不因 skills 分区而中断
// （引用 skill 的是 AI 任务，校验在 internal/ai.Parse）。
func writeAction(t *testing.T, dir, id string) {
	t.Helper()
	yaml := "id: " + id + "\ntitle: " + id + "\ncommand:\n  run: echo\n"
	if err := os.WriteFile(filepath.Join(dir, id+".yaml"), []byte(yaml), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadSkillsScopes(t *testing.T) {
	base := t.TempDir()
	writeSkill(t, base, "bug-analyze", "project", "# x")
	writeSkill(t, base, "git-style", "user", "# x")
	writeSkill(t, base, "no-skill-md", "project", "") // 无 SKILL.md，不收录
	actDir := filepath.Join(base, "actions")
	if err := os.MkdirAll(actDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeAction(t, actDir, "demo-a")

	reg := Load(actDir, base)

	if len(reg.Errors) != 0 {
		t.Fatalf("意外错误: %v", reg.Errors)
	}
	if got := reg.Skills["bug-analyze"]; got.Scope != "project" {
		t.Fatalf("bug-analyze scope = %q, want project", got.Scope)
	}
	if got := reg.Skills["git-style"]; got.Scope != "user" {
		t.Fatalf("git-style scope = %q, want user", got.Scope)
	}
	if _, ok := reg.Skills["no-skill-md"]; ok {
		t.Fatal("无 SKILL.md 的目录不应收录")
	}
}

func TestLoadSkillsCrossScopeConflict(t *testing.T) {
	base := t.TempDir()
	writeSkill(t, base, "dup", "project", "# x")
	writeSkill(t, base, "dup", "user", "# x")
	actDir := filepath.Join(base, "actions")
	if err := os.MkdirAll(actDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeAction(t, actDir, "demo-a")

	reg := Load(actDir, base)

	if len(reg.Errors) == 0 {
		t.Fatal("跨级同名 id 应报冲突")
	}
}

func TestLoadSkillsWithoutSkillsDir(t *testing.T) {
	// 没有 skills/ 目录：空集合，不报错（全新工作区的常态）
	base := t.TempDir()
	actDir := filepath.Join(base, "actions")
	if err := os.MkdirAll(actDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeAction(t, actDir, "demo-a")

	reg := Load(actDir, base)
	if len(reg.Errors) != 0 || len(reg.Skills) != 0 {
		t.Fatalf("没有 skills/ 时应为空集合且无错误，got %+v %v", reg.Skills, reg.Errors)
	}
}

// TestValidateSkillIDPattern 锁定 skill id 的格式约束（引用是否存在由 internal/ai
// 按扫描结果校验，调用同一个 ValidateSkillRefs）。
func TestValidateSkillIDPattern(t *testing.T) {
	if err := ValidateSkillRefs([]string{"Bad_Name"}, map[string]SkillMeta{}); err == nil {
		t.Fatal("skill id 不匹配 ^[a-z0-9-]+$ 应报错")
	}
	if err := ValidateSkillRefs([]string{"ok-id"}, map[string]SkillMeta{"ok-id": {Scope: "project"}}); err != nil {
		t.Fatalf("格式合法且存在的 skill 应通过: %v", err)
	}
}
