package airun

import (
	"strings"
	"testing"

	"workflow-tool/internal/registry"
)

// TestSkillDirResolver 按绑定顺序返回源目录；源缺失报错文案沿用原 Route；
// user 级 skill 无需主目录（作用域区别随复制机器一起消失）。
func TestSkillDirResolver(t *testing.T) {
	skills := map[string]registry.SkillMeta{
		"bug-analyze": {Scope: "project", Dir: "/src/skills/bug-analyze"},
		"git-style":   {Scope: "user", Dir: "/src/skills/user/git-style"},
	}
	resolve := SkillDirResolver(func() map[string]registry.SkillMeta { return skills })

	dirs, err := resolve([]string{"bug-analyze", "git-style"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"/src/skills/bug-analyze", "/src/skills/user/git-style"}
	if len(dirs) != len(want) || dirs[0] != want[0] || dirs[1] != want[1] {
		t.Fatalf("dirs = %v want %v", dirs, want)
	}

	_, err = resolve([]string{"ghost"})
	if err == nil || !strings.Contains(err.Error(), `skill "ghost" 不存在`) {
		t.Fatalf("源缺失应报错, got %v", err)
	}

	if dirs, err := resolve(nil); err != nil || len(dirs) != 0 {
		t.Fatalf("空 ids 应返回空, got %v %v", dirs, err)
	}
}

// TestSkillDirResolverLazy 每次调用都重取注册表快照：热重载后新 skill 立即可见。
func TestSkillDirResolverLazy(t *testing.T) {
	skills := map[string]registry.SkillMeta{"a": {Dir: "/src/a"}}
	resolve := SkillDirResolver(func() map[string]registry.SkillMeta { return skills })

	if _, err := resolve([]string{"b"}); err == nil {
		t.Fatal("b 尚不存在")
	}
	skills["b"] = registry.SkillMeta{Dir: "/src/b"} // 模拟热重载后的注册表
	dirs, err := resolve([]string{"a", "b"})
	if err != nil || len(dirs) != 2 || dirs[1] != "/src/b" {
		t.Fatalf("热重载后应解析到 b: %v %v", dirs, err)
	}
}
