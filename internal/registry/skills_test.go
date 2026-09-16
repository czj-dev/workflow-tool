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

// writeAction 写一个最小可加载的 llm 动作 YAML。
// skillsYAML 非空时是已带缩进的列表项文本（6 空格 起），插在 llm 块内
// prompt 之后——不能 append 到末尾，否则会挂到 params 列表项下。
func writeAction(t *testing.T, dir, id, skillsYAML string) {
	t.Helper()
	yaml := "id: " + id + "\ntitle: " + id + "\ncommand:\n  llm:\n    prompt: p\n"
	if skillsYAML != "" {
		yaml += "    skills:\n" + skillsYAML
	}
	yaml += "params:\n  - id: p\n    type: text\n"
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
	writeAction(t, actDir, "demo-a", "      - bug-analyze\n      - git-style\n")

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
	writeAction(t, actDir, "demo-a", "")

	reg := Load(actDir, base)

	if len(reg.Errors) == 0 {
		t.Fatal("跨级同名 id 应报冲突")
	}
}

func TestLoadSkillRefMissing(t *testing.T) {
	base := t.TempDir()
	actDir := filepath.Join(base, "actions")
	if err := os.MkdirAll(actDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeAction(t, actDir, "demo-a", "      - ghost\n")

	reg := Load(actDir, base)

	if len(reg.Errors) == 0 {
		t.Fatal("引用不存在的 skill 应报错")
	}
	if _, ok := reg.Actions["demo-a"]; ok {
		t.Fatal("引用失败的动不应进入 Actions")
	}
}

func TestValidateSkillIDPattern(t *testing.T) {
	def := &ActionDef{ID: "x", Title: "x", Command: Command{LLM: LLMCommand{Prompt: "p", Skills: []string{"Bad_Name"}}}}
	if err := Validate(def); err == nil {
		t.Fatal("skill id 不匹配 ^[a-z0-9-]+$ 应报错")
	}
}
