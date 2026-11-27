package runner

import (
	"testing"
)

func assertArgv(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("argv 长度 = %d want %d:\ngot  %q\nwant %q", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("argv[%d] = %q want %q\ngot  %q", i, got[i], want[i], got)
		}
	}
}

// TestBuildPICommand_FullArgv 验证设计 §1 的完整 argv 与顺序：固定 flag →
// --session-dir → --no-skills → --skill（可多个）→ --model（provider 前缀）→
// --session（resume）→ --append-system-prompt（单 argv）。
func TestBuildPICommand_FullArgv(t *testing.T) {
	cmd := buildPICommand(AIConfig{
		PiBin:        "/bin/pi",
		Model:        "GLM-5.3-Flash",
		SessionDir:   "/base/pi-sessions",
		SkillDirs:    []string{"/base/skills/demo", "/base/skills/lint"},
		Resume:       "sess-abc-123",
		SystemPrompt: "角色：分析师",
	})
	want := []string{
		"/bin/pi",
		"--mode", "json",
		"--offline",
		"--no-approve",
		"--session-dir", "/base/pi-sessions",
		"--no-skills",
		"--skill", "/base/skills/demo",
		"--skill", "/base/skills/lint",
		"--model", "workflow-tool/GLM-5.3-Flash",
		"--session", "sess-abc-123",
		"--append-system-prompt", "角色：分析师",
	}
	assertArgv(t, cmd.Args, want)
}

// TestBuildPICommand_MinimalArgv 无 session 目录 / 无 skill / 无 resume / 无 system
// 时只剩固定 flag 与 --model；--session-dir 缺省不出现。
func TestBuildPICommand_MinimalArgv(t *testing.T) {
	cmd := buildPICommand(AIConfig{PiBin: "pi", Model: "M"})
	want := []string{"pi", "--mode", "json", "--offline", "--no-approve", "--no-skills", "--model", "workflow-tool/M"}
	assertArgv(t, cmd.Args, want)
}

// TestBuildPICommand_SystemIsSingleArgv 验证 system 作为 --append-system-prompt 的
// **单个**参数。含引号/换行/$ 的 system 不经 shell，故原样保留。
func TestBuildPICommand_SystemIsSingleArgv(t *testing.T) {
	system := "你是分析师。\n注意 \"引号\" 与 ${NOT_A_VAR} 和 $HOME 都应原样。"
	cmd := buildPICommand(AIConfig{PiBin: "pi", Model: "M", SystemPrompt: system})
	for i, a := range cmd.Args {
		if a == "--append-system-prompt" {
			if i+1 >= len(cmd.Args) || cmd.Args[i+1] != system {
				t.Fatalf("system 应作为单个 argv 抵达：%q", cmd.Args)
			}
			return
		}
	}
	t.Fatalf("缺少 --append-system-prompt：%q", cmd.Args)
}

// TestBuildPICommand_NoSystemNoFlag 验证 system 为空时不追加 --append-system-prompt。
func TestBuildPICommand_NoSystemNoFlag(t *testing.T) {
	cmd := buildPICommand(AIConfig{PiBin: "pi", Model: "M"})
	for _, a := range cmd.Args {
		if a == "--append-system-prompt" {
			t.Fatalf("system 为空不应出现 --append-system-prompt：%q", cmd.Args)
		}
	}
}

// TestBuildPICommand_ResumeMapsToSession 验证 Resume 非空时映射为 --session <id>
// （pi 的续接 flag，接替 CC 的 --resume）。
func TestBuildPICommand_ResumeMapsToSession(t *testing.T) {
	cmd := buildPICommand(AIConfig{PiBin: "pi", Model: "M", Resume: "sess-abc-123", SystemPrompt: "role"})
	want := []string{
		"pi", "--mode", "json", "--offline", "--no-approve", "--no-skills",
		"--model", "workflow-tool/M",
		"--session", "sess-abc-123",
		"--append-system-prompt", "role",
	}
	assertArgv(t, cmd.Args, want)
}

// TestBuildPICommand_NoResumeNoFlag 验证 Resume 为空时不追加 --session。
func TestBuildPICommand_NoResumeNoFlag(t *testing.T) {
	cmd := buildPICommand(AIConfig{PiBin: "pi", Model: "M"})
	for _, a := range cmd.Args {
		if a == "--session" {
			t.Fatalf("Resume 为空不应出现 --session：%q", cmd.Args)
		}
	}
}

// TestBuildPICommand_SkillDirBlankSkipped 空 skill 目录跳过（Build 层解析异常的兜底）。
func TestBuildPICommand_SkillDirBlankSkipped(t *testing.T) {
	cmd := buildPICommand(AIConfig{PiBin: "pi", Model: "M", SkillDirs: []string{"", "/base/skills/demo"}})
	want := []string{
		"pi", "--mode", "json", "--offline", "--no-approve", "--no-skills",
		"--skill", "/base/skills/demo",
		"--model", "workflow-tool/M",
	}
	assertArgv(t, cmd.Args, want)
}

// TestBuildPICommand_RulesAndSystemMerged 验证守则与任务 system 合成**一段**，经单个
// --append-system-prompt 传入：守则在前、system 在后，中间空一行。
func TestBuildPICommand_RulesAndSystemMerged(t *testing.T) {
	cmd := buildPICommand(AIConfig{PiBin: "pi", Model: "M", Rules: "# 无人值守守则\n\n1. 条款。\n", SystemPrompt: "角色：分析师"})
	var got []string
	for i, a := range cmd.Args {
		if a == "--append-system-prompt" {
			got = append(got, cmd.Args[i+1])
		}
	}
	if len(got) != 1 {
		t.Fatalf("--append-system-prompt 应恰好出现一次，got %d 次：%q", len(got), cmd.Args)
	}
	if want := "# 无人值守守则\n\n1. 条款。\n\n角色：分析师"; got[0] != want {
		t.Fatalf("system = %q want %q", got[0], want)
	}
}

// TestBuildPICommand_RulesOnly 验证任务没写 system 时系统提示只有守则。
func TestBuildPICommand_RulesOnly(t *testing.T) {
	cmd := buildPICommand(AIConfig{PiBin: "pi", Model: "M", Rules: "# 守则"})
	if n := len(cmd.Args); n < 2 || cmd.Args[n-2] != "--append-system-prompt" || cmd.Args[n-1] != "# 守则" {
		t.Fatalf("只有守则时应以 --append-system-prompt <守则> 结尾：%q", cmd.Args)
	}
}

// TestBuildPICommand_BlankRulesNoFlag 验证守则与 system 都是空白时不传 --append-system-prompt。
func TestBuildPICommand_BlankRulesNoFlag(t *testing.T) {
	cmd := buildPICommand(AIConfig{PiBin: "pi", Model: "M", Rules: "  \n"})
	for _, a := range cmd.Args {
		if a == "--append-system-prompt" {
			t.Fatalf("守则与 system 皆空不应出现 --append-system-prompt：%q", cmd.Args)
		}
	}
}
