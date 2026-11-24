package actionrun

import (
	"context"
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
