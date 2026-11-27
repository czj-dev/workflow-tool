package registry

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveAndLoadAuth(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "auth.json")

	kv := map[string]string{
		"AI_BASE_URL":  "http://example/v1",
		"AI_AUTH_KEY":  "sk-x",
		"AI_MODEL":     "GLM-5.3-Flash",
		"AI_EXTRA_KEY": "未知键也保留", // 词汇表外键透传，未来扩展不留死角
	}
	if err := SaveAuth(path, kv); err != nil {
		t.Fatal(err)
	}

	got, err := LoadAuth(path)
	if err != nil {
		t.Fatal(err)
	}
	for k, want := range kv {
		if got[k] != want {
			t.Fatalf("LoadAuth 回读不一致: %s = %q, want %q", k, got[k], want)
		}
	}
}

func TestSaveAuthPermissionDirAndNoTempLeftover(t *testing.T) {
	// 父目录（UserDir）不存在时应一并创建；文件 0600；原子写不留临时残留。
	path := filepath.Join(t.TempDir(), "user-home", "auth.json")
	if err := SaveAuth(path, map[string]string{"AI_AUTH_KEY": "k"}); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("auth.json 权限应为 0600，got %v", fi.Mode().Perm())
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() != "auth.json" {
			t.Fatalf("目录残留临时文件: %s", e.Name())
		}
	}
}

func TestSaveAuthNilMapWritesEmptyObject(t *testing.T) {
	// nil map 写成 {}（而非 null），回读得到空 map
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := SaveAuth(path, nil); err != nil {
		t.Fatal(err)
	}
	got, err := LoadAuth(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("nil map 回读应为空，got %+v", got)
	}
}

func TestLoadAuthMissingFile(t *testing.T) {
	// auth.json 不存在时返回空 map + nil error（首次配置前正常）
	got, err := LoadAuth(filepath.Join(t.TempDir(), "nope.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("want empty map, got %+v", got)
	}
}

func TestLoadAuthEmptyFile(t *testing.T) {
	// 空文件容忍：返回空 map + nil
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(path, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := LoadAuth(path)
	if err != nil {
		t.Fatalf("空文件不应报错: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("空文件应为空 map，got %+v", got)
	}
}

func TestLoadAuthCorruptFile(t *testing.T) {
	for name, content := range map[string]string{
		"语法损坏":   "{not json",
		"顶层非对象":   `["AI_AUTH_KEY"]`,
		"值为非字符串": `{"AI_AUTH_KEY": 123}`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "auth.json")
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := LoadAuth(path); err == nil {
				t.Fatal("损坏 auth.json 应报错")
			}
		})
	}
}
