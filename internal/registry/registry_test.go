package registry

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeFile(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestLoad_Valid(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `
id: build
title: 构建
command:
  shell: pnpm build
  timeout: 90s
`)
	reg := Load(dir, "/base")
	if len(reg.Errors) != 0 {
		t.Fatalf("意外错误: %v", reg.Errors)
	}
	la, ok := reg.Actions["build"]
	if !ok {
		t.Fatal("缺少 build 动作")
	}
	if la.Timeout != 90*time.Second {
		t.Fatalf("timeout=%v want 90s", la.Timeout)
	}
}

func TestLoad_DefaultTimeout(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: x
title: X
command:
  shell: echo hi
`)
	reg := Load(dir, "/base")
	if reg.Actions["x"].Timeout != 60*time.Second {
		t.Fatalf("默认 timeout 应为 60s，got %v", reg.Actions["x"].Timeout)
	}
}

func TestLoad_BadFileSkipped(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "bad.yaml", `id: x
command:
  shell: x
shell: y`)
	writeFile(t, dir, "good.yaml", `id: y
title: Y
command:
  shell: echo
`)
	reg := Load(dir, "/base")
	if _, ok := reg.Actions["y"]; !ok {
		t.Fatal("good 文件应加载")
	}
	if len(reg.Errors) != 1 {
		t.Fatalf("应有 1 个错误，got %d", len(reg.Errors))
	}
}

func TestLoad_DuplicateID(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: dup
title: A
command:
  shell: echo a
`)
	writeFile(t, dir, "b.yaml", `id: dup
title: B
command:
  shell: echo b
`)
	reg := Load(dir, "/base")
	if len(reg.Errors) != 1 {
		t.Fatalf("应有重复 id 错误，got %d", len(reg.Errors))
	}
}

func TestLoad_InvalidID(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: Bad ID
title: X
command:
  shell: echo
`)
	reg := Load(dir, "/base")
	if len(reg.Errors) != 1 {
		t.Fatalf("id 不合法应报错")
	}
}

func TestLoad_ShellScriptMutex(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: x
title: X
command:
  shell: echo
  script: ./s
`)
	reg := Load(dir, "/base")
	if len(reg.Errors) != 1 {
		t.Fatalf("shell+script 同时存在应报错")
	}
}

func TestLoadParsesParamsAndPresets(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: a
title: A
params:
  - id: URL
    label: 网址
    type: text
    required: true
  - id: MODE
    label: 模式
    type: select
    options: [fast, full]
    default: fast
presets:
  - name: 首页
    values: { URL: https://example.com }
command:
  shell: echo ${URL}
`)
	reg := Load(dir, dir)
	if len(reg.Errors) != 0 {
		t.Fatalf("unexpected errors: %v", reg.Errors)
	}
	la := reg.Actions["a"]
	if len(la.Def.Params) != 2 {
		t.Fatalf("want 2 params, got %d", len(la.Def.Params))
	}
	if la.Def.Params[0].ID != "URL" || la.Def.Params[0].Type != "text" || !la.Def.Params[0].Required {
		t.Fatalf("bad param0: %+v", la.Def.Params[0])
	}
	if la.Def.Params[1].Type != "select" || len(la.Def.Params[1].Options) != 2 {
		t.Fatalf("bad param1: %+v", la.Def.Params[1])
	}
	if len(la.Def.Presets) != 1 || la.Def.Presets[0].Name != "首页" {
		t.Fatalf("bad presets: %+v", la.Def.Presets)
	}
	if la.Def.Presets[0].Values["URL"] != "https://example.com" {
		t.Fatalf("bad preset value: %+v", la.Def.Presets[0].Values)
	}
}

func TestLoadKeepsRawCwd(t *testing.T) {
	// 关键：Phase 3 不再在 Load 时替换 ${VAR}，Cwd 保持原样
	os.Unsetenv("NOPE_VAR")
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: a
title: A
command:
  shell: echo hi
  cwd: ${NOPE_VAR}/sub
`)
	reg := Load(dir, dir)
	la := reg.Actions["a"]
	if la.Cwd != "${NOPE_VAR}/sub" {
		t.Fatalf("Load 应保留 raw Cwd，got %q", la.Cwd)
	}
	// shell 也应保留 raw（不在 Load 替换）
	if la.Def.Command.Shell != "echo hi" {
		t.Fatalf("unexpected shell: %q", la.Def.Command.Shell)
	}
}

func TestValidateSelectRequiresOptions(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: a
title: A
params:
  - id: X
    label: x
    type: select
command:
  shell: echo hi
`)
	reg := Load(dir, dir)
	if len(reg.Errors) == 0 {
		t.Fatal("select 无 options 应报错")
	}
}

func TestValidateBadParamType(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: a
title: A
params:
  - id: X
    label: x
    type: color
command:
  shell: echo hi
`)
	reg := Load(dir, dir)
	if len(reg.Errors) == 0 {
		t.Fatal("非法 type 应报错")
	}
}

func TestLoadParsesStream(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: a
title: A
command:
  shell: echo hi
  stream: llm
`)
	reg := Load(dir, dir)
	if len(reg.Errors) != 0 {
		t.Fatalf("stream:llm 应合法，got errors: %v", reg.Errors)
	}
	la := reg.Actions["a"]
	if la.Def.Command.Stream != "llm" {
		t.Fatalf("want stream=llm，got %q", la.Def.Command.Stream)
	}
}

func TestValidateBadStream(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: a
title: A
command:
  shell: echo hi
  stream: wat
`)
	reg := Load(dir, dir)
	if len(reg.Errors) == 0 {
		t.Fatal("非法 stream 值应报错")
	}
}
