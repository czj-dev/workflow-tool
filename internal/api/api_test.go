package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"workflow-tool/internal/registry"
	"workflow-tool/internal/workflow"
)

// newWorkflowSvc 建一个只含 workflows 目录的 service，写入给定 yaml 内容。
func newWorkflowSvc(t *testing.T, yamlText string) (*Service, string) {
	t.Helper()
	dir := t.TempDir()
	wd := filepath.Join(dir, "workflows")
	if err := os.Mkdir(wd, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wd, "w.yaml"), []byte(yamlText), 0644); err != nil {
		t.Fatal(err)
	}
	ad := filepath.Join(dir, "actions")
	os.Mkdir(ad, 0755)
	svc := New(registry.Load(ad, dir), workflow.Load(wd), dir,
		filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
	return svc, dir
}

func TestListWorkflowsIncludesParamsAndSteps(t *testing.T) {
	svc, _ := newWorkflowSvc(t, `id: w
title: W
params:
  - id: TARGET
    label: 目标
    type: select
    options: [a, b]
steps:
  - action: some-action
  - sleep: 5
  - shell: echo hi
`)
	res := svc.ListWorkflows()
	if len(res.Workflows) != 1 {
		t.Fatalf("期望 1 个 workflow，got %d（errors=%v）", len(res.Workflows), res.Errors)
	}
	w := res.Workflows[0]
	if len(w.Params) != 1 || w.Params[0].ID != "TARGET" {
		t.Fatalf("params 未带回：%+v", w.Params)
	}
	want := []WorkflowStepInfo{
		{Kind: "action", Label: "some-action"},
		{Kind: "sleep", Label: "5s"},
		{Kind: "shell", Label: "echo hi"},
	}
	if len(w.Steps) != len(want) {
		t.Fatalf("steps 数量不符：%+v", w.Steps)
	}
	for i, e := range want {
		if w.Steps[i] != e {
			t.Fatalf("steps[%d] = %+v，期望 %+v", i, w.Steps[i], e)
		}
	}
}

func TestGetWorkflowYamlReturnsRawWithComments(t *testing.T) {
	svc, _ := newWorkflowSvc(t, "# 注释\nid: w\ntitle: W\nsteps:\n  - sleep: 1\n")
	got, err := svc.GetWorkflowYaml("w")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "# 注释") {
		t.Fatalf("应保留注释原文，got %q", got)
	}
}

func TestSetWorkflowYamlValidWritesAndReloads(t *testing.T) {
	svc, _ := newWorkflowSvc(t, "id: w\ntitle: W\nsteps:\n  - sleep: 1\n")
	res, err := svc.SetWorkflowYaml("w", "id: w\ntitle: 改名\nsteps:\n  - sleep: 2\n")
	if err != nil {
		t.Fatal(err)
	}
	if res.Workflows[0].Title != "改名" {
		t.Fatalf("重载后应见新标题，got %+v", res.Workflows[0])
	}
	persisted, _ := svc.GetWorkflowYaml("w")
	if !strings.Contains(persisted, "改名") {
		t.Fatalf("应落盘，got %q", persisted)
	}
}

func TestSetWorkflowYamlRejectsBadInput(t *testing.T) {
	orig := "id: w\ntitle: W\nsteps:\n  - sleep: 1\n"
	cases := map[string]string{
		"非法 yaml":   "id: w\n  : : :\n",
		"校验失败（无 steps）": "id: w\ntitle: W\n",
		"改 id":      "id: other\ntitle: W\nsteps:\n  - sleep: 1\n",
	}
	for name, text := range cases {
		t.Run(name, func(t *testing.T) {
			svc, _ := newWorkflowSvc(t, orig)
			if _, err := svc.SetWorkflowYaml("w", text); err == nil {
				t.Fatal("应报错")
			}
			got, _ := svc.GetWorkflowYaml("w")
			if got != orig {
				t.Fatalf("被拒时不该写盘，got %q", got)
			}
		})
	}
}

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

func TestLLMReadoutIncludesSessionID(t *testing.T) {
	outputs := map[string]string{
		"session_id":    "abc-123",
		"cost_usd":      "0.02",
		"input_tokens":  "10",
		"output_tokens": "20",
	}
	r := llmReadout(outputs, 3_500_000_000)
	if r["sessionId"] != "abc-123" {
		t.Fatalf("sessionId 未透传: %+v", r)
	}
	if r["durationMs"] != int64(3500) {
		t.Fatalf("durationMs 不符: %+v", r)
	}
	// 无 cost/tokens 时仍应为 nil（sessionId 单独不撑起 readout，保持旧语义）
	if got := llmReadout(map[string]string{"session_id": "abc"}, 0); got != nil {
		t.Fatalf("无成本字段应返回 nil，got %+v", got)
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
  stream: logcat
`), 0644)

	svc := New(registry.Load(dir, dir), nil, dir, cfgPath, filepath.Join(dir, "fragments.yaml"))
	res := svc.ListActions()
	if len(res.Actions) != 1 {
		t.Fatalf("want 1 action, got %d", len(res.Actions))
	}
	if res.Actions[0].Stream != "logcat" {
		t.Fatalf("ListActions 未带回 stream: %+v", res.Actions[0].Stream)
	}
}

// TestListActionsIncludesLLMInfo 验证 command.llm 形态动作在 ListActions 里带回 LLMInfo，
// 供前端切 LlmForm 主次布局 + LlmView 流式视图。
func TestListActionsIncludesLLMInfo(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	os.WriteFile(filepath.Join(dir, "a.yaml"), []byte(`id: a
title: A
params:
  - { id: ROLE, label: 角色, type: textarea }
  - { id: Q, label: 问题, type: textarea, required: true }
  - { id: SID, label: 会话, type: text }
command:
  llm:
    system: ROLE
    prompt: Q
    resume: SID
`), 0644)

	svc := New(registry.Load(dir, dir), nil, dir, cfgPath, filepath.Join(dir, "fragments.yaml"))
	res := svc.ListActions()
	if len(res.Actions) != 1 {
		t.Fatalf("want 1 action, got %d", len(res.Actions))
	}
	llm := res.Actions[0].LLM
	if llm == nil {
		t.Fatal("LLM 形态动作应带回 LLMInfo，got nil")
	}
	if llm.SystemParam != "ROLE" || llm.PromptParam != "Q" || llm.ResumeParam != "SID" {
		t.Fatalf("LLMInfo = %+v，want system=ROLE prompt=Q resume=SID", llm)
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
		t.Fatal("改 id 应被拒")
	}
	got, _ := svc.GetActionYaml("a")
	if got != orig {
		t.Fatalf("改 id 被拒不该写盘，got %q", got)
	}
}

// TestGetVarReferenceCountsCoversWorkflowFields 校验 workflow 中 ${VAR} 引用被正确统计：
// step.shell、step.params、step.env、workflow.env 都会经 runner.Expand 展开，必须计入引用计数。
// 复现场景：xdzs-debug-chain 的 find-apk step.shell 引用 VOICE_DEBUG_OUTPUT 却未被计数。
func TestGetVarReferenceCountsCoversWorkflowFields(t *testing.T) {
	svc, _ := newWorkflowSvc(t, `id: chain
title: Chain
env:
  WF_ENV: "${WF_ENV_VAR}"
steps:
  - id: find-apk
    name: 定位 APK
    shell: |
      APK=$(find "${VOICE_DEBUG_OUTPUT}" -maxdepth 1 -name "*.apk" | head -1)
  - id: install
    action: adb-install
    env:
      STEP_ENV: "${STEP_ENV_VAR}"
    params:
      APK_PATH: "${APK_PATH_VAR}"
`)
	counts := svc.GetVarReferenceCounts()
	for _, name := range []string{"VOICE_DEBUG_OUTPUT", "WF_ENV_VAR", "STEP_ENV_VAR", "APK_PATH_VAR"} {
		if counts[name] < 1 {
			t.Errorf("变量 %q 应被 workflow 引用计数 ≥1，got %d（counts=%+v）", name, counts[name], counts)
		}
	}
	// ${{ }} 表达式引用的是 step outputs，不是全局变量，不应被计入
	if _, hit := counts["steps"]; hit {
		t.Errorf("${{ }} 表达式不应被计入全局变量引用: %+v", counts)
	}
}

// TestBuildActionRunParamsExpandsSelfRef 校验 step.params 里 { PACKAGE: "${PACKAGE}" }
// 能正确展开为 merged 的真实值，而不是自引用后原样保留。
// 复现 adb-clean-reinstall 第一步 force-stop 收到空包名（am force-stop 无参数）的 bug。
func TestBuildActionRunParamsExpandsSelfRef(t *testing.T) {
	merged := map[string]any{"PACKAGE": "com.baidu.che.codriver", "ADB_SERIAL": "S1"}
	stepParams := map[string]any{"PACKAGE": "${PACKAGE}"}
	runParams, _ := buildActionRunParams(merged, nil, stepParams)
	if runParams["PACKAGE"] != "com.baidu.che.codriver" {
		t.Fatalf("${PACKAGE} 应展开为真实包名，got %v", runParams["PACKAGE"])
	}
}

// step.params 的 ${VAR} 可引用 merged 中任意变量（如 ADB_SERIAL）。
func TestBuildActionRunParamsExpandsOtherVars(t *testing.T) {
	merged := map[string]any{"PACKAGE": "com.baidu.che.codriver", "OUTPUT_DIR": "/tmp/out"}
	stepParams := map[string]any{"OUTPUT_PATH": "${OUTPUT_DIR}", "PACKAGE": "${PACKAGE}"}
	runParams, _ := buildActionRunParams(merged, nil, stepParams)
	if runParams["OUTPUT_PATH"] != "/tmp/out" {
		t.Fatalf("${OUTPUT_DIR} 应展开，got %v", runParams["OUTPUT_PATH"])
	}
	if runParams["PACKAGE"] != "com.baidu.che.codriver" {
		t.Fatalf("${PACKAGE} 应展开，got %v", runParams["PACKAGE"])
	}
}

// env 的 ${VAR} 也用 merged 展开，结果供 ShellRunner 使用。
func TestBuildActionRunParamsExpandsEnv(t *testing.T) {
	merged := map[string]any{"ROOT": "/data"}
	env := map[string]string{"DATA": "${ROOT}/files"}
	_, expandedEnv := buildActionRunParams(merged, env, nil)
	if expandedEnv["DATA"] != "/data/files" {
		t.Fatalf("env 的 ${ROOT} 应展开，got %v", expandedEnv["DATA"])
	}
}

// 非字符串 step.param（如 bool）保持原类型。
func TestBuildActionRunParamsKeepsNonString(t *testing.T) {
	merged := map[string]any{"PACKAGE": "p"}
	stepParams := map[string]any{"PACKAGE": "${PACKAGE}", "ALLOW_TEST": true}
	runParams, _ := buildActionRunParams(merged, nil, stepParams)
	if b, ok := runParams["ALLOW_TEST"].(bool); !ok || !b {
		t.Fatalf("bool 应保持原类型，got %v", runParams["ALLOW_TEST"])
	}
}

// TestGetVarReferenceCountsDedupesWithinField 校验同一字段内重复引用只计一次。
func TestGetVarReferenceCountsDedupesWithinField(t *testing.T) {
	svc, _ := newWorkflowSvc(t, "id: w\ntitle: W\nsteps:\n  - shell: \"echo ${DUP} ${DUP}\"\n")
	if c := svc.GetVarReferenceCounts()["DUP"]; c != 1 {
		t.Fatalf("同字段内重复引用应只计一次，got %d", c)
	}
}
