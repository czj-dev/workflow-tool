package api

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"workflow-tool/internal/registry"
	"workflow-tool/internal/workflow"
)

// newVarGroupsService 在临时 exe 目录上构造 Service（路径推导同 schedules.yaml：
// var-groups.yaml 取 baseDir 同级）。
func newVarGroupsService(t *testing.T, dir string) *Service {
	t.Helper()
	return New(registry.Load(filepath.Join(dir, "actions"), dir),
		workflow.Load(filepath.Join(dir, "workflows")), dir,
		filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
}

// 三个分组（不同颜色、不同成员）设置后新实例读回，顺序、名称、颜色、成员一致。
func TestVariableGroupsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	svc := newVarGroupsService(t, dir)

	groups := []registry.VariableGroup{
		{Name: "路径", Color: "blue", Keys: []string{"DOCS", "LOGS_DIR", "OUTPUT_DIR"}},
		{Name: "XDZS 项目", Color: "cyan", Keys: []string{"XDZS_RESROUCE_DIR", "XDZS_SPEECH_DIR"}},
		{Name: "账号", Color: "violet", Keys: []string{"USER"}},
	}
	got, err := svc.SetVariableGroups(groups)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, groups) {
		t.Fatalf("SetVariableGroups 应返回规整后的结果: got %+v want %+v", got, groups)
	}
	if now := svc.GetVariableGroups(); !reflect.DeepEqual(now, groups) {
		t.Fatalf("写入后内存态应立即可读: got %+v want %+v", now, groups)
	}

	// 重新构造实例（模拟重启），从 exe 同级 var-groups.yaml 读回。
	restarted := newVarGroupsService(t, dir)
	if loaded := restarted.GetVariableGroups(); !reflect.DeepEqual(loaded, groups) {
		t.Fatalf("新实例读回不一致: got %+v want %+v", loaded, groups)
	}
}

// 写入分组不触碰 config.yaml：文件内容与 GetGlobalConfig 结果都不变。
func TestSetVariableGroupsDoesNotTouchGlobalConfig(t *testing.T) {
	dir := t.TempDir()
	cfg := "DOCS: /home/u/Documents\nUSER: /home/u\n"
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(cfg), 0644); err != nil {
		t.Fatal(err)
	}
	svc := newVarGroupsService(t, dir)
	before := svc.GetGlobalConfig()

	if _, err := svc.SetVariableGroups([]registry.VariableGroup{{Name: "路径", Color: "blue", Keys: []string{"DOCS"}}}); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(filepath.Join(dir, "config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != cfg {
		t.Fatalf("config.yaml 不应被改动: got %q want %q", string(raw), cfg)
	}
	if after := svc.GetGlobalConfig(); !reflect.DeepEqual(after, before) {
		t.Fatalf("GetGlobalConfig 结果不应变化: got %+v want %+v", after, before)
	}
}

// 文件不存在 / 为空 / YAML 无法解析 → Service 构造成功，读回空列表、不报错。
func TestVariableGroupsTolerantLoading(t *testing.T) {
	cases := []struct {
		name   string
		body   string
		create bool
	}{
		{"文件不存在", "", false},
		{"空文件", "", true},
		{"无法解析", "groups:\n\t- name: x\n", true},
	}
	for _, c := range cases {
		dir := t.TempDir()
		if c.create {
			if err := os.WriteFile(filepath.Join(dir, "var-groups.yaml"), []byte(c.body), 0644); err != nil {
				t.Fatal(err)
			}
		}
		svc := newVarGroupsService(t, dir)
		if got := svc.GetVariableGroups(); len(got) != 0 {
			t.Errorf("%s: 应读回空列表, got %+v", c.name, got)
		}
	}
}

// SetVariableGroups 返回并落盘规整后的结果（重名保第一、非法颜色按未设置）。
func TestSetVariableGroupsNormalizes(t *testing.T) {
	dir := t.TempDir()
	svc := newVarGroupsService(t, dir)

	got, err := svc.SetVariableGroups([]registry.VariableGroup{
		{Name: "  路径  ", Color: "pink", Keys: []string{"DOCS"}},
		{Name: "路径", Color: "green", Keys: []string{"DUP"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []registry.VariableGroup{{Name: "路径", Color: "", Keys: []string{"DOCS"}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v want %+v", got, want)
	}
	if loaded := newVarGroupsService(t, dir).GetVariableGroups(); !reflect.DeepEqual(loaded, want) {
		t.Fatalf("落盘应是规整后的: got %+v want %+v", loaded, want)
	}
}
