package airun

import (
	"context"
	"errors"
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

// piGlobal 造一份能过 pi 初始化的 config 快照：三键齐全，AI_PI_BIN 指向 baseDir 下
// 新建的假 pi 脚本（Build 只解析不执行，存在即可）。script 为空用哑脚本（吸干 stdin）。
// Windows 上无 sh，AI_PI_BIN 指向测试二进制自身（同样是「存在的可执行文件」）。
func piGlobal(t *testing.T, baseDir, script string) map[string]string {
	t.Helper()
	bin := filepath.Join(baseDir, "fake-pi.sh")
	if runtime.GOOS == "windows" {
		exe, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		bin = exe
	} else {
		if script == "" {
			script = "#!/bin/sh\ncat > /dev/null\n"
		}
		if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return map[string]string{
		"AI_BASE_URL": "http://oneapi.example/v1",
		"AI_AUTH_KEY": "k-test",
		"AI_MODEL":    "M-TEST",
		"AI_PI_BIN":   bin,
	}
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
	global := piGlobal(t, baseDir, "")
	global["XDZS_DIR"] = "/cfg/dir"
	global["WORK_DIR"] = workDir
	global["ROLE"] = "助手"
	global["STATE"] = "已上线" // 定义默认值优先于 config.yaml 的同名值
	r, err := Build(context.Background(), lt, Deps{BaseDir: baseDir}, Options{
		Params: map[string]any{"CARD_ID": "C1"},
		Global: global,
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
	if cfg.Timeout != ai.DefaultTimeout {
		t.Errorf("Timeout = %v want %v", cfg.Timeout, ai.DefaultTimeout)
	}
	if cfg.Rules != DefaultRules {
		t.Errorf("没有 ai-rules.md 时应用内置默认守则")
	}
	// pi 初始化的终值字段：Build 解析好直接进 cfg，runner 不再探测
	if cfg.PiBin != global["AI_PI_BIN"] {
		t.Errorf("PiBin = %q want %q", cfg.PiBin, global["AI_PI_BIN"])
	}
	if cfg.Model != "M-TEST" {
		t.Errorf("Model = %q", cfg.Model)
	}
	if cfg.AgentDir != filepath.Join(baseDir, "pi-agent") || cfg.SessionDir != filepath.Join(baseDir, "pi-sessions") {
		t.Errorf("hermetic 目录 = %q / %q", cfg.AgentDir, cfg.SessionDir)
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
		Global: piGlobal(t, t.TempDir(), ""),
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
	global := piGlobal(t, t.TempDir(), "")
	global["ROOT"] = "/r"
	r, err := Build(context.Background(), lt, Deps{BaseDir: t.TempDir()}, Options{Global: global})
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
	global := piGlobal(t, t.TempDir(), "")
	global["HOME_DIR"] = "/home/me"
	const want = "输出目录 /home/me/proj/out"
	for i := 0; i < 32; i++ {
		r, err := Build(context.Background(), lt, Deps{BaseDir: t.TempDir()}, Options{Global: global})
		if err != nil {
			t.Fatalf("第 %d 次 Build: %v", i, err)
		}
		if r.Cfg.Prompt != want {
			t.Fatalf("第 %d 次：Prompt = %q", i, r.Cfg.Prompt)
		}
		if got := r.Cfg.Inputs["OUT"]; got != "/home/me/proj/out" {
			t.Fatalf("第 %d 次：Inputs[OUT] = %v", i, got)
		}
	}
}

func TestBuildRejectsUndeclaredParam(t *testing.T) {
	lt := loadTask(t, "id: demo\ntitle: 演示\nprompt: hi\nparams:\n  - { id: CARD_ID, label: 卡片, type: text }\n")
	deps := Deps{BaseDir: t.TempDir()}
	global := piGlobal(t, t.TempDir(), "")

	_, err := Build(context.Background(), lt, deps, Options{Params: map[string]any{"CARDD_ID": "1"}, Global: global})
	if err == nil || !strings.Contains(err.Error(), `未知参数 "CARDD_ID"`) {
		t.Fatalf("未声明的参数应报错，got %v", err)
	}
	// 保留运行参数无需声明即接受
	if _, err := Build(context.Background(), lt, deps, Options{
		Params: map[string]any{"prompt": "hi", "system": "", "resume": "s1"},
		Global: global,
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
	global := piGlobal(t, t.TempDir(), "")

	// 未传：用定义里的模板
	r, err := Build(context.Background(), lt, deps, Options{Params: map[string]any{"CARD_ID": "C1"}, Global: global})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if r.Cfg.Prompt != "默认提示 C1" || r.Cfg.SystemPrompt != "默认角色" || r.Cfg.Resume != "" {
		t.Fatalf("未传保留参数时应使用定义文本：prompt=%q system=%q resume=%q",
			r.Cfg.Prompt, r.Cfg.SystemPrompt, r.Cfg.Resume)
	}

	// 传了：整体替换（传空串也算替换）；替换进来的值同样是模板，照常展开
	r, err = Build(context.Background(), lt, deps, Options{
		Global: global,
		Params: map[string]any{
			"CARD_ID": "C1", "prompt": "替换提示 ${CARD_ID}", "system": "", "resume": " sess-1 ",
		},
	})
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

	// 提示词为空的校验先于 pi 初始化：无需 pi 三键
	_, err := Build(context.Background(), lt, deps, Options{})
	if err == nil || !strings.Contains(err.Error(), "提示词为空") {
		t.Fatalf("定义与输入都没有提示词时应报错，got %v", err)
	}
	// 传入了 prompt 即可运行
	r, err := Build(context.Background(), lt, deps, Options{
		Params: map[string]any{"prompt": "你好"},
		Global: piGlobal(t, t.TempDir(), ""),
	})
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

	// 必填校验先于 pi 初始化：无需 pi 三键
	for name, opts := range map[string]Options{
		"未传":   {},
		"传空白值": {Params: map[string]any{"CARD_ID": "  "}},
	} {
		if _, err := Build(context.Background(), lt, deps, opts); err == nil || !strings.Contains(err.Error(), `缺少必填参数 "CARD_ID"`) {
			t.Errorf("%s：应报缺少必填参数，got %v", name, err)
		}
	}
	// 没有默认值时取 config.yaml 的同名值，必填随之满足
	global := piGlobal(t, t.TempDir(), "")
	global["CARD_ID"] = "from-config"
	r, err := Build(context.Background(), lt, deps, Options{Global: global})
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
		r, err := Build(context.Background(), lt, Deps{BaseDir: baseDir}, Options{Global: piGlobal(t, baseDir, "")})
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
	r, err := Build(context.Background(), loadTask(t, "id: demo\ntitle: 演示\nprompt: hi\n"), deps,
		Options{Global: piGlobal(t, baseDir, "")})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if r.Cfg.Cwd != baseDir {
		t.Errorf("Cwd = %q want %q", r.Cfg.Cwd, baseDir)
	}

	// 展开后指向不存在的目录：报错（校验先于 pi 初始化，无需 pi 三键）
	missing := filepath.Join(baseDir, "missing")
	_, err = Build(context.Background(), loadTask(t, "id: demo\ntitle: 演示\nprompt: hi\ncwd: "+missing), deps, Options{})
	if err == nil || !strings.Contains(err.Error(), "工作目录不存在") {
		t.Fatalf("cwd 不存在应报错，got %v", err)
	}
}

// TestBuildMissingPIKeysFails 三键缺任一在 Build 阶段早失败（pi_setup）。
func TestBuildMissingPIKeysFails(t *testing.T) {
	lt := loadTask(t, "id: demo\ntitle: 演示\nprompt: hi\n")

	// 什么都没配：pi 可执行先解析失败
	if _, err := Build(context.Background(), lt, Deps{BaseDir: t.TempDir()}, Options{}); err == nil ||
		!strings.Contains(err.Error(), "pi") {
		t.Fatalf("无 pi 可执行应早失败, got %v", err)
	}
	// 有 pi 但缺 AI_MODEL：三键校验失败
	global := piGlobal(t, t.TempDir(), "")
	delete(global, "AI_MODEL")
	if _, err := Build(context.Background(), lt, Deps{BaseDir: t.TempDir()}, Options{Global: global}); err == nil ||
		!strings.Contains(err.Error(), "AI_MODEL") {
		t.Fatalf("缺 AI_MODEL 应早失败, got %v", err)
	}
}

// TestBuildSecretKeySkipsVars 密钥防泄漏（设计 §4）：AI_AUTH_KEY 不进模板 vars 层，
// 模板里写 ${AI_AUTH_KEY} 保留字面量（Expand 未命中记 warning）；子进程 env 不
// 黑名单——cfg.Inputs 仍带它，pi 侧由 models.json 的插值在请求时解析。
func TestBuildSecretKeySkipsVars(t *testing.T) {
	baseDir := t.TempDir()
	lt := loadTask(t, "id: demo\ntitle: 演示\nprompt: 密钥 ${AI_AUTH_KEY}\n")
	r, err := Build(context.Background(), lt, Deps{BaseDir: baseDir}, Options{Global: piGlobal(t, baseDir, "")})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if r.Cfg.Prompt != "密钥 ${AI_AUTH_KEY}" {
		t.Fatalf("Prompt = %q，${AI_AUTH_KEY} 应保留字面量", r.Cfg.Prompt)
	}
	if r.Cfg.Inputs["AI_AUTH_KEY"] != "k-test" {
		t.Fatalf("子进程 env 应保留 AI_AUTH_KEY（models.json 插值用）, got %v", r.Cfg.Inputs["AI_AUTH_KEY"])
	}
	// 密钥同样不进 models.json：磁盘上只有插值字面量
	raw, err := os.ReadFile(filepath.Join(baseDir, "pi-agent", "models.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "k-test") || !strings.Contains(string(raw), "${AI_AUTH_KEY}") {
		t.Fatalf("models.json 密钥处理不符: %s", raw)
	}
}

// TestBuildLegacyAICLIWarns config.yaml 残留 AI_CLI：Build 成功，警告一行进
// BuildWarnings（Run 开头最先经 stderr emit）。三键经 AgentConfig 提供、config.yaml
// 不残留三键——本用例只关心 AI_CLI 这一条。
func TestBuildLegacyAICLIWarns(t *testing.T) {
	baseDir := t.TempDir()
	global := piGlobal(t, baseDir, "")
	auth := map[string]string{
		"AI_BASE_URL": global["AI_BASE_URL"],
		"AI_AUTH_KEY": global["AI_AUTH_KEY"],
		"AI_MODEL":    global["AI_MODEL"],
	}
	delete(global, cfgKeyBaseURL)
	delete(global, cfgKeyAuthKey)
	delete(global, cfgKeyModel)
	global["AI_CLI"] = "claude" // 旧键残留
	r, err := Build(context.Background(), loadTask(t, "id: demo\ntitle: 演示\nprompt: hi\n"),
		Deps{BaseDir: baseDir, AgentConfig: func() (map[string]string, error) {
			return auth, nil
		}}, Options{Global: global})
	if err != nil {
		t.Fatalf("AI_CLI 残留不应使 Build 失败: %v", err)
	}
	if len(r.Cfg.BuildWarnings) != 1 || !strings.Contains(r.Cfg.BuildWarnings[0], "AI_CLI") {
		t.Fatalf("AI_CLI 残留应恰有一条警告: %v", r.Cfg.BuildWarnings)
	}
}

// TestBuildAuthOverridesGlobal auth 合并层：auth.json 非空三键覆盖 config.yaml 同名键
// （模板 vars、models.json、子进程 env 全用合并值），AI_PI_BIN 等其余键不受影响。
func TestBuildAuthOverridesGlobal(t *testing.T) {
	baseDir := t.TempDir()
	lt := loadTask(t, "id: demo\ntitle: 演示\nprompt: 模型 ${AI_MODEL}\n")
	global := piGlobal(t, baseDir, "") // 三键 + AI_PI_BIN 都在 config.yaml
	auth := map[string]string{
		"AI_BASE_URL": "http://auth.example/v1",
		"AI_AUTH_KEY": "k-auth",
		"AI_MODEL":    "M-AUTH",
	}
	r, err := Build(context.Background(), lt, Deps{BaseDir: baseDir, AgentConfig: func() (map[string]string, error) {
		return auth, nil
	}}, Options{Global: global})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if r.Cfg.Model != "M-AUTH" {
		t.Errorf("Model = %q want M-AUTH（auth 覆盖 config）", r.Cfg.Model)
	}
	if r.Cfg.Prompt != "模型 M-AUTH" {
		t.Errorf("Prompt = %q（模板应展开合并后的 AI_MODEL）", r.Cfg.Prompt)
	}
	if r.Cfg.PiBin != global["AI_PI_BIN"] {
		t.Errorf("PiBin = %q（AI_PI_BIN 不迁移，仍取 config）", r.Cfg.PiBin)
	}
	for key, want := range map[string]string{
		"AI_AUTH_KEY": "k-auth", "AI_BASE_URL": "http://auth.example/v1", "AI_MODEL": "M-AUTH",
	} {
		if got := r.Cfg.Inputs[key]; got != want {
			t.Errorf("Inputs[%s] = %v want %q（子进程 env 用合并值）", key, got, want)
		}
	}
	// models.json 用 auth 的 baseURL，密钥仍只留插值字面量
	raw, err := os.ReadFile(filepath.Join(baseDir, "pi-agent", "models.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "http://auth.example/v1") || strings.Contains(string(raw), "k-auth") {
		t.Errorf("models.json 应取 auth 的 baseURL 且密钥不落盘: %s", raw)
	}
}

// TestBuildAuthSuppliesKeysWhenGlobalLacksThem 三键只在 auth.json：三键校验照常
// 通过（config.yaml 缺键不再必然失败），且无残留时不产生迁移警告。
func TestBuildAuthSuppliesKeysWhenGlobalLacksThem(t *testing.T) {
	baseDir := t.TempDir()
	global := piGlobal(t, baseDir, "")
	delete(global, cfgKeyBaseURL)
	delete(global, cfgKeyAuthKey)
	delete(global, cfgKeyModel) // 只剩 AI_PI_BIN
	r, err := Build(context.Background(), loadTask(t, "id: demo\ntitle: 演示\nprompt: hi\n"),
		Deps{BaseDir: baseDir, AgentConfig: func() (map[string]string, error) {
			return map[string]string{
				"AI_BASE_URL": "http://auth.example/v1",
				"AI_AUTH_KEY": "k-auth",
				"AI_MODEL":    "M-AUTH",
			}, nil
		}}, Options{Global: global})
	if err != nil {
		t.Fatalf("三键由 auth 提供时 Build 不应失败: %v", err)
	}
	if r.Cfg.Model != "M-AUTH" {
		t.Errorf("Model = %q want M-AUTH", r.Cfg.Model)
	}
	if len(r.Cfg.BuildWarnings) != 0 {
		t.Errorf("config.yaml 无三键残留时不应有迁移警告: %v", r.Cfg.BuildWarnings)
	}
}

// TestBuildAuthBlankValueFallsBackToConfig auth 里某键为空白：视作未配置，回落
// config.yaml 同名键（Settings 清空一格不至于废掉整个回退层）。
func TestBuildAuthBlankValueFallsBackToConfig(t *testing.T) {
	baseDir := t.TempDir()
	global := piGlobal(t, baseDir, "")
	r, err := Build(context.Background(), loadTask(t, "id: demo\ntitle: 演示\nprompt: hi\n"),
		Deps{BaseDir: baseDir, AgentConfig: func() (map[string]string, error) {
			return map[string]string{"AI_MODEL": "  "}, nil
		}}, Options{Global: global})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if r.Cfg.Model != "M-TEST" {
		t.Errorf("Model = %q want M-TEST（空白 auth 值回落 config）", r.Cfg.Model)
	}
}

// TestBuildAuthReadErrorFailsEarly auth.json 读失败（损坏等）：Build 早失败并保留
// 原始错误，不静默回落 config.yaml——密钥文件损坏必须被看见。
func TestBuildAuthReadErrorFailsEarly(t *testing.T) {
	deps := Deps{BaseDir: t.TempDir(), AgentConfig: func() (map[string]string, error) {
		return nil, errors.New("auth.json 损坏")
	}}
	_, err := Build(context.Background(), loadTask(t, "id: demo\ntitle: 演示\nprompt: hi\n"), deps,
		Options{Global: piGlobal(t, t.TempDir(), "")})
	if err == nil || !strings.Contains(err.Error(), "auth.json 损坏") {
		t.Fatalf("auth 读失败应早失败并带原错误, got %v", err)
	}
}

// TestBuildGlobalAgentKeysResidualWarns config.yaml 残留三键：Build 仍成功（auth
// 覆盖后或直接回退生效），BuildWarnings 恰一条迁移提示（对齐 AI_CLI 残留警告模式）。
func TestBuildGlobalAgentKeysResidualWarns(t *testing.T) {
	baseDir := t.TempDir()
	global := piGlobal(t, baseDir, "") // 三键全在 config.yaml
	r, err := Build(context.Background(), loadTask(t, "id: demo\ntitle: 演示\nprompt: hi\n"),
		Deps{BaseDir: baseDir}, Options{Global: global})
	if err != nil {
		t.Fatalf("残留三键仍是有效回退，Build 不应失败: %v", err)
	}
	if len(r.Cfg.BuildWarnings) != 1 || !strings.Contains(r.Cfg.BuildWarnings[0], "AI_AUTH_KEY") ||
		!strings.Contains(r.Cfg.BuildWarnings[0], "auth.json") {
		t.Fatalf("三键残留应恰一条迁移警告: %v", r.Cfg.BuildWarnings)
	}
}

// TestBuildSkillsZeroCopy skills 零拷贝（设计 §5）：绑定 ids 解析为源目录直传，
// 不向任何地方复制文件，报告行改走 SkillReport。
func TestBuildSkillsZeroCopy(t *testing.T) {
	baseDir := t.TempDir()
	src := filepath.Join(t.TempDir(), "skills", "demo")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "SKILL.md"), []byte("# demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	resolve := SkillDirResolver(func() map[string]registry.SkillMeta {
		return map[string]registry.SkillMeta{"demo": {Scope: "project", Dir: src}}
	})
	lt := loadTask(t, "id: demo\ntitle: 演示\nprompt: hi\nskills: [demo]\n")

	r, err := Build(context.Background(), lt, Deps{BaseDir: baseDir, SkillDirs: resolve},
		Options{Global: piGlobal(t, baseDir, "")})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if len(r.Cfg.SkillDirs) != 1 || r.Cfg.SkillDirs[0] != src {
		t.Fatalf("SkillDirs = %v want [%s]", r.Cfg.SkillDirs, src)
	}
	if len(r.Cfg.SkillReport) != 1 || !strings.Contains(r.Cfg.SkillReport[0], "零拷贝直传") ||
		!strings.Contains(r.Cfg.SkillReport[0], "demo") {
		t.Fatalf("SkillReport = %v", r.Cfg.SkillReport)
	}
	// 零拷贝：应用目录（agent cwd 兜底值）下没有复制目标，也不再写账本
	if _, err := os.Stat(filepath.Join(baseDir, ".claude")); !os.IsNotExist(err) {
		t.Fatalf("零拷贝不应创建 .claude: %v", err)
	}
	if _, err := os.Stat(filepath.Join(baseDir, "skills.synced.json")); !os.IsNotExist(err) {
		t.Fatalf("不应写 skills.synced.json: %v", err)
	}

	// 声明了 skills 却没有 SkillDirs：报错
	if _, err := Build(context.Background(), lt, Deps{BaseDir: baseDir},
		Options{Global: piGlobal(t, baseDir, "")}); err == nil {
		t.Fatal("SkillDirs 未注入时应报错")
	}
}

// TestBuildThenRun 端到端：Build 的产物（含 pi 初始化）可直接运行，回复落在
// Result.Stdout。
func TestBuildThenRun(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix 专属 shell 行为")
	}
	dir := t.TempDir()
	script := "#!/bin/sh\ncat > /dev/null\n" +
		`printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"完成"}],"stopReason":"stop"}}'` + "\n"
	lt := loadTask(t, "id: demo\ntitle: 演示\nprompt: hi\ntimeout: 5s\n")
	r, err := Build(context.Background(), lt, Deps{BaseDir: dir}, Options{Global: piGlobal(t, dir, script)})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if r.Cfg.Timeout != 5*time.Second {
		t.Errorf("Timeout = %v want 5s", r.Cfg.Timeout)
	}
	if _, err := os.Stat(filepath.Join(dir, "pi-agent", "models.json")); err != nil {
		t.Fatalf("models.json 未写入 agent 目录: %v", err)
	}
	res := r.Run(context.Background(), nil, func(string, string) {})
	if res.Err != nil {
		t.Fatalf("Run: %v", res.Err)
	}
	if res.Stdout != "完成" {
		t.Fatalf("Stdout = %q want %q", res.Stdout, "完成")
	}
}
