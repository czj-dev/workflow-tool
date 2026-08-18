package runner

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func skipLLMWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix 专属 shell 行为")
	}
}

// fakeCLI 写一个可执行 sh 脚本充当 LLM CLI：把预置的 stream-json 行原样打到 stdout，
// 并把自己收到的 argv 与 stdin 落到 recordPath（供断言「system 是独立 argv、prompt 走 stdin」）。
// 返回脚本路径与 record 文件路径。
func fakeCLI(t *testing.T, stdoutLines []string) (cliPath, recordPath string) {
	t.Helper()
	dir := t.TempDir()
	cliPath = filepath.Join(dir, "fake-cli.sh")
	recordPath = filepath.Join(dir, "record.txt")
	linesPath := filepath.Join(dir, "lines.txt")

	if err := os.WriteFile(linesPath, []byte(strings.Join(stdoutLines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// ARG<...> 包裹每个 argv，便于断言多行内容是**一个**参数而非被 shell 拆开
	script := `#!/bin/sh
{
  for a in "$@"; do printf 'ARG<%s>\n' "$a"; done
  printf 'STDIN<'
  cat
  printf '>\n'
} > "` + recordPath + `"
cat "` + linesPath + `"
`
	if err := os.WriteFile(cliPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return cliPath, recordPath
}

// TestBuildLLMCommand_SystemIsSingleArgv 验证 argv 拼装：固定 flag + system 作为
// --append-system-prompt 的**单个**参数。含引号/换行/$ 的 system 不经 shell，故原样保留。
func TestBuildLLMCommand_SystemIsSingleArgv(t *testing.T) {
	system := "你是分析师。\n注意 \"引号\" 与 ${NOT_A_VAR} 和 $HOME 都应原样。"
	cmd := buildLLMCommand(LLMConfig{CLI: "my-cli", SystemPrompt: system})

	want := append([]string{"my-cli"}, llmFixedArgs...)
	want = append(want, "--append-system-prompt", system)
	if len(cmd.Args) != len(want) {
		t.Fatalf("argv 长度 = %d want %d：%q", len(cmd.Args), len(want), cmd.Args)
	}
	for i := range want {
		if cmd.Args[i] != want[i] {
			t.Fatalf("argv[%d] = %q want %q", i, cmd.Args[i], want[i])
		}
	}
}

// TestBuildLLMCommand_NoSystemNoFlag 验证 system 为空时不追加 --append-system-prompt。
func TestBuildLLMCommand_NoSystemNoFlag(t *testing.T) {
	cmd := buildLLMCommand(LLMConfig{CLI: "my-cli"})
	for _, a := range cmd.Args {
		if a == "--append-system-prompt" {
			t.Fatalf("system 为空不应出现 --append-system-prompt：%q", cmd.Args)
		}
	}
}

// TestBuildLLMCommand_DefaultCLI 验证 CLI 缺省为 ducc。
func TestBuildLLMCommand_DefaultCLI(t *testing.T) {
	cmd := buildLLMCommand(LLMConfig{})
	if cmd.Args[0] != defaultLLMCLI {
		t.Fatalf("CLI = %q want %q", cmd.Args[0], defaultLLMCLI)
	}
}

// TestBuildLLMCommand_ResumeFlag 验证 Resume 非空时插入 --resume <id>，位于固定 flag 之后、
// --append-system-prompt 之前。
func TestBuildLLMCommand_ResumeFlag(t *testing.T) {
	cmd := buildLLMCommand(LLMConfig{CLI: "my-cli", Resume: "sess-abc-123", SystemPrompt: "role"})
	want := append([]string{"my-cli"}, llmFixedArgs...)
	want = append(want, "--resume", "sess-abc-123", "--append-system-prompt", "role")
	if len(cmd.Args) != len(want) {
		t.Fatalf("argv 长度 = %d want %d：%q", len(cmd.Args), len(want), cmd.Args)
	}
	for i := range want {
		if cmd.Args[i] != want[i] {
			t.Fatalf("argv[%d] = %q want %q", i, cmd.Args[i], want[i])
		}
	}
}

// TestBuildLLMCommand_NoResumeNoFlag 验证 Resume 为空时不追加 --resume。
func TestBuildLLMCommand_NoResumeNoFlag(t *testing.T) {
	cmd := buildLLMCommand(LLMConfig{CLI: "my-cli"})
	for _, a := range cmd.Args {
		if a == "--resume" {
			t.Fatalf("Resume 为空不应出现 --resume：%q", cmd.Args)
		}
	}
}

// TestLLMRunner_SystemArgvAndPromptStdin 端到端验证：system 以单个 argv 抵达子进程，
// prompt 完整走 stdin——两者都含引号/换行/$，任何一处经 shell 都会被改写或炸开。
func TestLLMRunner_SystemArgvAndPromptStdin(t *testing.T) {
	skipLLMWindows(t)
	system := "角色：分析师\n带 \"引号\" 和 ${VAR} 与 $HOME"
	prompt := "问题：line1 \"quoted\"\nline2 ${ALSO_NOT_A_VAR}"
	cli, record := fakeCLI(t, []string{
		`{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}`,
	})

	r := &LLMRunner{Cfg: LLMConfig{
		CLI: cli, SystemPrompt: system, Prompt: prompt, Timeout: 5 * time.Second,
	}}
	res := r.Run(context.Background(), nil, func(string, string) {})
	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}

	data, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	if !strings.Contains(got, "ARG<"+system+">") {
		t.Fatalf("system 未作为单个 argv 抵达：\n%s", got)
	}
	if !strings.Contains(got, "ARG<--append-system-prompt>") {
		t.Fatalf("缺少 --append-system-prompt flag：\n%s", got)
	}
	if !strings.Contains(got, "STDIN<"+prompt+">") {
		t.Fatalf("prompt 未完整走 stdin：\n%s", got)
	}
}

// TestLLMRunner_EmptyPromptFails 验证 prompt 为空时直接失败，不启动子进程。
func TestLLMRunner_EmptyPromptFails(t *testing.T) {
	r := &LLMRunner{Cfg: LLMConfig{CLI: "definitely-not-a-real-cli", Timeout: time.Second}}
	res := r.Run(context.Background(), nil, func(string, string) {})
	if res.Err == nil {
		t.Fatal("prompt 为空应报错")
	}
	if res.ExitCode != -1 {
		t.Fatalf("exit=%d want -1", res.ExitCode)
	}
}

func TestLLMRunner_ParsesAssistantText(t *testing.T) {
	skipLLMWindows(t)
	cli, _ := fakeCLI(t, []string{
		`{"type":"assistant","message":{"content":[{"type":"text","text":"hello world"}]}}`,
	})
	r := &LLMRunner{Cfg: LLMConfig{CLI: cli, Prompt: "q", Timeout: 5 * time.Second}}

	var llmEvents []string
	res := r.Run(context.Background(), nil, func(stream, l string) {
		if stream == "llm" {
			llmEvents = append(llmEvents, l)
		}
	})

	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit=%d want 0", res.ExitCode)
	}
	if res.Stdout != "hello world" {
		t.Fatalf("Stdout=%q want %q", res.Stdout, "hello world")
	}
	if len(llmEvents) == 0 || llmEvents[0] != "hello world" {
		t.Fatalf("llm events=%v want [\"hello world\"]", llmEvents)
	}
}

func TestLLMRunner_NonJSONLineSkipped(t *testing.T) {
	skipLLMWindows(t)
	cli, _ := fakeCLI(t, []string{"not json"})
	r := &LLMRunner{Cfg: LLMConfig{CLI: cli, Prompt: "q", Timeout: 5 * time.Second}}
	res := r.Run(context.Background(), nil, func(stream, l string) {})
	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if res.Stdout != "" {
		t.Fatalf("Stdout=%q want empty（非法 JSON 应跳过）", res.Stdout)
	}
}

func TestLLMRunner_StderrEmittedNotCaptured(t *testing.T) {
	skipLLMWindows(t)
	// 让 fake CLI 额外往 stderr 打一行：直接用一个只写 stderr 的脚本
	dir := t.TempDir()
	cli := filepath.Join(dir, "err-cli.sh")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\ncat > /dev/null\necho 'diagnostic' 1>&2\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	r := &LLMRunner{Cfg: LLMConfig{CLI: cli, Prompt: "q", Timeout: 5 * time.Second}}
	var stderrLines []string
	res := r.Run(context.Background(), nil, func(stream, l string) {
		if stream == "stderr" {
			stderrLines = append(stderrLines, l)
		}
	})
	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if len(stderrLines) != 1 || stderrLines[0] != "diagnostic" {
		t.Fatalf("stderr lines=%v want [\"diagnostic\"]", stderrLines)
	}
	if res.Stderr != "" {
		t.Fatalf("Result.Stderr=%q want empty（stderr 只 emit，不进 Result）", res.Stderr)
	}
}

// TestLLMRunner_StructuredOutputs 验证 session_id/thinking/cost_usd/total_tokens
// 等结构化字段仍被累积进 Result.Outputs。
func TestLLMRunner_StructuredOutputs(t *testing.T) {
	skipLLMWindows(t)
	cli, _ := fakeCLI(t, []string{
		`{"type":"system","subtype":"init","session_id":"sess-abc-123"}`,
		`{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"思考中"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"，世界"}]}}`,
		`{"type":"result","total_cost_usd":0.0123,"usage":{"input_tokens":100,"output_tokens":50}}`,
	})
	r := &LLMRunner{Cfg: LLMConfig{CLI: cli, Prompt: "q", Timeout: 5 * time.Second}}
	res := r.Run(context.Background(), nil, func(string, string) {})

	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if res.Outputs["session_id"] != "sess-abc-123" {
		t.Fatalf("session_id = %q, want sess-abc-123", res.Outputs["session_id"])
	}
	if res.Outputs["text"] != "你好，世界" {
		t.Fatalf("text = %q, want 你好，世界", res.Outputs["text"])
	}
	if res.Outputs["thinking"] != "思考中" {
		t.Fatalf("thinking = %q, want 思考中", res.Outputs["thinking"])
	}
	if res.Outputs["cost_usd"] != "0.0123" {
		t.Fatalf("cost_usd = %q, want 0.0123", res.Outputs["cost_usd"])
	}
	if res.Outputs["total_tokens"] != "150" {
		t.Fatalf("total_tokens = %q, want 150", res.Outputs["total_tokens"])
	}
}
