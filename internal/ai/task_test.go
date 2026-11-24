package ai

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workflow-tool/internal/registry"
)

const validTask = `id: card-flow
title: 卡片流转
icon: hi:ai
description: 输入卡片与操作要求
color: violet
params:
  - id: CARD_ID
    label: iCafe 卡片信息
    type: text
    required: true
  - id: STATE
    label: 目标状态
    type: text
presets:
  - name: 关闭
    values: { STATE: 已关闭 }
system: |
  你是一个 sess 平台的专业助手。
prompt: |
  请处理 ${CARD_ID} 卡片
timeout: 5m
cwd: ${WORK_DIR}
env:
  KEY: value
skills: [icafe-skill]
`

func mustParse(t *testing.T, yamlText string, skills map[string]registry.SkillMeta) *Task {
	t.Helper()
	task, err := Parse([]byte(yamlText), skills)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return task
}

func TestParseValidTask(t *testing.T) {
	task := mustParse(t, validTask, map[string]registry.SkillMeta{
		"icafe-skill": {Scope: "project", Dir: "/src/skills/icafe-skill"},
	})
	if task.ID != "card-flow" || task.Title != "卡片流转" || task.Color != "violet" {
		t.Errorf("基础字段解析不符：%+v", task)
	}
	if len(task.Params) != 2 || task.Params[0].ID != "CARD_ID" || !task.Params[0].Required {
		t.Errorf("params 解析不符：%+v", task.Params)
	}
	if len(task.Presets) != 1 || task.Presets[0].Values["STATE"] != "已关闭" {
		t.Errorf("presets 解析不符：%+v", task.Presets)
	}
	if !strings.HasPrefix(task.PromptText(), "请处理 ${CARD_ID} 卡片") {
		t.Errorf("prompt 解析不符：%q", task.PromptText())
	}
	if d, err := task.TimeoutDuration(); err != nil || d != 5*time.Minute {
		t.Errorf("timeout = %v, %v", d, err)
	}
	if task.Env["KEY"] != "value" || len(task.Skills) != 1 {
		t.Errorf("env/skills 解析不符：%+v", task)
	}
}

func TestTimeoutDefaultsAndValidation(t *testing.T) {
	task := mustParse(t, "id: a\ntitle: A\nprompt: hi\n", nil)
	if d, _ := task.TimeoutDuration(); d != DefaultTimeout {
		t.Errorf("未写 timeout 应为 %v，got %v", DefaultTimeout, d)
	}
	for name, text := range map[string]string{
		"非法字符串": "id: a\ntitle: A\nprompt: hi\ntimeout: soon\n",
		"非正数":   "id: a\ntitle: A\nprompt: hi\ntimeout: 0s\n",
	} {
		if _, err := Parse([]byte(text), nil); err == nil || !strings.Contains(err.Error(), "timeout") {
			t.Errorf("%s：timeout 应报错（不回落默认值），got %v", name, err)
		}
	}
}

func TestParseRejectsUnknownTopLevelKey(t *testing.T) {
	_, err := Parse([]byte("id: a\ntitle: A\nprompt: hi\nbogus: 1\n"), nil)
	if err == nil {
		t.Fatal("未知顶层键应报错")
	}
	if !strings.Contains(err.Error(), `未知字段 "bogus"`) || !strings.Contains(err.Error(), strings.Join(fieldOrder, "/")) {
		t.Errorf("报错应列出全部合法键，got %v", err)
	}
}

func TestParseRejectsReservedFields(t *testing.T) {
	for _, field := range reservedFields {
		_, err := Parse([]byte("id: a\ntitle: A\nprompt: hi\n"+field+": x\n"), nil)
		if err == nil || !strings.Contains(err.Error(), "已预留、暂未实现") {
			t.Errorf("预留字段 %q 应报「已预留、暂未实现」，got %v", field, err)
		}
	}
}

func TestParseRejectsUnknownNestedKey(t *testing.T) {
	text := "id: a\ntitle: A\nprompt: hi\nparams:\n  - id: X\n    label: X\n    type: text\n    bogus: 1\n"
	if _, err := Parse([]byte(text), nil); err == nil || !strings.Contains(err.Error(), "bogus") {
		t.Errorf("嵌套层的未知键应报错，got %v", err)
	}
}

func TestPromptKeyRequiredButMayBeEmpty(t *testing.T) {
	if _, err := Parse([]byte("id: a\ntitle: A\n"), nil); err == nil || !strings.Contains(err.Error(), "prompt") {
		t.Errorf("prompt 键缺失应报错，got %v", err)
	}
	for name, text := range map[string]string{
		"空串":   "id: a\ntitle: A\nprompt: \"\"\n",
		"null": "id: a\ntitle: A\nprompt:\n",
	} {
		task, err := Parse([]byte(text), nil)
		if err != nil {
			t.Errorf("%s：prompt 键出现即合法，got %v", name, err)
			continue
		}
		if task.Prompt == nil || task.PromptText() != "" {
			t.Errorf("%s：prompt 应解析为空串，got %v", name, task.Prompt)
		}
	}
}

func TestParamsCannotClaimReservedRunParams(t *testing.T) {
	for _, name := range ReservedRunParams() {
		text := "id: a\ntitle: A\nprompt: hi\nparams:\n  - { id: " + name + ", label: L, type: text }\n"
		if _, err := Parse([]byte(text), nil); err == nil || !strings.Contains(err.Error(), "保留运行参数") {
			t.Errorf("params 不得占用 %q，got %v", name, err)
		}
	}
}

func TestPresetValuesKeys(t *testing.T) {
	// 预设值的键可以是已声明 param 或保留运行参数
	task := mustParse(t, `
id: a
title: A
prompt: hi
params:
  - { id: STATE, label: 状态, type: text }
presets:
  - name: 关闭
    values: { STATE: 已关闭, prompt: 关掉它, system: "", resume: s1 }
`, nil)
	if len(task.Presets) != 1 || task.Presets[0].Values["prompt"] != "关掉它" {
		t.Fatalf("presets 解析不符：%+v", task.Presets)
	}
	// 指向未声明的参数：报错（防拼写错误静默落空）
	_, err := Parse([]byte("id: a\ntitle: A\nprompt: hi\npresets:\n  - name: n\n    values: { STAT: x }\n"), nil)
	if err == nil || !strings.Contains(err.Error(), `未声明的参数 "STAT"`) {
		t.Errorf("预设引用未声明参数应报错，got %v", err)
	}
}

func TestValidateParamSpecsSharedWithActions(t *testing.T) {
	cases := map[string]string{
		"select 缺 options": "id: a\ntitle: A\nprompt: hi\nparams:\n  - { id: S, label: S, type: select }\n",
		"type 非法":          "id: a\ntitle: A\nprompt: hi\nparams:\n  - { id: S, label: S, type: magic }\n",
		"数组默认值非法":          "id: a\ntitle: A\nprompt: hi\nparams:\n  - { id: L, label: L, type: list, default: \"[broken\" }\n",
		"params id 重复":     "id: a\ntitle: A\nprompt: hi\nparams:\n  - { id: X, label: X, type: text }\n  - { id: X, label: X, type: text }\n",
	}
	for name, text := range cases {
		if _, err := Parse([]byte(text), nil); err == nil {
			t.Errorf("%s：应报错", name)
		}
	}
}

func TestValidateBasics(t *testing.T) {
	cases := map[string]string{
		"id 非法":       "id: Bad_ID\ntitle: A\nprompt: hi\n",
		"title 缺失":    "id: a\nprompt: hi\n",
		"color 非法":    "id: a\ntitle: A\ncolor: red\nprompt: hi\n",
		"根不是 mapping": "- a\n- b\n",
		"内容为空":        "",
	}
	for name, text := range cases {
		if _, err := Parse([]byte(text), nil); err == nil {
			t.Errorf("%s：应报错", name)
		}
	}
}

func TestParseValidatesSkillRefs(t *testing.T) {
	skills := map[string]registry.SkillMeta{"demo": {Scope: "project", Dir: "/src/skills/demo"}}
	text := "id: a\ntitle: A\nprompt: hi\nskills: [demo]\n"
	if _, err := Parse([]byte(text), skills); err != nil {
		t.Fatalf("引用存在的 skill 应通过：%v", err)
	}
	_, err := Parse([]byte("id: a\ntitle: A\nprompt: hi\nskills: [ghost]\n"), skills)
	if err == nil || !strings.Contains(err.Error(), `skill "ghost" 不存在`) {
		t.Errorf("引用不存在的 skill 应报错，got %v", err)
	}
	// skills 来源为 nil：不校验
	if _, err := Parse([]byte("id: a\ntitle: A\nprompt: hi\nskills: [ghost]\n"), nil); err != nil {
		t.Errorf("skills 为 nil 时不应校验引用，got %v", err)
	}
}

func TestLoad(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("zeta.yaml", "id: zeta\ntitle: Z\nprompt: z\n")
	write("alpha.yaml", "id: alpha\ntitle: A\nprompt: a\n")
	write("broken.yaml", "id: broken\ntitle: B\n")          // 缺 prompt
	write("dup.yaml", "id: alpha\ntitle: Dup\nprompt: d\n") // 重复 id

	reg := Load(dir, nil)
	if len(reg.Tasks) != 2 {
		t.Fatalf("Tasks = %v want alpha/zeta", reg.Order)
	}
	if strings.Join(reg.Order, ",") != "alpha,zeta" {
		t.Errorf("Order = %v want 字母序", reg.Order)
	}
	if lt, ok := reg.Get("alpha"); !ok || lt.Timeout != DefaultTimeout || !strings.HasSuffix(lt.File, "alpha.yaml") {
		t.Errorf("alpha = %+v", lt)
	}
	if len(reg.Errors) != 2 {
		t.Fatalf("Errors = %v want 2（缺 prompt、重复 id）", reg.Errors)
	}

	// 目录不存在：空集合，不算错误
	if empty := Load(filepath.Join(dir, "nope"), nil); len(empty.Tasks) != 0 || len(empty.Errors) != 0 {
		t.Errorf("目录不存在应返回空集合，got %+v", empty)
	}
}

// TestLoadReportsMissingSkill 锁定加载级校验：引用的 skill 不在扫描结果里，任务不进集合，
// 错误按文件收集。
func TestLoadReportsMissingSkill(t *testing.T) {
	dir := t.TempDir()
	body := []byte("id: a\ntitle: A\nprompt: hi\nskills: [ghost]\n")
	if err := os.WriteFile(filepath.Join(dir, "a.yaml"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	reg := Load(dir, map[string]registry.SkillMeta{})
	if len(reg.Tasks) != 0 || len(reg.Errors) != 1 {
		t.Fatalf("引用缺失 skill 的任务不应加载：tasks=%v errors=%v", reg.Order, reg.Errors)
	}
	if e := reg.Errors[0]; e.File != "a.yaml" || !strings.Contains(e.Error, `skill "ghost" 不存在`) {
		t.Errorf("错误应指向源文件与缺失的 skill，got %+v", e)
	}
}

func TestReservedRunParamsOrder(t *testing.T) {
	if got := ReservedRunParams(); strings.Join(got, ",") != "prompt,system,resume" {
		t.Errorf("ReservedRunParams = %v", got)
	}
	if !IsReservedRunParam("resume") || IsReservedRunParam("promptx") {
		t.Error("IsReservedRunParam 判定不符")
	}
}
