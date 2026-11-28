package registry

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// 三个分组（不同颜色、不同成员）保存后新实例读回，顺序、名称、颜色、成员一致。
func TestSaveAndLoadVariableGroups(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "var-groups.yaml")

	// 分组颜色与 action/workflow/AI 任务共用同一张五色白名单（含 cyan）。
	groups := []VariableGroup{
		{Name: "路径", Color: "blue", Keys: []string{"DOCS", "LOGS_DIR", "OUTPUT_DIR"}},
		{Name: "XDZS 项目", Color: "cyan", Keys: []string{"XDZS_RESROUCE_DIR", "XDZS_SPEECH_DIR"}},
		{Name: "账号", Color: "violet", Keys: []string{"USER"}},
	}
	got, err := SaveVariableGroups(path, groups)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, groups) {
		t.Fatalf("SaveVariableGroups 应返回规整后的结果: got %+v want %+v", got, groups)
	}

	loaded, err := LoadVariableGroups(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(loaded, groups) {
		t.Fatalf("回读不一致: got %+v want %+v", loaded, groups)
	}
}

// 空分组（keys 为空）保存后读回仍在，成员为空（页面显示占位文案）。
func TestVariableGroupEmptyKeysRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "var-groups.yaml")

	groups := []VariableGroup{{Name: "空组", Color: "amber", Keys: []string{}}}
	if _, err := SaveVariableGroups(path, groups); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadVariableGroups(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded) != 1 || loaded[0].Name != "空组" || loaded[0].Color != "amber" || len(loaded[0].Keys) != 0 {
		t.Fatalf("空分组应原样读回: %+v", loaded)
	}
}

// 文件不存在：空列表、不报错（首次启动正常，文件第一次写入时才创建）。
func TestLoadVariableGroupsMissingFile(t *testing.T) {
	got, err := LoadVariableGroups(filepath.Join(t.TempDir(), "nope.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("want empty slice, got %+v", got)
	}
}

// 空文件：空列表、不报错。
func TestLoadVariableGroupsEmptyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "var-groups.yaml")
	if err := os.WriteFile(path, nil, 0644); err != nil {
		t.Fatal(err)
	}
	got, err := LoadVariableGroups(path)
	if err != nil {
		t.Fatalf("空文件不应报错: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("空文件应为空列表, got %+v", got)
	}
}

// YAML 无法解析：一律视为没有分组、不报错——分组是界面偏好，文件问题
// 不该让页面打不开或保存不了（坏文件在下次写入时被整份替换，自然修复）。
func TestLoadVariableGroupsGarbage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "var-groups.yaml")
	if err := os.WriteFile(path, []byte("groups:\n\t- name: x\n"), 0644); err != nil {
		t.Fatal(err)
	}
	got, err := LoadVariableGroups(path)
	if err != nil {
		t.Fatalf("无法解析应视为没有分组、不报错: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("无法解析应为空列表, got %+v", got)
	}
}

// 手改坏的文件（带空白的名字、空名、重名、非法颜色、跨组重复键）读时被规整
// 而不是报错——文件问题不该让页面打不开或保存不了。
func TestLoadVariableGroupsNormalizes(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "var-groups.yaml")
	src := `groups:
  - name: "  路径  "
    color: blue
    keys: [DOCS, LOGS_DIR]
  - name: ""
    color: green
    keys: [GONE]
  - name: 路径
    color: violet
    keys: [DUP_NAME]
  - name: 账号
    color: pink
    keys: [DOCS, USER]
`
	if err := os.WriteFile(path, []byte(src), 0644); err != nil {
		t.Fatal(err)
	}
	got, err := LoadVariableGroups(path)
	if err != nil {
		t.Fatal(err)
	}
	want := []VariableGroup{
		{Name: "路径", Color: "blue", Keys: []string{"DOCS", "LOGS_DIR"}},
		{Name: "账号", Color: "", Keys: []string{"USER"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("读时应规整: got %+v want %+v", got, want)
	}
}

// 写时同样规整（读与写共用同一套规则）：返回值与落盘内容都是规整后的。
func TestSaveVariableGroupsNormalizes(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "var-groups.yaml")
	groups := []VariableGroup{
		{Name: "  路径  ", Color: "blue", Keys: []string{"DOCS", "DOCS"}},
		{Name: "路径", Color: "green", Keys: []string{"DUP"}},
		{Name: "", Color: "violet", Keys: []string{"X"}},
		{Name: "账号", Color: "pink", Keys: []string{"USER"}},
	}
	got, err := SaveVariableGroups(path, groups)
	if err != nil {
		t.Fatal(err)
	}
	want := []VariableGroup{
		{Name: "路径", Color: "blue", Keys: []string{"DOCS"}},
		{Name: "账号", Color: "", Keys: []string{"USER"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("写时应规整: got %+v want %+v", got, want)
	}
	loaded, err := LoadVariableGroups(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(loaded, want) {
		t.Fatalf("落盘内容应是规整后的: got %+v want %+v", loaded, want)
	}
}
