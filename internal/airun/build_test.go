package airun

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"workflow-tool/internal/ai"
	"workflow-tool/internal/registry"
)

// loadTask 解析一份 AI 任务定义，造出 Build 需要的 LoadedTask（不校验 skills 引用）。
func loadTask(t *testing.T, yamlText string) ai.LoadedTask {
	t.Helper()
	task, err := ai.Parse([]byte(yamlText), nil)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	timeout, err := task.TimeoutDuration()
	if err != nil {
		t.Fatalf("timeout: %v", err)
	}
	return ai.LoadedTask{Task: *task, Timeout: timeout}
}

func TestBuildExpandsTemplatesFromInputsAndConfig(t *testing.T) {
	baseDir := t.TempDir()
	workDir := filepath.Join(baseDir, "work")
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		t.Fatal(err)
	}
	lt := loadTask(t, `
id: demo
title: 演示
params:
  - id: CARD_ID
    label: 卡片
    type: text
    required: true
  - id: STATE
    label: 状态
    type: text
    default: 已关闭
system: 角色 ${ROLE}
prompt: |
  处理 ${CARD_ID}，流转到 ${STATE}，目录 ${XDZS_DIR}
cwd: ${WORK_DIR}
env:
  TOKEN: t-${CARD_ID}
`)
	r, err := Build(context.Background(), lt, Deps{BaseDir: baseDir}, Options{
		Params: map[string]any{"CARD_ID": "C1"},
		Global: map[string]string{
			"XDZS_DIR": "/cfg/dir", "WORK_DIR": workDir, "AI_CLI": "claude", "ROLE": "助手",
			"STATE": "已上线", // 定义默认值优先于 config.yaml 的同名值
		},
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	cfg := r.Cfg
	if got := strings.TrimSpace(cfg.Prompt); got != "处理 C1，流转到 已关闭，目录 /cfg/dir" {
		t.Errorf("Prompt = %q", got)
	}
	if cfg.SystemPrompt != "角色 助手" {
		t.Errorf("SystemPrompt = %q", cfg.SystemPrompt)
	}
	if cfg.Cwd != workDir {
		t.Errorf("Cwd = %q want %q", cfg.Cwd, workDir)
	}
	if cfg.Env["TOKEN"] != "t-C1" {
		t.Errorf("Env[TOKEN] = %q", cfg.Env["TOKEN"])
	}
	if cfg.CLI != "claude" {
		t.Errorf("CLI = %q", cfg.CLI)
	}
	if cfg.Timeout != ai.DefaultTimeout {
		t.Errorf("Timeout = %v want %v", cfg.Timeout, ai.DefaultTimeout)
	}
	if cfg.Rules != DefaultRules {
		t.Errorf("没有 ai-rules.md 时应用内置默认守则")
	}
	// 子进程 env 的变量源：config.yaml + 已声明的输入；保留运行参数不在其中
	for key, want := range map[string]string{
		"CARD_ID": "C1", "STATE": "已关闭", "XDZS_DIR": "/cfg/dir", "ROLE": "助手",
	} {
		if got := cfg.Inputs[key]; got != want {
			t.Errorf("Inputs[%s] = %v want %q", key, got, want)
		}
	}
	for _, key := range ai.ReservedRunParams() {
		if _, ok := cfg.Inputs[key]; ok {
			t.Errorf("Inputs 不应包含保留运行参数 %q", key)
		}
	}
}

// TestBuildInputsAreNotPreExpanded 锁定「输入是原样的」：传入值里的 ${OTHER} 不预先展开，
// 模板只展开一次，得到的是字面量 ${OTHER} 而不是 x。
func TestBuildInputsAreNotPreExpanded(t *testing.T) {
	lt := loadTask(t, `
id: demo
title: 演示
prompt: "笔记：${NOTE}"
params:
  - { id: NOTE, label: 笔记, type: text }
  - { id: OTHER, label: 其他, type: text }
`)
	r, err := Build(context.Background(), lt, Deps{BaseDir: t.TempDir()}, Options{
		Params: map[string]any{"NOTE": "${OTHER}", "OTHER": "x"},
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if r.Cfg.Prompt != "笔记：${OTHER}" {
		t.Fatalf("Prompt = %q want %q", r.Cfg.Prompt, "笔记：${OTHER}")
	}
}

// TestBuildDefaultValueIsTemplate 验证定义里的默认值本身也是模板，按 config.yaml 展开。
func TestBuildDefaultValueIsTemplate(t *testing.T) {
	lt := loadTask(t, `
id: demo
title: 演示
prompt: 根目录 ${BASE}
params:
  - { id: BASE, label: 目录, type: text, default: "${ROOT}/sub" }
`)
	r, err := Build(context.Background(), lt, Deps{BaseDir: t.TempDir()}, Options{
		Global: map[string]string{"ROOT": "/r"},
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if r.Cfg.Prompt != "根目录 /r/sub" {
		t.Fatalf("Prompt = %q want %q", r.Cfg.Prompt, "根目录 /r/sub")
	}
}

// TestBuildDefaultExpansionFollowsDeclarationOrder 锁定默认值的展开顺序：靠后的默认值
// 引用靠前的默认值时拿到的是已展开的值。反复构造多次——遍历 map 的旧实现在两个键上
// 每次都有一半概率顺序相反，多跑几轮能把回退暴露出来。
func TestBuildDefaultExpansionFollowsDeclarationOrder(t *testing.T) {
	lt := loadTask(t, `
id: demo
title: 演示
prompt: 输出目录 ${OUT}
params:
  - { id: ROOT, label: 根目录, type: text, default: "${HOME_DIR}/proj" }
  - { id: OUT, label: 输出目录, type: text, default: "${ROOT}/out" }
`)
	const want = "输出目录 /home/me/proj/out"
	for i := 0; i < 32; i++ {
		r, err := Build(context.Background(), lt, Deps{BaseDir: t.TempDir()}, Options{
			Global: map[string]string{"HOME_DIR": "/home/me"},
		})
		if err != nil {
			t.Fatalf("第 %d 次 Build: %v", i, err)
		}
		if r.Cfg.Prompt != want {
			t.Fatalf("第 %d 次：Prompt = %q want %q", i, r.Cfg.Prompt, want)
		}
		if got := r.Cfg.Inputs["OUT"]; got != "/home/me/proj/out" {
			t.Fatalf("第 %d 次：Inputs[OUT] = %v want %q", i, got, "/home/me/proj/out")
		}
	}
}

func TestBuildRejectsUndeclaredParam(t *testing.T) {
	lt := loadTask(t, "id: demo\ntitle: 演示\nprompt: hi\nparams:\n  - { id: CARD_ID, label: 卡片, type: text }\n")
	deps := Deps{BaseDir: t.TempDir()}

	_, err := Build(context.Background(), lt, deps, Options{Params: map[string]any{"CARDD_ID": "1"}})
	if err == nil || !strings.Contains(err.Error(), `未知参数 "CARDD_ID"`) {
		t.Fatalf("未声明的参数应报错，got %v", err)
	}
	// 保留运行参数无需声明即接受
	if _, err := Build(context.Background(), lt, deps, Options{
		Params: map[string]any{"prompt": "hi", "system": "", "resume": "s1"},
	}); err != nil {
		t.Fatalf("保留运行参数不应被拒: %v", err)
	}
}

func TestBuildReservedParamsOverride(t *testing.T) {
	lt := loadTask(t, `
id: demo
title: 演示
prompt: 默认提示 ${CARD_ID}
system: 默认角色
params:
  - { id: CARD_ID, label: 卡片, type: text }
`)
	deps := Deps{BaseDir: t.TempDir()}

	// 未传：用定义里的模板
	r, err := Build(context.Background(), lt, deps, Options{Params: map[string]any{"CARD_ID": "C1"}})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if r.Cfg.Prompt != "默认提示 C1" || r.Cfg.SystemPrompt != "默认角色" || r.Cfg.Resume != "" {
		t.Fatalf("未传保留参数时应使用定义文本：prompt=%q system=%q resume=%q",
			r.Cfg.Prompt, r.Cfg.SystemPrompt, r.Cfg.Resume)
	}

	// 传了：整体替换（传空串也算替换）；替换进来的值同样是模板，照常展开
	r, err = Build(context.Background(), lt, deps, Options{Params: map[string]any{
		"CARD_ID": "C1", "prompt": "替换提示 ${CARD_ID}", "system": "", "resume": " sess-1 ",
	}})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if r.Cfg.Prompt != "替换提示 C1" {
		t.Errorf("Prompt = %q", r.Cfg.Prompt)
	}
	if r.Cfg.SystemPrompt != "" {
		t.Errorf("传空串的 system 应替换成空（只剩守则），got %q", r.Cfg.SystemPrompt)
	}
	if r.Cfg.Resume != "sess-1" {
		t.Errorf("Resume = %q（应去除首尾空白）", r.Cfg.Resume)
	}
}

func TestBuildEmptyPromptFails(t *testing.T) {
	lt := loadTask(t, "id: demo\ntitle: 演示\nprompt: \"\"\n")
	deps := Deps{BaseDir: t.TempDir()}

	_, err := Build(context.Background(), lt, deps, Options{})
	if err == nil || !strings.Contains(err.Error(), "提示词为空") {
		t.Fatalf("定义与输入都没有提示词时应报错，got %v", err)
	}
	// 传入了 prompt 即可运行
	r, err := Build(context.Background(), lt, deps, Options{Params: map[string]any{"prompt": "你好"}})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if r.Cfg.Prompt != "你好" {
		t.Fatalf("Prompt = %q", r.Cfg.Prompt)
	}
}

func TestBuildRequiredParam(t *testing.T) {
	lt := loadTask(t, `
id: demo
title: 演示
prompt: 处理 ${CARD_ID}
params:
  - { id: CARD_ID, label: 卡片, type: text, required: true }
`)
	deps := Deps{BaseDir: t.TempDir()}

	for name, opts := range map[string]Options{
		"未传":   {},
		"传空白值": {Params: map[string]any{"CARD_ID": "  "}},
	} {
		if _, err := Build(context.Background(), lt, deps, opts); err == nil || !strings.Contains(err.Error(), `缺少必填参数 "CARD_ID"`) {
			t.Errorf("%s：应报缺少必填参数，got %v", name, err)
		}
	}
	// 没有默认值时取 config.yaml 的同名值，必填随之满足
	r, err := Build(context.Background(), lt, deps, Options{Global: map[string]string{"CARD_ID": "from-config"}})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if r.Cfg.Prompt != "处理 from-config" {
		t.Fatalf("Prompt = %q", r.Cfg.Prompt)
	}
}

func TestBuildRulesSource(t *testing.T) {
	lt := loadTask(t, "id: demo\ntitle: 演示\nprompt: hi\n")
	for name, tc := range map[string]struct {
		content string
		want    string
	}{
		"文件不存在": {want: DefaultRules},
		"文件为空白": {content: "  \n\t\n", want: DefaultRules},
		"文件有内容": {content: "# 自定义守则\n- 条款 A\n", want: "# 自定义守则\n- 条款 A\n"},
	} {
		baseDir := t.TempDir()
		if tc.content != "" {
			if err := os.WriteFile(filepath.Join(baseDir, RulesFileName), []byte(tc.content), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		r, err := Build(context.Background(), lt, Deps{BaseDir: baseDir}, Options{})
		if err != nil {
			t.Fatalf("%s：Build: %v", name, err)
		}
		if r.Cfg.Rules != tc.want {
			t.Errorf("%s：Rules = %q want %q", name, r.Cfg.Rules, tc.want)
		}
	}
}

func TestBuildCwd(t *testing.T) {
	baseDir := t.TempDir()
	deps := Deps{BaseDir: baseDir}

	// 未写 cwd：兜底为应用目录
	r, err := Build(context.Background(), loadTask(t, "id: demo\ntitle: 演示\nprompt: hi\n"), deps, Options{})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if r.Cfg.Cwd != baseDir {
		t.Errorf("Cwd = %q want %q", r.Cfg.Cwd, baseDir)
	}

	// 展开后指向不存在的目录：报错
	missing := filepath.Join(baseDir, "missing")
	_, err = Build(context.Background(), loadTask(t, "id: demo\ntitle: 演示\nprompt: hi\ncwd: "+missing), deps, Options{})
	if err == nil || !strings.Contains(err.Error(), "工作目录不存在") {
		t.Fatalf("cwd 不存在应报错，got %v", err)
	}
}

func TestBuildSyncsSkills(t *testing.T) {
	baseDir := t.TempDir()
	src := filepath.Join(t.TempDir(), "skills", "demo")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "SKILL.md"), []byte("# demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	router, _ := newTestRouter(t, map[string]registry.SkillMeta{"demo": {Scope: "project", Dir: src}})
	lt := loadTask(t, "id: demo\ntitle: 演示\nprompt: hi\nskills: [demo]\n")

	r, err := Build(context.Background(), lt, Deps{BaseDir: baseDir, SkillRouter: router}, Options{})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	// 同步目标是 agent cwd（此处兜底为应用目录）下的 .claude/skills/demo
	data, err := os.ReadFile(filepath.Join(baseDir, ".claude", "skills", "demo", "SKILL.md"))
	if err != nil || string(data) != "# demo\n" {
		t.Fatalf("skill 未同步到目标目录：data=%q err=%v", data, err)
	}
	if len(r.Cfg.SkillSyncReport) != 1 {
		t.Errorf("SkillSyncReport = %v", r.Cfg.SkillSyncReport)
	}

	// 声明了 skills 却没有 router：报错
	if _, err := Build(context.Background(), lt, Deps{BaseDir: baseDir}, Options{}); err == nil {
		t.Fatal("SkillRouter 未注入时应报错")
	}
}

// TestBuildThenRun 端到端：Build 的产物可直接运行，回复落在 Result.Stdout。
func TestBuildThenRun(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix 专属 shell 行为")
	}
	dir := t.TempDir()
	cli := filepath.Join(dir, "fake-ai.sh")
	script := "#!/bin/sh\ncat > /dev/null\n" +
		`printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"完成"}]}}'` + "\n"
	if err := os.WriteFile(cli, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	lt := loadTask(t, "id: demo\ntitle: 演示\nprompt: hi\ntimeout: 5s\n")
	r, err := Build(context.Background(), lt, Deps{BaseDir: dir}, Options{
		Global: map[string]string{"AI_CLI": cli},
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if r.Cfg.Timeout != 5*time.Second {
		t.Errorf("Timeout = %v want 5s", r.Cfg.Timeout)
	}
	res := r.Run(context.Background(), nil, func(string, string) {})
	if res.Err != nil {
		t.Fatalf("Run: %v", res.Err)
	}
	if res.Stdout != "完成" {
		t.Fatalf("Stdout = %q want %q", res.Stdout, "完成")
	}
}
