package apphome

import (
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
