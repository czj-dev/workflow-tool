package actionrun

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/builtinvars"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
)

// mustBuild 是 Build 的测试包装：Build 签名改 (Runner, error) 后，
// 期望成功的既有用例统一经此断言 err == nil，保持调用点单值接收的简洁。
func mustBuild(t *testing.T, ctx context.Context, la registry.LoadedAction, deps Deps, opts Options) runner.Runner {
	t.Helper()
	r, err := Build(ctx, la, deps, opts)
	if err != nil {
		t.Fatalf("Build 不应失败: %v", err)
	}
	return r
}

func TestBuildShellForm(t *testing.T) {
	la := registry.LoadedAction{
		Def: registry.ActionDef{
			Command: registry.Command{
				Run: "echo hi",
				Env: map[string]string{"A": "1"},
			},
		},
		Cwd: "/tmp",
	}
	r := mustBuild(t, context.Background(), la, Deps{BaseDir: "/base"}, Options{})
	sr, ok := r.(*runner.ShellRunner)
	if !ok {
		t.Fatalf("want ShellRunner, got %T", r)
	}
	if sr.Cfg.Run != "echo hi" || sr.Cfg.BaseDir != "/base" || sr.Cfg.Cwd != "/tmp" {
		t.Fatalf("cfg mismatch: %+v", sr.Cfg)
	}
	if sr.Cfg.CaptureOutput != nil {
		t.Fatalf("capture 应默认 nil（捕获开），got %v", *sr.Cfg.CaptureOutput)
	}

	// env 分层：注入 env 覆盖 action 定义同名键
	sr2 := mustBuild(t, context.Background(), la, Deps{}, Options{ExtraEnv: map[string]string{"A": "2", "B": "3"}}).(*runner.ShellRunner)
	if sr2.Cfg.Env["A"] != "2" || sr2.Cfg.Env["B"] != "3" {
		t.Fatalf("env merge mismatch: %v", sr2.Cfg.Env)
	}

	// capture_output: false（action 定义）→ 直跑也生效（回归测试：原 api.execute 漏传）
	f := false
	la.Def.Command.CaptureOutput = &f
	sr3 := mustBuild(t, context.Background(), la, Deps{}, Options{}).(*runner.ShellRunner)
	if sr3.Cfg.CaptureOutput == nil || *sr3.Cfg.CaptureOutput {
		t.Fatalf("action 定义 capture_output:false 未生效")
	}
	// step 显式覆盖 > action 定义
	tr := true
	sr4 := mustBuild(t, context.Background(), la, Deps{}, Options{CaptureOverride: &tr}).(*runner.ShellRunner)
	if sr4.Cfg.CaptureOutput == nil || !*sr4.Cfg.CaptureOutput {
		t.Fatalf("step capture 覆盖未生效")
	}

	// Deps.Builtins 应透传到 ShellRunner.Cfg.Builtins
	builtins := builtinvars.New(nil)
	sr5 := mustBuild(t, context.Background(), la, Deps{Builtins: builtins}, Options{}).(*runner.ShellRunner)
	if sr5.Cfg.Builtins != builtins {
		t.Fatal("Deps.Builtins 未透传到 ShellConfig.Builtins")
	}
}

// TestBuildPassesShellFields 验证 Run/Shell/Script/BashPath 透传到 ShellConfig。
func TestBuildPassesShellFields(t *testing.T) {
	la := registry.LoadedAction{Def: registry.ActionDef{
		ID: "a", Title: "A",
		Command: registry.Command{Run: "echo hi", Shell: "pwsh"},
	}}
	deps := Deps{BashPath: func() string { return `C:\custom\bash.exe` }}
	sr := mustBuild(t, context.Background(), la, deps, Options{}).(*runner.ShellRunner)
	if sr.Cfg.Run != "echo hi" || sr.Cfg.Shell != "pwsh" {
		t.Fatalf("Run/Shell 未透传: %+v", sr.Cfg)
	}
	if sr.Cfg.BashPath != `C:\custom\bash.exe` {
		t.Fatalf("BashPath 未透传: %q", sr.Cfg.BashPath)
	}
	// BashPath 为 nil deps 时不 panic、为空串
	sr2 := mustBuild(t, context.Background(), la, Deps{}, Options{}).(*runner.ShellRunner)
	if sr2.Cfg.BashPath != "" {
		t.Fatalf("nil Deps.BashPath 应兜底空串: %q", sr2.Cfg.BashPath)
	}
}

func TestBuildADBForm(t *testing.T) {
	la := registry.LoadedAction{
		Def: registry.ActionDef{
			Command: registry.Command{
				Adb: registry.AdbCommand{Operation: "install-package"},
			},
		},
		Timeout: 5 * time.Second,
	}
	r := mustBuild(t, context.Background(), la, Deps{}, Options{})
	ar, ok := r.(*adb.ADBRunner)
	if !ok {
		t.Fatalf("want ADBRunner, got %T", r)
	}
	if ar.Operation != "install-package" || ar.Timeout != 5*time.Second {
		t.Fatalf("mismatch: %+v", ar)
	}
}

func TestBuildLLMForm(t *testing.T) {
	la := registry.LoadedAction{
		Def: registry.ActionDef{
			Command: registry.Command{
				LLM: registry.LLMCommand{System: "ROLE", Prompt: "TASK", Resume: "SID"},
			},
		},
		Cwd: "/tmp/${X}",
	}
	params := map[string]any{
		"ROLE": "you are", "TASK": "do", "SID": " s1 ", "X": "work", "LLM_CLI": "claude",
	}
	r := mustBuild(t, context.Background(), la, Deps{}, Options{Params: params})
	lr, ok := r.(*runner.LLMRunner)
	if !ok {
		t.Fatalf("want LLMRunner, got %T", r)
	}
	if lr.Cfg.SystemPrompt != "you are" || lr.Cfg.Prompt != "do" {
		t.Fatalf("prompt mismatch: %+v", lr.Cfg)
	}
	if lr.Cfg.Resume != "s1" {
		t.Fatalf("resume not trimmed: %q", lr.Cfg.Resume)
	}
	if lr.Cfg.CLI != "claude" {
		t.Fatalf("cli mismatch: %q", lr.Cfg.CLI)
	}
	if lr.Cfg.Cwd != "/tmp/work" {
		t.Fatalf("cwd 未展开: %q", lr.Cfg.Cwd)
	}
	// env 分层对 LLM 形态同样生效
	sr := mustBuild(t, context.Background(), la, Deps{}, Options{Params: params, ExtraEnv: map[string]string{"K": "v"}})
	if got := sr.(*runner.LLMRunner).Cfg.Env["K"]; got != "v" {
		t.Fatalf("LLM env 注入缺失: %v", got)
	}
}

func TestBuildLLMSkillSyncWiring(t *testing.T) {
	base := t.TempDir() // 充当 BaseDir（= agent-cwd 兜底值）
	src := filepath.Join(base, "skills", "demo")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "SKILL.md"), []byte("# demo"), 0o644); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	// 目标目录名 = skill id（SkillRouter.Route 契约），与源目录名（demo）刻意不同，
	// 验证 Build 只消费 router 输出、不自己拼路径。
	dst := filepath.Join(home, ".claude", "skills", "demo-user") // user 级落 home

	la := registry.LoadedAction{Def: registry.ActionDef{ID: "a", Title: "a", Command: registry.Command{
		LLM: registry.LLMCommand{Prompt: "p", Skills: []string{"demo-user"}}}}}
	// 造 user 级 skill 元数据（registry 包外手写，验证 Build 只消费 router 输出）
	skills := map[string]registry.SkillMeta{"demo-user": {Scope: "user", Dir: src}}
	router := &SkillRouter{
		Skills:     func() map[string]registry.SkillMeta { return skills },
		HomeDir:    func() string { return home },
		LedgerPath: filepath.Join(t.TempDir(), "skills.synced.json"),
	}
	deps := Deps{BaseDir: base, SkillRouter: router}

	r, err := Build(context.Background(), la, deps, Options{Params: map[string]any{"p": "hi"}})
	if err != nil {
		t.Fatal(err)
	}
	lr, ok := r.(*runner.LLMRunner)
	if !ok {
		t.Fatalf("应构造 LLMRunner, got %T", r)
	}
	if len(lr.Cfg.SkillSyncReport) == 0 {
		t.Fatal("报告行应注入 LLMConfig")
	}
	if data, err := os.ReadFile(filepath.Join(dst, "SKILL.md")); err != nil || string(data) != "# demo" {
		t.Fatalf("user 级目标未落盘: %v", err)
	}
	// cwd 兜底：LLM.Cwd 空时 agent-cwd 用 BaseDir——本用例走 user 级不依赖它，
	// project 级兜底由 Route 的调用点保证（buildLLM 内 cwd=="" → deps.BaseDir）。
}

func TestBuildLLMSkillSyncFailureFails(t *testing.T) {
	router := &SkillRouter{
		Skills:     func() map[string]registry.SkillMeta { return map[string]registry.SkillMeta{} },
		HomeDir:    func() string { return t.TempDir() },
		LedgerPath: filepath.Join(t.TempDir(), "skills.synced.json"),
	}
	la := registry.LoadedAction{Def: registry.ActionDef{ID: "a", Title: "a", Command: registry.Command{
		LLM: registry.LLMCommand{Prompt: "p", Skills: []string{"ghost"}}}}}
	if _, err := Build(context.Background(), la, Deps{BaseDir: t.TempDir(), SkillRouter: router},
		Options{Params: map[string]any{"p": "hi"}}); err == nil {
		t.Fatal("skill 同步失败应使 Build 返回 error（动作失败）")
	}
}

// TestBuildLLMSkillSyncLedgerFailureWarns 锁定契约「账本 Record 失败 = 警告（不失败）」：
// LedgerPath 指向已存在的目录，os.WriteFile 必败（Windows ERROR_ACCESS_DENIED / Unix EISDIR），
// Build 仍应成功返回 LLMRunner，警告含 [skill-sync] 前缀，且同步落盘本身不受影响。
func TestBuildLLMSkillSyncLedgerFailureWarns(t *testing.T) {
	base := t.TempDir() // 充当 BaseDir（= agent-cwd 兜底值）
	src := filepath.Join(base, "skills", "demo")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "SKILL.md"), []byte("# demo"), 0o644); err != nil {
		t.Fatal(err)
	}
	ledgerDir := filepath.Join(t.TempDir(), "as-dir") // 已存在的目录 → WriteFile 必败
	if err := os.MkdirAll(ledgerDir, 0o755); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(base, ".claude", "skills", "demo") // project 级落 base

	skills := map[string]registry.SkillMeta{"demo": {Scope: "project", Dir: src}}
	router := &SkillRouter{
		Skills:     func() map[string]registry.SkillMeta { return skills },
		HomeDir:    func() string { return t.TempDir() },
		LedgerPath: ledgerDir,
	}
	la := registry.LoadedAction{Def: registry.ActionDef{ID: "a", Title: "a", Command: registry.Command{
		LLM: registry.LLMCommand{Prompt: "p", Skills: []string{"demo"}}}}}

	r, err := Build(context.Background(), la, Deps{BaseDir: base, SkillRouter: router},
		Options{Params: map[string]any{"p": "hi"}})
	if err != nil {
		t.Fatalf("账本写失败应降级为警告，不应使动作失败: %v", err)
	}
	lr, ok := r.(*runner.LLMRunner)
	if !ok {
		t.Fatalf("应构造 LLMRunner, got %T", r)
	}
	found := false
	for _, w := range lr.Cfg.SkillSyncWarnings {
		if strings.HasPrefix(w, "[skill-sync]") {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("账本写失败应产生 [skill-sync] 前缀警告: %v", lr.Cfg.SkillSyncWarnings)
	}
	// 同步本身不受账本失败影响：目标文件已落盘
	if data, err := os.ReadFile(filepath.Join(dst, "SKILL.md")); err != nil || string(data) != "# demo" {
		t.Fatalf("同步落盘不应受账本失败影响: %v", err)
	}
}
