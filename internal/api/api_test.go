package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"workflow-tool/internal/registry"
)

func TestRunActionMergesGlobalAndParams(t *testing.T) {
	// 全局 OUTPUT_DIR + 参数 NAME；参数应覆盖同名全局
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	fragPath := filepath.Join(dir, "fragments.yaml")
	registry.SaveGlobal(cfgPath, map[string]string{"OUTPUT_DIR": "D:/pages", "NAME": "global-name"})

	reg := registry.Load(dir, dir) // 空动作，仅用于占位
	svc := New(reg, nil, dir, cfgPath, fragPath)

	// 直接测 merge 逻辑（不实际 exec）
	merged := svc.mergeGlobalAndParams(map[string]any{"NAME": "param-name"})
	if merged["OUTPUT_DIR"] != "D:/pages" {
		t.Fatalf("全局未合并: %+v", merged)
	}
	if merged["NAME"] != "param-name" {
		t.Fatalf("参数应覆盖全局: %+v", merged)
	}
}

func TestGetAndSetGlobalConfig(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	fragPath := filepath.Join(dir, "fragments.yaml")
	svc := New(registry.Load(dir, dir), nil, dir, cfgPath, fragPath)

	if err := svc.SetGlobalConfig(map[string]string{"OUTPUT_DIR": "D:/new"}); err != nil {
		t.Fatal(err)
	}
	got := svc.GetGlobalConfig()
	if got["OUTPUT_DIR"] != "D:/new" {
		t.Fatalf("Get 与 Set 不一致: %+v", got)
	}
	// 确认落盘
	persisted, _ := registry.LoadGlobal(cfgPath)
	if persisted["OUTPUT_DIR"] != "D:/new" {
		t.Fatalf("未写回文件: %+v", persisted)
	}
}

func TestListActionsIncludesParamsAndPresets(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	os.WriteFile(filepath.Join(dir, "a.yaml"), []byte(`id: a
title: A
params:
  - id: URL
    label: 网址
    type: text
    required: true
presets:
  - name: 首页
    values: { URL: https://example.com }
command:
  shell: echo ${URL}
`), 0644)

	svc := New(registry.Load(dir, dir), nil, dir, cfgPath, filepath.Join(dir, "fragments.yaml"))
	res := svc.ListActions()
	if len(res.Actions) != 1 {
		t.Fatalf("want 1 action, got %d", len(res.Actions))
	}
	a := res.Actions[0]
	if len(a.Params) != 1 || a.Params[0].ID != "URL" {
		t.Fatalf("ListActions 未带回 Params: %+v", a.Params)
	}
	if len(a.Presets) != 1 || a.Presets[0].Name != "首页" {
		t.Fatalf("ListActions 未带回 Presets: %+v", a.Presets)
	}
}

func TestListActionsIncludesStream(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	os.WriteFile(filepath.Join(dir, "a.yaml"), []byte(`id: a
title: A
command:
  shell: echo hi
  stream: llm
`), 0644)

	svc := New(registry.Load(dir, dir), nil, dir, cfgPath, filepath.Join(dir, "fragments.yaml"))
	res := svc.ListActions()
	if len(res.Actions) != 1 {
		t.Fatalf("want 1 action, got %d", len(res.Actions))
	}
	if res.Actions[0].Stream != "llm" {
		t.Fatalf("ListActions 未带回 stream: %+v", res.Actions[0].Stream)
	}
}

func TestGetActionYamlReturnsRawWithComments(t *testing.T) {
	dir := t.TempDir()
	ad := filepath.Join(dir, "actions")
	os.Mkdir(ad, 0755)
	os.WriteFile(filepath.Join(ad, "a.yaml"), []byte("# 注释\nid: a\ntitle: A\ncommand:\n  shell: echo hi\n"), 0644)
	svc := New(registry.Load(ad, dir), nil, dir, filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
	got, err := svc.GetActionYaml("a")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "# 注释") {
		t.Fatalf("应保留注释原文，got %q", got)
	}
}

func TestSetActionYamlValidWritesAndReloads(t *testing.T) {
	dir := t.TempDir()
	ad := filepath.Join(dir, "actions")
	os.Mkdir(ad, 0755)
	os.WriteFile(filepath.Join(ad, "a.yaml"), []byte("id: a\ntitle: A\ncommand:\n  shell: echo hi\n"), 0644)
	svc := New(registry.Load(ad, dir), nil, dir, filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
	res, err := svc.SetActionYaml("a", "id: a\ntitle: 改名\ncommand:\n  shell: echo bye\n")
	if err != nil {
		t.Fatal(err)
	}
	if res.Actions[0].Title != "改名" {
		t.Fatalf("重载后应见新标题，got %+v", res.Actions[0])
	}
	persisted, _ := svc.GetActionYaml("a")
	if !strings.Contains(persisted, "改名") {
		t.Fatalf("应落盘，got %q", persisted)
	}
}

func TestSetActionYamlRejectsBadYAML(t *testing.T) {
	dir := t.TempDir()
	ad := filepath.Join(dir, "actions")
	os.Mkdir(ad, 0755)
	orig := "id: a\ntitle: A\ncommand:\n  shell: echo hi\n"
	os.WriteFile(filepath.Join(ad, "a.yaml"), []byte(orig), 0644)
	svc := New(registry.Load(ad, dir), nil, dir, filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
	_, err := svc.SetActionYaml("a", "id: a\n  : : :\n")
	if err == nil {
		t.Fatal("非法 yaml 应报错")
	}
	got, _ := svc.GetActionYaml("a")
	if got != orig {
		t.Fatalf("非法时不该写盘，got %q", got)
	}
}

func TestSetActionYamlRejectsValidation(t *testing.T) {
	dir := t.TempDir()
	ad := filepath.Join(dir, "actions")
	os.Mkdir(ad, 0755)
	os.WriteFile(filepath.Join(ad, "a.yaml"), []byte("id: a\ntitle: A\ncommand:\n  shell: echo hi\n"), 0644)
	svc := New(registry.Load(ad, dir), nil, dir, filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
	// 缺 title → Validate 失败
	_, err := svc.SetActionYaml("a", "id: a\ncommand:\n  shell: echo\n")
	if err == nil {
		t.Fatal("校验失败应报错")
	}
}

func TestSetActionYamlRejectsIDChange(t *testing.T) {
	dir := t.TempDir()
	ad := filepath.Join(dir, "actions")
	os.Mkdir(ad, 0755)
	orig := "id: a\ntitle: A\ncommand:\n  shell: echo hi\n"
	os.WriteFile(filepath.Join(ad, "a.yaml"), []byte(orig), 0644)
	svc := New(registry.Load(ad, dir), nil, dir, filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
	_, err := svc.SetActionYaml("a", "id: b\ntitle: A\ncommand:\n  shell: echo\n")
	if err == nil {
		t.Fatal("改 id 应被拒绝")
	}
	got, _ := svc.GetActionYaml("a")
	if got != orig {
		t.Fatalf("改 id 被拒不该写盘，got %q", got)
	}
}
