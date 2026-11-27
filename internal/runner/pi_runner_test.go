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

var _ Runner = (*AIRunner)(nil)

// fakeCLI 写一个可执行 sh 脚本充当 pi：把预置的 JSONL 事件行原样打到 stdout，
// 并把自己收到的 argv 与 stdin 落到 recordPath（供断言「system 是独立 argv、
// prompt 走 stdin、--model 带前缀」）。返回脚本路径与 record 文件路径。
func fakeCLI(t *testing.T, stdoutLines []string) (cliPath, recordPath string) {
	t.Helper()
	dir := t.TempDir()
	cliPath = filepath.Join(dir, "fake-pi.sh")
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

// piRunCfg 构造一个最小可跑的配置（fakeCLI 当 PiBin）。
func piRunCfg(cli string) AIConfig {
	return AIConfig{PiBin: cli, Model: "GLM-5.3-Flash", Prompt: "q", Timeout: 5 * time.Second}
}

// TestAIRunner_StreamKinds 验证事件流种类：思考增量走 ai-thinking、工具调用对走
// ai-tool、回复增量走 ai。
func TestAIRunner_StreamKinds(t *testing.T) {
	skipAIWindows(t)
	cli, _ := fakeCLI(t, []string{
		`{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"想"}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","contentIndex":0,"toolCall":{"id":"call_1","name":"Read","arguments":{"file_path":"a"}}}}`,
		`{"type":"tool_execution_end","toolCallId":"call_1","result":{"content":"ok","isError":false}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"答"}}`,
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"答"}],"stopReason":"stop"}}`,
	})
	r := &AIRunner{Cfg: piRunCfg(cli)}

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

// TestAIRunner_EnvFromInputsAndAgentDir 验证子进程 env 只取 cfg.Inputs（Run 的
// params 形参一律忽略，提示词类参数不漏进子进程环境），且 AgentDir 映射为
// PI_CODING_AGENT_DIR。
func TestAIRunner_EnvFromInputsAndAgentDir(t *testing.T) {
	skipAIWindows(t)
	dir := t.TempDir()
	agentDir := filepath.Join(dir, "pi-agent")
	cli := filepath.Join(dir, "env-pi.sh")
	// 把四个环境变量打到 stderr（stderr 原样 emit，不进事件流解析）。
	script := "#!/bin/sh\n" +
		"printf 'FROM_INPUT<%s>|FROM_PARAMS<%s>|PROMPT_VAR<%s>|PI_AGENT<%s>\\n' \"$FROM_INPUT\" \"$FROM_PARAMS\" \"$prompt\" \"$PI_CODING_AGENT_DIR\" 1>&2\n"
	if err := os.WriteFile(cli, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := piRunCfg(cli)
	cfg.AgentDir = agentDir
	cfg.Inputs = map[string]any{"FROM_INPUT": "yes"}
	r := &AIRunner{Cfg: cfg}

	var stderrLines []string
	res := r.Run(context.Background(), map[string]any{"FROM_PARAMS": "yes", "prompt": "leak"}, func(stream, l string) {
		if stream == "stderr" {
			stderrLines = append(stderrLines, l)
		}
	})
	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	want := "FROM_INPUT<yes>|FROM_PARAMS<>|PROMPT_VAR<>|PI_AGENT<" + agentDir + ">"
	if len(stderrLines) != 1 || stderrLines[0] != want {
		t.Fatalf("stderr lines = %q want [%q]", stderrLines, want)
	}
}

// TestAIRunner_SystemArgvAndPromptStdin 端到端验证：system 以单个 argv 抵达子进程
// （--append-system-prompt）、--model 带 provider 前缀，prompt 完整走 stdin——
// system 与 prompt 都含引号/换行/$，任何一处经 shell 都会被改写或炸开。
func TestAIRunner_SystemArgvAndPromptStdin(t *testing.T) {
	skipAIWindows(t)
	system := "角色：分析师\n带 \"引号\" 和 ${VAR} 与 $HOME"
	prompt := "问题：line1 \"quoted\"\nline2 ${ALSO_NOT_A_VAR}"
	cli, record := fakeCLI(t, []string{
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop"}}`,
	})

	cfg := piRunCfg(cli)
	cfg.SystemPrompt = system
	cfg.Prompt = prompt
	r := &AIRunner{Cfg: cfg}
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
	if !strings.Contains(got, "ARG<--model>\nARG<workflow-tool/GLM-5.3-Flash>") {
		t.Fatalf("--model 应带 provider 前缀：\n%s", got)
	}
	if !strings.Contains(got, "ARG<--mode>\nARG<json>") {
		t.Fatalf("缺少 --mode json：\n%s", got)
	}
	if !strings.Contains(got, "STDIN<"+prompt+">") {
		t.Fatalf("prompt 未完整走 stdin：\n%s", got)
	}
}

// TestAIRunner_PreflightFails 前置校验：提示词 / PiBin / Model 三缺一早失败，
// 不启动子进程。
func TestAIRunner_PreflightFails(t *testing.T) {
	cases := []struct {
		name string
		cfg  AIConfig
		want string
	}{
		{"empty-prompt", AIConfig{PiBin: "no-such-pi", Model: "M"}, "提示词"},
		{"no-pibin", AIConfig{Model: "M", Prompt: "q"}, "pi 可执行路径"},
		{"no-model", AIConfig{PiBin: "no-such-pi", Prompt: "q"}, "AI_MODEL"},
	}
	for _, c := range cases {
		r := &AIRunner{Cfg: c.cfg}
		res := r.Run(context.Background(), nil, func(string, string) {})
		if res.Err == nil || !strings.Contains(res.Err.Error(), c.want) {
			t.Fatalf("%s: err = %v，应含 %q", c.name, res.Err, c.want)
		}
		if res.ExitCode != -1 {
			t.Fatalf("%s: exit=%d want -1", c.name, res.ExitCode)
		}
	}
}

func TestAIRunner_ParsesAssistantText(t *testing.T) {
	skipAIWindows(t)
	cli, _ := fakeCLI(t, []string{
		`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"hello world"}}`,
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello world"}],"stopReason":"stop"}}`,
	})
	r := &AIRunner{Cfg: piRunCfg(cli)}

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

// TestAIRunner_NonJSONLineSkipped pi 偶发杂质输出不炸解析、不进 Stdout。
func TestAIRunner_NonJSONLineSkipped(t *testing.T) {
	skipAIWindows(t)
	cli, _ := fakeCLI(t, []string{"not json"})
	r := &AIRunner{Cfg: piRunCfg(cli)}
	res := r.Run(context.Background(), nil, func(string, string) {})
	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if res.Stdout != "" {
		t.Fatalf("Stdout=%q want empty（非法 JSON 应跳过）", res.Stdout)
	}
}

func TestAIRunner_StderrEmittedNotCaptured(t *testing.T) {
	skipAIWindows(t)
	// 让 fake pi 只写 stderr：诊断行原样 emit、不进 Result
	dir := t.TempDir()
	cli := filepath.Join(dir, "err-pi.sh")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\ncat > /dev/null\necho 'diagnostic' 1>&2\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	r := &AIRunner{Cfg: piRunCfg(cli)}
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

// TestAIRunnerEmitsReportFirst 验证 skill 报告行 / Build 警告行在 Run 开头最先
// emit（先于一切失败路径），且只走 emit、不进 Result.Stdout。
func TestAIRunnerEmitsReportFirst(t *testing.T) {
	var got []string
	emit := func(stream, line string) { got = append(got, stream+":"+line) }

	cfg := piRunCfg("definitely-no-such-pi") // 不存在的路径：子进程必然启动失败，
	// 但报告行应在任何失败路径之前 emit
	cfg.SkillReport = []string{"[skill] 绑定 2 个 skill（零拷贝直传）：demo, lint"}
	cfg.BuildWarnings = []string{"[config] AI_CLI 已忽略（pi 为唯一运行器）"}
	r := &AIRunner{Cfg: cfg}
	res := r.Run(context.Background(), map[string]any{}, emit)

	// 启动失败无任何子进程输出，收集器里应恰有手动注入的 2 行且顺序固定：
	// 警告（stderr）在前、报告（stdout）在后。
	if len(got) != 2 || got[0] != "stderr:[config] AI_CLI 已忽略（pi 为唯一运行器）" ||
		got[1] != "stdout:[skill] 绑定 2 个 skill（零拷贝直传）：demo, lint" {
		t.Fatalf("报告行应最先 emit: %v", got)
	}
	if res.Stdout != "" {
		t.Fatalf("报告行不得进 Result.Stdout: %q", res.Stdout)
	}
}

// TestAIRunner_StructuredOutputs 验证 session_id / text / thinking / usage 键
// 被累积进 Result.Outputs（键名与前端终点读数、airun.Readout 契约一致）。
func TestAIRunner_StructuredOutputs(t *testing.T) {
	skipAIWindows(t)
	cli, _ := fakeCLI(t, []string{
		`{"type":"session","id":"sess-abc-123"}`,
		`{"type":"message_update","usage":{"input":100,"output":50,"totalTokens":150,"cost":{"total":0.0123}},"assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"思考中"}}`,
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"思考中"},{"type":"text","text":"你好"}],"stopReason":"stop","usage":{"input":100,"output":50,"totalTokens":150,"cost":{"total":0.0123}}}}`,
	})
	r := &AIRunner{Cfg: piRunCfg(cli)}
	res := r.Run(context.Background(), nil, func(string, string) {})

	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if res.Outputs["session_id"] != "sess-abc-123" {
		t.Fatalf("session_id = %q, want sess-abc-123", res.Outputs["session_id"])
	}
	if res.Outputs["text"] != "你好" {
		t.Fatalf("text = %q, want 你好", res.Outputs["text"])
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
	if res.Outputs["input_tokens"] != "100" || res.Outputs["output_tokens"] != "50" {
		t.Fatalf("分项 tokens = %q / %q", res.Outputs["input_tokens"], res.Outputs["output_tokens"])
	}
}

// TestAIRunner_StreamErrorFailsDespiteExit0 失败语义（设计 §3）：pi exit 0 + 流内
// stopReason=error → Result.ExitCode=-1、Err 带文案、文案进 stderr 流。
func TestAIRunner_StreamErrorFailsDespiteExit0(t *testing.T) {
	skipAIWindows(t)
	cli, _ := fakeCLI(t, []string{
		`{"type":"session","id":"sess-1"}`,
		`{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"503: {\"message\":\"无可用渠道\",\"type\":\"one_api_error\"}"}}`,
		`{"type":"agent_settled","aborted":false}`,
	})
	r := &AIRunner{Cfg: piRunCfg(cli)}

	var stderrLines []string
	res := r.Run(context.Background(), nil, func(stream, l string) {
		if stream == "stderr" {
			stderrLines = append(stderrLines, l)
		}
	})

	if res.ExitCode != -1 {
		t.Fatalf("exit=%d want -1（流内失败必须判失败）", res.ExitCode)
	}
	if res.Err == nil || !strings.Contains(res.Err.Error(), "无可用渠道") {
		t.Fatalf("err = %v，应携带 errorMessage 文案", res.Err)
	}
	if res.Outputs["success"] != "false" {
		t.Fatalf("success = %q want false", res.Outputs["success"])
	}
	if len(stderrLines) != 1 || !strings.Contains(stderrLines[0], "无可用渠道") {
		t.Fatalf("错误文案应推到 stderr 诊断流: %q", stderrLines)
	}
	if res.Stdout != "" {
		t.Fatalf("Stdout=%q want empty", res.Stdout)
	}
}

// TestAIRunner_AbortedFailsDespiteExit0 agent_settled.aborted 同样判失败。
func TestAIRunner_AbortedFailsDespiteExit0(t *testing.T) {
	skipAIWindows(t)
	cli, _ := fakeCLI(t, []string{`{"type":"agent_settled","aborted":true}`})
	r := &AIRunner{Cfg: piRunCfg(cli)}
	res := r.Run(context.Background(), nil, func(string, string) {})
	if res.ExitCode != -1 {
		t.Fatalf("exit=%d want -1", res.ExitCode)
	}
	if res.Err == nil || !strings.Contains(res.Err.Error(), "agent aborted") {
		t.Fatalf("err = %v，应为 agent aborted", res.Err)
	}
}

// TestAIRunner_FixtureReplay 用阶段 0 录制的真实事件流端到端回放。
func TestAIRunner_FixtureReplay(t *testing.T) {
	skipAIWindows(t)
	raw, err := os.ReadFile("testdata/pi_stream.jsonl")
	if err != nil {
		t.Fatalf("读 fixture: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	cli, _ := fakeCLI(t, lines)
	r := &AIRunner{Cfg: piRunCfg(cli)}

	var aiText []string
	res := r.Run(context.Background(), nil, func(stream, l string) {
		if stream == "ai" {
			aiText = append(aiText, l)
		}
	})

	if res.Err != nil {
		t.Fatalf("err: %v", res.Err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit=%d want 0", res.ExitCode)
	}
	if res.Stdout != "收到" {
		t.Fatalf("Stdout=%q want 收到", res.Stdout)
	}
	if strings.Join(aiText, "") != "收到" {
		t.Fatalf("ai 增量 = %q", strings.Join(aiText, ""))
	}
	if res.Outputs["session_id"] != "01a21c1f-8456-7696-b1e9-36b0f88eeb77" {
		t.Fatalf("session_id = %q", res.Outputs["session_id"])
	}
	if res.Outputs["input_tokens"] != "1298" || res.Outputs["output_tokens"] != "36" || res.Outputs["total_tokens"] != "1334" {
		t.Fatalf("tokens = %q/%q/%q", res.Outputs["input_tokens"], res.Outputs["output_tokens"], res.Outputs["total_tokens"])
	}
}
