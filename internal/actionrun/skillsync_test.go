package actionrun

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// makeSkillDir 造一个含多文件的 skill 目录，files 为「相对路径→内容」。
func makeSkillDir(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for rel, content := range files {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func readAll(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		data, _ := os.ReadFile(p)
		out[filepath.ToSlash(rel)] = string(data)
		return nil
	})
	return out
}

func TestSyncSkillsFourCases(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()
	srcSkill := filepath.Join(src, "demo")
	dstSkill := filepath.Join(dst, "demo")

	// 情况 1：全新同步（含子目录附属文件）
	makeSkillDir(t, srcSkill, map[string]string{
		"SKILL.md":      "# v1",
		"refs/guide.md": "guide",
	})

	rep, err := SyncSkills([]SyncItem{{ID: "demo", Scope: "project", SrcDir: srcSkill, DstDir: dstSkill}})
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Synced) != 1 || len(rep.Skipped) != 0 {
		t.Fatalf("全新同步应 synced=1, got %+v", rep)
	}
	if got := readAll(t, dstSkill); len(got) != 2 || got["SKILL.md"] != "# v1" {
		t.Fatalf("目标内容不符: %+v", got)
	}

	// 情况 2：一致跳过
	rep, err = SyncSkills([]SyncItem{{ID: "demo", Scope: "project", SrcDir: srcSkill, DstDir: dstSkill}})
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Skipped) != 1 || len(rep.Synced) != 0 {
		t.Fatalf("二次同步应 skipped=1, got %+v", rep)
	}

	// 情况 3：内容变更覆盖
	makeSkillDir(t, srcSkill, map[string]string{"SKILL.md": "# v2"})
	rep, err = SyncSkills([]SyncItem{{ID: "demo", Scope: "project", SrcDir: srcSkill, DstDir: dstSkill}})
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Synced) != 1 {
		t.Fatalf("变更应 synced=1, got %+v", rep)
	}
	if got := readAll(t, dstSkill); got["SKILL.md"] != "# v2" {
		t.Fatalf("覆盖失败: %q", got["SKILL.md"])
	}

	// 情况 4：目标多余文件删除（源里没有 refs/ 了）
	if err := os.Remove(filepath.Join(srcSkill, "refs", "guide.md")); err != nil {
		t.Fatal(err)
	}
	rep, err = SyncSkills([]SyncItem{{ID: "demo", Scope: "project", SrcDir: srcSkill, DstDir: dstSkill}})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := readAll(t, dstSkill)["refs/guide.md"]; ok {
		t.Fatal("目标多余文件应被删除")
	}

	// 报告行格式
	lines := rep.Lines()
	if len(lines) == 0 || !strings.Contains(lines[0], "[skill-sync] demo(project)") {
		t.Fatalf("报告行格式不符: %v", lines)
	}
}

func TestSyncSkillsSourceMissing(t *testing.T) {
	rep, err := SyncSkills([]SyncItem{{ID: "ghost", Scope: "project",
		SrcDir: filepath.Join(t.TempDir(), "ghost"), DstDir: filepath.Join(t.TempDir(), "d")}})
	if err == nil {
		t.Fatalf("源目录被删（含 SKILL.md 的目录整体不在）应报错, got %+v", rep)
	}
}
