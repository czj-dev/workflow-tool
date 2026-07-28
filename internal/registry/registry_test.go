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
