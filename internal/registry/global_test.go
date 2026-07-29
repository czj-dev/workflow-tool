package registry

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveAndLoadGlobal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	kv := map[string]string{"OUTPUT_DIR": "D:/pages", "PROJECT": "myapp"}
	if err := SaveGlobal(path, kv); err != nil {
		t.Fatal(err)
	}

	got, err := LoadGlobal(path)
	if err != nil {
		t.Fatal(err)
	}
	if got["OUTPUT_DIR"] != "D:/pages" || got["PROJECT"] != "myapp" {
		t.Fatalf("LoadGlobal 回读不一致: %+v", got)
	}
}

func TestLoadGlobalMissingFile(t *testing.T) {
	// config.yaml 不存在时返回空 map + nil error（启动时正常）
	got, err := LoadGlobal(filepath.Join(t.TempDir(), "nope.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("want empty map, got %+v", got)
	}
}

func TestLoadGlobalEmptyFile(t *testing.T) {
	// 空文件应容忍：返回空 map + nil
	dir := t.TempDir()
	path := filepath.Join(dir, "c.yaml")
	if err := os.WriteFile(path, []byte(""), 0644); err != nil {
		t.Fatal(err)
	}
	got, err := LoadGlobal(path)
	if err != nil {
		t.Fatalf("空文件不应报错: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("空文件应为空 map，got %+v", got)
	}
}
