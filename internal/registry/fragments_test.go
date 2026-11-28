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

// 带 color 的片段保存后读回仍在；不带 color 的照常往返。
func TestFragmentColorRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "fragments.yaml")

	list := []Fragment{
		{Title: "带颜色", Content: "adb logcat -d", Tags: []string{"adb"}, Color: "blue"},
		{Title: "不带颜色", Content: "echo hi", Tags: []string{"build"}},
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

// 手改的非法颜色读时按未设置处理、不报错——一个坏颜色不该让整份片段列表读不出来。
func TestLoadFragmentsIllegalColorUnset(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "fragments.yaml")
	src := "fragments:\n  - title: 坏颜色\n    content: echo\n    color: pink\n"
	if err := os.WriteFile(path, []byte(src), 0644); err != nil {
		t.Fatal(err)
	}
	got, err := LoadFragments(path)
	if err != nil {
		t.Fatalf("非法颜色不应报错: %v", err)
	}
	if len(got) != 1 || got[0].Color != "" {
		t.Fatalf("非法颜色应按未设置: %+v", got)
	}
}

// 写时非法颜色同样按未设置（读与写同一口径）。
func TestSaveFragmentsIllegalColorUnset(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "fragments.yaml")
	list := []Fragment{{Title: "t", Content: "c", Color: "pink"}}
	if err := SaveFragments(path, list); err != nil {
		t.Fatal(err)
	}
	got, err := LoadFragments(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Color != "" {
		t.Fatalf("非法颜色写时应按未设置: %+v", got)
	}
}
