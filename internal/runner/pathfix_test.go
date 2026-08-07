package runner

import (
	"os"
	"runtime"
	"strings"
	"testing"
)

func TestMergePaths(t *testing.T) {
	cases := []struct {
		name      string
		primary   string
		secondary string
		want      string
	}{
		{"基本拼接", "/a:/b", "/c", "/a:/b:/c"},
		{"去重保留首次出现", "/a:/b", "/b:/c", "/a:/b:/c"},
		{"primary 优先", "/new", "/old:/new", "/new:/old"},
		{"丢弃空段", "/a::/b:", ":/c", "/a:/b:/c"},
		{"secondary 为空", "/a", "", "/a"},
		{"primary 为空", "", "/a", "/a"},
		{"全空", "", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := mergePaths(c.primary, c.secondary); got != c.want {
				t.Fatalf("mergePaths(%q, %q) = %q, want %q", c.primary, c.secondary, got, c.want)
			}
		})
	}
}

func TestFallbackPATH(t *testing.T) {
	got := fallbackPATH()
	// homebrew 双架构路径必须都在（Intel /usr/local + Apple Silicon /opt/homebrew）
	for _, want := range []string{"/usr/local/bin", "/opt/homebrew/bin"} {
		if !strings.Contains(got, want) {
			t.Errorf("fallbackPATH 缺 %q: %q", want, got)
		}
	}
	// 不能有空段（PATH 空段等于当前目录，是安全隐患）
	for _, dir := range strings.Split(got, ":") {
		if dir == "" {
			t.Errorf("fallbackPATH 含空段: %q", got)
		}
	}
}

// TestFixPath_PreservesExisting 验证 FixPath 只追加不丢弃原有 PATH 条目。
func TestFixPath_PreservesExisting(t *testing.T) {
	orig := os.Getenv("PATH")
	t.Cleanup(func() { os.Setenv("PATH", orig) })

	os.Setenv("PATH", "/sentinel/bin")
	FixPath()
	after := os.Getenv("PATH")

	if runtime.GOOS != "darwin" {
		if after != "/sentinel/bin" {
			t.Fatalf("非 darwin 应原样不动，got %q", after)
		}
		return
	}
	if !strings.Contains(after, "/sentinel/bin") {
		t.Fatalf("原有 PATH 条目被丢弃: %q", after)
	}
	if !strings.Contains(after, "/usr/bin") && !strings.Contains(after, "/usr/local/bin") {
		t.Fatalf("未补入任何常见路径: %q", after)
	}
}
