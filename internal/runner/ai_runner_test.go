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

func skipAIWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix 专属 shell 行为")
	}
}

// fakeCLI 写一个可执行 sh 脚本充当 AI CLI：把预置的 stream-json 行原样打到 stdout，
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

// TestBuildAICommand_SystemIsSingleArgv 验证 argv 拼装：固定 flag + system 作为
// --append-system-prompt 的**单个**参数。含引号/换行/$ 的 system 不经 shell，故原样保留。
func TestBuildAICommand_SystemIsSingleArgv(t *testing.T) {
	system := "你是分析师。\n注意 \"引号\" 与 ${NOT_A_VAR} 和 $HOME 都应原样。"
	cmd := buildAICommand(AIConfig{CLI: "my-cli", SystemPrompt: system})

	want := append([]string{"my-cli"}, aiFixedArgs...)
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

// TestBuildAICommand_NoSystemNoFlag 验证 system 为空时不追加 --append-system-prompt。
func TestBuildAICommand_NoSystemNoFlag(t *testing.T) {
	cmd := buildAICommand(AIConfig{CLI: "my-cli"})
	for _, a := range cmd.Args {
		if a == "--append-system-prompt" {
			t.Fatalf("system 为空不应出现 --append-system-prompt：%q", cmd.Args)
		}
	}
}

// TestBuildAICommand_DefaultCLI 验证 CLI 缺省为 ducc。
func TestBuildAICommand_DefaultCLI(t *testing.T) {
	cmd := buildAICommand(AIConfig{})
	if cmd.Args[0] != DefaultAICLI {
		t.Fatalf("CLI = %q want %q", cmd.Args[0], DefaultAICLI)
	}
}

// TestBuildAICommand_ResumeFlag 验证 Resume 非空时插入 --resume <id>，位于固定 flag 之后、
// --append-system-prompt 之前。
func TestBuildAICommand_ResumeFlag(t *testing.T) {
	cmd := buildAICommand(AIConfig{CLI: "my-cli", Resume: "sess-abc-123", SystemPrompt: "role"})
	want := append([]string{"my-cli"}, aiFixedArgs...)
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

// TestBuildAICommand_NoResumeNoFlag 验证 Resume 为空时不追加 --resume。
func TestBuildAICommand_NoResumeNoFlag(t *testing.T) {
	cmd := buildAICommand(AIConfig{CLI: "my-cli"})
	for _, a := range cmd.Args {
		if a == "--resume" {
			t.Fatalf("Resume 为空不应出现 --resume：%q", cmd.Args)
		}
	}
}

// TestBuildAICommand_RulesAndSystemMerged 验证守则与任务 system 合成**一段**，经单个
// --append-system-prompt 传入：守则在前、system 在后，中间空一行。
func TestBuildAICommand_RulesAndSystemMerged(t *testing.T) {
	cmd := buildAICommand(AIConfig{CLI: "my-cli", Rules: "# 无人值守守则\n\n1. 条款。\n", SystemPrompt: "角色：分析师"})
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

// TestBuildAICommand_RulesOnly 验证任务没写 system 时系统提示只有守则。
func TestBuildAICommand_RulesOnly(t *testing.T) {
	cmd := buildAICommand(AIConfig{CLI: "my-cli", Rules: "# 守则"})
	if n := len(cmd.Args); n < 2 || cmd.Args[n-2] != "--append-system-prompt" || cmd.Args[n-1] != "# 守则" {
		t.Fatalf("只有守则时应以 --append-system-prompt <守则> 结尾：%q", cmd.Args)
	}
}

// TestBuildAICommand_BlankRulesNoFlag 验证守则与 system 都是空白时不传 --append-system-prompt。
func TestBuildAICommand_BlankRulesNoFlag(t *testing.T) {
	cmd := buildAICommand(AIConfig{CLI: "my-cli", Rules: "  \n"})
	for _, a := range cmd.Args {
		if a == "--append-system-prompt" {
			t.Fatalf("守则与 system 皆空不应出现 --append-system-prompt：%q", cmd.Args)
		}
	}
}

var _ Runner = (*AIRunner)(nil)

// TestAIRunner_StreamKinds 验证事件流种类：回复增量走 ai、思考走 ai-thinking、
// 工具调用对走 ai-tool，不再有 llm* 字样。
func TestAIRunner_StreamKinds(t *testing.T) {
	skipAIWindows(t)
	cli, _ := fakeCLI(t, []string{
		`{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"想"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"call_1","name":"Read","input":{"file_path":"a"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call_1","content":"ok"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"答"}]}}`,
	})
	r := &AIRunner{Cfg: AIConfig{CLI: cli, Prompt: "q", Timeout: 5 * time.Second}}

	var streams []string
	res := r.Run(context.Background(), nil, func(stream, _ string) { streams = append(streams, stream) })
	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	want := []string{"ai-thinking", "ai-tool", "ai-tool", "ai"}
	if strings.Join(streams, ",") != strings.Join(want, ",") {
		t.Fatalf("streams = %v want %v", streams, want)
	}
}

// TestAIRunner_EnvFromInputsOnly 验证子进程 env 只取 cfg.Inputs：Run 的 params 形参
// 一律忽略，提示词类参数即使被传进来也不会漏进子进程环境。
func TestAIRunner_EnvFromInputsOnly(t *testing.T) {
	skipAIWindows(t)
	dir := t.TempDir()
	cli := filepath.Join(dir, "env-cli.sh")
	// 把三个环境变量打到 stderr（stderr 原样 emit，不进 stream-json 解析）。
	script := "#!/bin/sh\n" +
		"printf 'FROM_INPUT<%s>|FROM_PARAMS<%s>|PROMPT_VAR<%s>\\n' \"$FROM_INPUT\" \"$FROM_PARAMS\" \"$prompt\" 1>&2\n"
	if err := os.WriteFile(cli, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	r := &AIRunner{Cfg: AIConfig{
		CLI: cli, Prompt: "q", Timeout: 5 * time.Second,
		Inputs: map[string]any{"FROM_INPUT": "yes"},
	}}

	var stderrLines []string
	res := r.Run(context.Background(), map[string]any{"FROM_PARAMS": "yes", "prompt": "leak"}, func(stream, l string) {
		if stream == "stderr" {
			stderrLines = append(stderrLines, l)
		}
	})
	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	want := "FROM_INPUT<yes>|FROM_PARAMS<>|PROMPT_VAR<>"
	if len(stderrLines) != 1 || stderrLines[0] != want {
		t.Fatalf("stderr lines = %q want [%q]", stderrLines, want)
	}
}

// TestAIRunner_SystemArgvAndPromptStdin 端到端验证：system 以单个 argv 抵达子进程，
// prompt 完整走 stdin——两者都含引号/换行/$，任何一处经 shell 都会被改写或炸开。
func TestAIRunner_SystemArgvAndPromptStdin(t *testing.T) {
	skipAIWindows(t)
	system := "角色：分析师\n带 \"引号\" 和 ${VAR} 与 $HOME"
	prompt := "问题：line1 \"quoted\"\nline2 ${ALSO_NOT_A_VAR}"
	cli, record := fakeCLI(t, []string{
		`{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}`,
	})

	r := &AIRunner{Cfg: AIConfig{
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

// TestAIRunner_EmptyPromptFails 验证 prompt 为空时直接失败，不启动子进程。
func TestAIRunner_EmptyPromptFails(t *testing.T) {
	r := &AIRunner{Cfg: AIConfig{CLI: "definitely-not-a-real-cli", Timeout: time.Second}}
	res := r.Run(context.Background(), nil, func(string, string) {})
	if res.Err == nil {
		t.Fatal("prompt 为空应报错")
	}
	if res.ExitCode != -1 {
		t.Fatalf("exit=%d want -1", res.ExitCode)
	}
}

func TestAIRunner_ParsesAssistantText(t *testing.T) {
	skipAIWindows(t)
	cli, _ := fakeCLI(t, []string{
		`{"type":"assistant","message":{"content":[{"type":"text","text":"hello world"}]}}`,
	})
	r := &AIRunner{Cfg: AIConfig{CLI: cli, Prompt: "q", Timeout: 5 * time.Second}}

	var aiEvents []string
	res := r.Run(context.Background(), nil, func(stream, l string) {
		if stream == "ai" {
			aiEvents = append(aiEvents, l)
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
	if len(aiEvents) == 0 || aiEvents[0] != "hello world" {
		t.Fatalf("ai events=%v want [\"hello world\"]", aiEvents)
	}
}

func TestAIRunner_NonJSONLineSkipped(t *testing.T) {
	skipAIWindows(t)
	cli, _ := fakeCLI(t, []string{"not json"})
	r := &AIRunner{Cfg: AIConfig{CLI: cli, Prompt: "q", Timeout: 5 * time.Second}}
	res := r.Run(context.Background(), nil, func(stream, l string) {})
	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if res.Stdout != "" {
		t.Fatalf("Stdout=%q want empty（非法 JSON 应跳过）", res.Stdout)
	}
}

func TestAIRunner_StderrEmittedNotCaptured(t *testing.T) {
	skipAIWindows(t)
	// 让 fake CLI 额外往 stderr 打一行：直接用一个只写 stderr 的脚本
	dir := t.TempDir()
	cli := filepath.Join(dir, "err-cli.sh")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\ncat > /dev/null\necho 'diagnostic' 1>&2\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	r := &AIRunner{Cfg: AIConfig{CLI: cli, Prompt: "q", Timeout: 5 * time.Second}}
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

// TestAIRunnerEmitsSkillSyncReportFirst 验证 skill 同步报告行/警告行在 Run 开头最先
// emit（先于 Prompt 检查与子进程启动等一切失败路径），且只走 emit、不进 Result.Stdout。
func TestAIRunnerEmitsSkillSyncReportFirst(t *testing.T) {
	var got []string
	emit := func(stream, line string) { got = append(got, stream+":"+line) }

	r := &AIRunner{Cfg: AIConfig{
		Prompt: "hi",
		CLI:    "definitely-no-such-cli", // 不存在的 CLI：子进程必然启动失败，
		// 但报告行应在任何失败路径之前 emit
		SkillSyncReport:   []string{"[skill-sync] demo(project) → D:\\p\\.claude\\skills\\demo"},
		SkillSyncWarnings: []string{"[skill-sync] 未知 CLI 回退"},
	}}
	res := r.Run(context.Background(), map[string]any{}, emit)

	// CLI 启动失败无任何子进程输出，收集器里应恰有手动注入的 2 行且顺序固定：
	// 警告（stderr）在前、报告（stdout）在后。
	if len(got) != 2 || got[0] != "stderr:[skill-sync] 未知 CLI 回退" || got[1] != "stdout:[skill-sync] demo(project) → D:\\p\\.claude\\skills\\demo" {
		t.Fatalf("报告行应最先 emit: %v", got)
	}
	if res.Stdout != "" {
		t.Fatalf("报告行不得进 Result.Stdout: %q", res.Stdout)
	}
}

// TestAIRunner_StructuredOutputs 验证 session_id/thinking/cost_usd/total_tokens
// 等结构化字段仍被累积进 Result.Outputs。
func TestAIRunner_StructuredOutputs(t *testing.T) {
	skipAIWindows(t)
	cli, _ := fakeCLI(t, []string{
		`{"type":"system","subtype":"init","session_id":"sess-abc-123"}`,
		`{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"思考中"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"，世界"}]}}`,
		`{"type":"result","total_cost_usd":0.0123,"usage":{"input_tokens":100,"output_tokens":50}}`,
	})
	r := &AIRunner{Cfg: AIConfig{CLI: cli, Prompt: "q", Timeout: 5 * time.Second}}
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
