package apphome

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveBaseDir(t *testing.T) {
	t.Run("flag 优先于一切", func(t *testing.T) {
		t.Setenv("WORKFLOW_TOOL_HOME", "/from/env")
		if got := ResolveBaseDir("/from/flag"); got != "/from/flag" {
			t.Fatalf("flag 应优先，got %q", got)
		}
	})

	t.Run("无 flag 时用环境变量", func(t *testing.T) {
		t.Setenv("WORKFLOW_TOOL_HOME", "/from/env")
		if got := ResolveBaseDir(""); got != "/from/env" {
			t.Fatalf("应回退环境变量，got %q", got)
		}
	})

	t.Run("flag 与环境变量皆空时回退 exeDir", func(t *testing.T) {
		t.Setenv("WORKFLOW_TOOL_HOME", "")
		if got := ResolveBaseDir(""); got != ExeDir() {
			t.Fatalf("应回退 ExeDir()=%q，got %q", ExeDir(), got)
		}
	})
}

func TestExeDirAbsentActionsFallsBackToDot(t *testing.T) {
	// 测试二进制同级目录通常不含 actions/，故回退 "."。
	got := ExeDir()
	if got != "." && filepath.Base(got) == "" {
		t.Fatalf("ExeDir 返回非法路径 %q", got)
	}
}

func TestUserDir(t *testing.T) {
	t.Run("环境变量覆盖", func(t *testing.T) {
		t.Setenv("WORKFLOW_TOOL_USER_HOME", "/user/home")
		if got := UserDir(); got != "/user/home" {
			t.Fatalf("应取环境变量，got %q", got)
		}
	})

	t.Run("无环境变量时回退 ~/.workflow-tool", func(t *testing.T) {
		t.Setenv("WORKFLOW_TOOL_USER_HOME", "")
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skip("无 HomeDir 可用")
		}
		want := filepath.Join(home, ".workflow-tool")
		if got := UserDir(); got != want {
			t.Fatalf("UserDir = %q，want %q", got, want)
		}
	})

	t.Run("auth.json 落在用户目录下", func(t *testing.T) {
		t.Setenv("WORKFLOW_TOOL_USER_HOME", "/user/home")
		// 独立于 baseDir 的轴：WORKFLOW_TOOL_HOME 不影响它
		t.Setenv("WORKFLOW_TOOL_HOME", "/exe/dir")
		if got := AuthPath(); got != "/user/home/auth.json" {
			t.Fatalf("AuthPath = %q", got)
		}
	})
}
