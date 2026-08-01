package registry

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSaveAndLoadFragments(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "fragments.yaml")

	list := []Fragment{
		{Title: "查看 logcat", Content: "adb logcat -d > ${LOGS_DIR}/today.log", Tags: []string{"adb", "logcat"}},
		{Title: "拷贝构建产物", Content: "cp -r ${VOICE_DEBUG_OUTPUT}/*.apk ${OUTPUT_DIR}/", Tags: []string{"build"}},
	}
	if err := SaveFragments(path, list); err != nil {
		t.Fatal(err)
	}

	got, err := LoadFragments(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, list) {
		t.Fatalf("回读不一致: got %+v want %+v", got, list)
	}
}

func TestLoadFragmentsMissingFile(t *testing.T) {
	got, err := LoadFragments(filepath.Join(t.TempDir(), "nope.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("want empty slice, got %+v", got)
	}
}

func TestLoadFragmentsEmptyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.yaml")
	if err := os.WriteFile(path, []byte(""), 0644); err != nil {
		t.Fatal(err)
	}
	got, err := LoadFragments(path)
	if err != nil {
		t.Fatalf("空文件不应报错: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("空文件应为空切片，got %+v", got)
	}
}
