package registry

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
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
  run: pnpm build
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
  run: echo hi
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
  run: x
shell: y`)
	writeFile(t, dir, "good.yaml", `id: y
title: Y
command:
  run: echo
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
  run: echo a
`)
	writeFile(t, dir, "b.yaml", `id: dup
title: B
command:
  run: echo b
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
  run: echo
`)
	reg := Load(dir, "/base")
	if len(reg.Errors) != 1 {
		t.Fatalf("id 不合法应报错")
	}
}

func TestLoad_RunScriptMutex(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: x
title: X
command:
  run: echo
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
  run: echo ${URL}
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
  run: echo hi
  cwd: ${NOPE_VAR}/sub
`)
	reg := Load(dir, dir)
	la := reg.Actions["a"]
	if la.Cwd != "${NOPE_VAR}/sub" {
		t.Fatalf("Load 应保留 raw Cwd，got %q", la.Cwd)
	}
	// run 也应保留 raw（不在 Load 替换）
	if la.Def.Command.Run != "echo hi" {
		t.Fatalf("unexpected run: %q", la.Def.Command.Run)
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
  run: echo hi
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
  run: echo hi
`)
	reg := Load(dir, dir)
	if len(reg.Errors) == 0 {
		t.Fatal("非法 type 应报错")
	}
}

// TestValidateAcceptsFileParamType 确保 file 与 path 一同被接受为合法参数类型
// （adb-push 的 LOCAL_PATH / adb-install 的 APK_PATH 使用）。path 走目录选择器，
// file 走文件选择器。
func TestValidateAcceptsFileParamType(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: a
title: A
params:
  - id: LOCAL
    label: 本地文件
    type: file
    required: true
command:
  run: echo ${LOCAL}
`)
	reg := Load(dir, dir)
	if len(reg.Errors) != 0 {
		t.Fatalf("type:file 应合法，got errors: %v", reg.Errors)
	}
	if reg.Actions["a"].Def.Params[0].Type != "file" {
		t.Fatalf("want param type file, got %q", reg.Actions["a"].Def.Params[0].Type)
	}
}

// TestLoadParsesLLM 验证 command.llm 一等形态：system 可选、prompt 必填，
// 两者引用的 param 都存在时应合法加载。
func TestLoadParsesLLM(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: a
title: A
params:
  - { id: ROLE, label: 角色, type: textarea }
  - { id: QUESTION, label: 问题, type: textarea, required: true }
command:
  llm:
    system: ROLE
    prompt: QUESTION
`)
	reg := Load(dir, dir)
	if len(reg.Errors) != 0 {
		t.Fatalf("command.llm 应合法，got errors: %v", reg.Errors)
	}
	la := reg.Actions["a"]
	if la.Def.Command.LLM.Prompt != "QUESTION" || la.Def.Command.LLM.System != "ROLE" {
		t.Fatalf("want llm.prompt=QUESTION llm.system=ROLE，got %+v", la.Def.Command.LLM)
	}
}

// TestValidateLLMRequiresPromptParam 验证 command.llm.prompt 引用不存在的 param 时报错。
func TestValidateLLMRequiresPromptParam(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: a
title: A
command:
  llm:
    prompt: QUESTION
`)
	reg := Load(dir, dir)
	if len(reg.Errors) == 0 {
		t.Fatal("command.llm.prompt 引用不存在的 param 应报错")
	}
}

// TestValidateCommandFourWayExclusive 验证 shell/script/adb/llm 四选一互斥。
func TestValidateCommandFourWayExclusive(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: a
title: A
params:
  - { id: QUESTION, label: 问题, type: textarea, required: true }
command:
  run: echo hi
  llm:
    prompt: QUESTION
`)
	reg := Load(dir, dir)
	if len(reg.Errors) == 0 {
		t.Fatal("shell 与 llm 同时指定应报错")
	}
}

func TestValidateBadStream(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: a
title: A
command:
  run: echo hi
  stream: wat
`)
	reg := Load(dir, dir)
	if len(reg.Errors) == 0 {
		t.Fatal("非法 stream 值应报错")
	}
}

func TestLoadParsesStreamLogcat(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: a
title: A
command:
  run: echo hi
  stream: logcat
`)
	reg := Load(dir, dir)
	if len(reg.Errors) != 0 {
		t.Fatalf("stream:logcat 应合法，got errors: %v", reg.Errors)
	}
	la := reg.Actions["a"]
	if la.Def.Command.Stream != "logcat" {
		t.Fatalf("want stream=logcat，got %q", la.Def.Command.Stream)
	}
}

func TestLoadRecordsSourceFile(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: a
title: A
command:
  run: echo hi
`)
	reg := Load(dir, dir)
	la := reg.Actions["a"]
	if la.File == "" {
		t.Fatal("Load 应在 LoadedAction.File 记录源文件路径")
	}
	if filepath.Base(la.File) != "a.yaml" {
		t.Fatalf("File 应指向 a.yaml，got %q", la.File)
	}
}

func TestParseActionExported(t *testing.T) {
	def, err := ParseAction([]byte("id: a\ntitle: A\ncommand:\n  run: echo\n"))
	if err != nil {
		t.Fatal(err)
	}
	if def.ID != "a" || def.Title != "A" {
		t.Fatalf("ParseAction 解析错误: %+v", def)
	}
}

func TestValidateExported(t *testing.T) {
	legal := &ActionDef{ID: "a", Title: "A", Command: Command{Run: "echo"}}
	if err := Validate(legal); err != nil {
		t.Fatalf("合法定义不应报错: %v", err)
	}
	bad := &ActionDef{ID: "Bad ID"}
	if err := Validate(bad); err == nil {
		t.Fatal("非法 id 应被 Validate 拒绝")
	}
}

func TestAddPresetToYAML_NewPreset(t *testing.T) {
	in := []byte("id: a\ntitle: A\ncommand:\n  run: echo\n")
	out, err := AddPresetToYAML(in, "p1", "描述", map[string]string{"URL": "x"})
	if err != nil {
		t.Fatalf("AddPresetToYAML: %v", err)
	}
	def, err := ParseAction(out)
	if err != nil {
		t.Fatalf("输出无法解析: %v\n%s", err, out)
	}
	if len(def.Presets) != 1 || def.Presets[0].Name != "p1" {
		t.Fatalf("want 1 preset p1, got %+v", def.Presets)
	}
	if def.Presets[0].Description != "描述" {
		t.Fatalf("description want 描述, got %q", def.Presets[0].Description)
	}
	if def.Presets[0].Values["URL"] != "x" {
		t.Fatalf("values.URL want x, got %+v", def.Presets[0].Values)
	}
}

func TestAddPresetToYAML_OverwriteSameName(t *testing.T) {
	in := []byte("id: a\ntitle: A\npresets:\n  - name: p1\n    values: {URL: old}\ncommand:\n  run: echo\n")
	out, err := AddPresetToYAML(in, "p1", "新描述", map[string]string{"URL": "new"})
	if err != nil {
		t.Fatal(err)
	}
	def, _ := ParseAction(out)
	if len(def.Presets) != 1 {
		t.Fatalf("覆盖后应仍为 1 个 preset, got %d", len(def.Presets))
	}
	if def.Presets[0].Values["URL"] != "new" {
		t.Fatalf("URL 应覆盖为 new, got %q", def.Presets[0].Values["URL"])
	}
	if def.Presets[0].Description != "新描述" {
		t.Fatalf("description 应为新描述, got %q", def.Presets[0].Description)
	}
}

func TestAddPresetToYAML_EmptyName(t *testing.T) {
	if _, err := AddPresetToYAML([]byte("id: a\ntitle: A\n"), "  ", "", nil); err == nil {
		t.Fatal("空 name 应报错")
	}
}

func TestAddPresetToYAML_OverwriteMovesToEnd(t *testing.T) {
	in := []byte("id: a\ntitle: A\npresets:\n  - name: A1\n    values: {K: 1}\n  - name: B1\n    values: {K: 2}\n  - name: C1\n    values: {K: 3}\ncommand:\n  run: echo\n")
	out, err := AddPresetToYAML(in, "B1", "", map[string]string{"K": "new"})
	if err != nil {
		t.Fatal(err)
	}
	def, _ := ParseAction(out)
	if len(def.Presets) != 3 {
		t.Fatalf("want 3 presets, got %d", len(def.Presets))
	}
	// 覆盖 B1 → 删旧 + 追加，顺序应为 [A1, C1, B1]
	order := []string{def.Presets[0].Name, def.Presets[1].Name, def.Presets[2].Name}
	want := []string{"A1", "C1", "B1"}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("顺序应为 %v, got %v", want, order)
		}
	}
	if def.Presets[2].Values["K"] != "new" {
		t.Fatalf("B1 值应更新为 new, got %q", def.Presets[2].Values["K"])
	}
}

func TestAddPresetToYAML_PreservesStandardFormat(t *testing.T) {
	// 2 空格缩进、无 quote 的标准格式是仓库动作 yaml 的主流形态；
	// 锁住 round-trip 后原 id/title/command/params 行原样保留、缩进仍为 2 空格。
	in := []byte("id: a\ntitle: A\nparams:\n  - id: URL\n    label: 网址\n    type: text\ncommand:\n  run: echo ${URL}\n")
	out, err := AddPresetToYAML(in, "p1", "描述", map[string]string{"URL": "x"})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{
		"id: a\n",
		"title: A\n",
		"  - id: URL\n",
		"    type: text\n",
		"  run: echo ${URL}\n",
	} {
		if !strings.Contains(s, want) {
			t.Fatalf("round-trip 后应保留 %q, got:\n%s", want, s)
		}
	}
	// 新 preset 在末尾、含 description + flow values（标准 2 空格缩进 list）
	if !strings.Contains(s, "  - name: p1\n") || !strings.Contains(s, "    description: 描述\n") {
		t.Fatalf("新 preset 块缺失, got:\n%s", s)
	}
}

func TestParseAction_CaptureOutputField(t *testing.T) {
	yamlSrc := []byte(`
id: test-capture
title: 测试
command:
  run: echo hi
  capture_output: false
`)
	def, err := ParseAction(yamlSrc)
	if err != nil {
		t.Fatalf("ParseAction error: %v", err)
	}
	if def.Command.CaptureOutput == nil || *def.Command.CaptureOutput != false {
		t.Fatalf("CaptureOutput = %v, want pointer to false", def.Command.CaptureOutput)
	}
}

func TestParseAction_CaptureOutputDefaultNil(t *testing.T) {
	yamlSrc := []byte(`
id: test-capture-default
title: 测试
command:
  run: echo hi
`)
	def, err := ParseAction(yamlSrc)
	if err != nil {
		t.Fatalf("ParseAction error: %v", err)
	}
	if def.Command.CaptureOutput != nil {
		t.Fatalf("CaptureOutput 未写时应为 nil（表示默认 true），got %v", *def.Command.CaptureOutput)
	}
}

func TestAddPresetToYAML_PreservesComments(t *testing.T) {
	in := []byte("# 顶部注释\nid: a\ntitle: A\ncommand:\n  run: echo\n")
	out, err := AddPresetToYAML(in, "p1", "", map[string]string{"K": "v"})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(out, []byte("# 顶部注释")) {
		t.Fatalf("顶部注释应保留, got:\n%s", out)
	}
}

// TestValidate_ShellModifier 校验 shell 修饰字段：非法值报错、配 adb/llm 形态报错。
func TestValidate_ShellModifier(t *testing.T) {
	cases := []struct {
		name    string
		yaml    string
		wantErr string
	}{
		{"合法内置名", "id: a\ntitle: A\ncommand:\n  run: echo\n  shell: pwsh\n", ""},
		{"合法自定义模板", "id: a\ntitle: A\ncommand:\n  run: echo\n  shell: \"perl {0}\"\n", ""},
		{"非法工具名", "id: a\ntitle: A\ncommand:\n  run: echo\n  shell: zsh\n", "command.shell 非法"},
		{"自定义模板缺占位符", "id: a\ntitle: A\ncommand:\n  run: echo\n  shell: perl\n", "command.shell 非法"},
		{"shell 配 adb 形态", "id: a\ntitle: A\ncommand:\n  adb:\n    operation: list-packages\n  shell: bash\n", "只能搭配 run/script"},
		{"shell 配 llm 形态", "id: a\ntitle: A\nparams:\n  - id: p\n    type: text\ncommand:\n  llm:\n    prompt: p\n  shell: bash\n", "只能搭配 run/script"},
	}
	for _, c := range cases {
		def, err := ParseAction([]byte(c.yaml))
		if err != nil {
			t.Fatalf("%s: parse: %v", c.name, err)
		}
		err = Validate(def)
		if c.wantErr == "" {
			if err != nil {
				t.Errorf("%s: 不应报错, got %v", c.name, err)
			}
		} else if err == nil || !strings.Contains(err.Error(), c.wantErr) {
			t.Errorf("%s: 应报含 %q 的错误, got %v", c.name, c.wantErr, err)
		}
	}
}

// TestValidate_ScriptExtension 校验 script 扩展名受支持；显式写 shell 时扩展名推断让位
// （design 第 53 行「shell: 字段可显式覆盖扩展名推断」，runner 侧本就支持）。
func TestValidate_ScriptExtension(t *testing.T) {
	ok := &ActionDef{ID: "a", Title: "A", Command: Command{Script: "./s/hello.py"}}
	if err := Validate(ok); err != nil {
		t.Fatalf(".py 应合法: %v", err)
	}
	bad := &ActionDef{ID: "a", Title: "A", Command: Command{Script: "./s/hello.rb"}}
	if err := Validate(bad); err == nil {
		t.Fatal(".rb 扩展名应报错")
	}
	override := &ActionDef{ID: "a", Title: "A", Command: Command{Script: "./s/hello.pl", Shell: "perl {0}"}}
	if err := Validate(override); err != nil {
		t.Fatalf("script + 显式 shell 应合法（校验不该比引擎更严）: %v", err)
	}
}
