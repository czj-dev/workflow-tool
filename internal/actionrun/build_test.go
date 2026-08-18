package actionrun

import (
	"testing"
	"time"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
)

func TestBuildShellForm(t *testing.T) {
	la := registry.LoadedAction{
		Def: registry.ActionDef{
			Command: registry.Command{
				Shell: "echo hi",
				Env:   map[string]string{"A": "1"},
			},
		},
		Cwd: "/tmp",
	}
	r := Build(la, Deps{BaseDir: "/base"}, Options{})
	sr, ok := r.(*runner.ShellRunner)
	if !ok {
		t.Fatalf("want ShellRunner, got %T", r)
	}
	if sr.Cfg.Shell != "echo hi" || sr.Cfg.BaseDir != "/base" || sr.Cfg.Cwd != "/tmp" {
		t.Fatalf("cfg mismatch: %+v", sr.Cfg)
	}
	if sr.Cfg.CaptureOutput != nil {
		t.Fatalf("capture 应默认 nil（捕获开），got %v", *sr.Cfg.CaptureOutput)
	}

	// env 分层：注入 env 覆盖 action 定义同名键
	sr2 := Build(la, Deps{}, Options{ExtraEnv: map[string]string{"A": "2", "B": "3"}}).(*runner.ShellRunner)
	if sr2.Cfg.Env["A"] != "2" || sr2.Cfg.Env["B"] != "3" {
		t.Fatalf("env merge mismatch: %v", sr2.Cfg.Env)
	}

	// capture_output: false（action 定义）→ 直跑也生效（回归测试：原 api.execute 漏传）
	f := false
	la.Def.Command.CaptureOutput = &f
	sr3 := Build(la, Deps{}, Options{}).(*runner.ShellRunner)
	if sr3.Cfg.CaptureOutput == nil || *sr3.Cfg.CaptureOutput {
		t.Fatalf("action 定义 capture_output:false 未生效")
	}
	// step 显式覆盖 > action 定义
	tr := true
	sr4 := Build(la, Deps{}, Options{CaptureOverride: &tr}).(*runner.ShellRunner)
	if sr4.Cfg.CaptureOutput == nil || !*sr4.Cfg.CaptureOutput {
		t.Fatalf("step capture 覆盖未生效")
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
	r := Build(la, Deps{}, Options{})
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
	r := Build(la, Deps{}, Options{Params: params})
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
	sr := Build(la, Deps{}, Options{Params: params, ExtraEnv: map[string]string{"K": "v"}})
	if got := sr.(*runner.LLMRunner).Cfg.Env["K"]; got != "v" {
		t.Fatalf("LLM env 注入缺失: %v", got)
	}
}
