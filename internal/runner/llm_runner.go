package runner

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"workflow-tool/internal/builtinvars"
)

// llmFixedArgs 是所有 LLM 调用共用的固定 flag：
//   - -p / --output-format=stream-json / --verbose：headless 打印 + stream-json 流式
//   - --thinking enabled：附带思考过程增量
//   - --permission-mode bypassPermissions：headless 没有交互通道，遇工具/权限询问会直接失败退出，
//     必须启动时声明「不问」。纯问答 action 加了无害；需调工具的 action 才能真正跑通。
//
// 作者在 YAML 里不写任何 CLI flag，全部由 Runner 兜住（与 ADBRunner 内部拼 adb flag 同理）。
var llmFixedArgs = []string{
	"-p", "--output-format=stream-json", "--verbose",
	"--thinking", "enabled",
	"--permission-mode", "bypassPermissions",
}

// defaultLLMCLI 是 CLI 名缺省值（config.yaml 的 LLM_CLI 未设时使用）。
const defaultLLMCLI = "ducc"

// LLMConfig 是一次 LLM 调用的执行配置。System/Prompt 都是**终值文本**（已由 api 层
// 按 command.llm.system/prompt 指向的 param id 取出并 Expand），Runner 不再做变量替换。
type LLMConfig struct {
	CLI          string                // CLI 命令名，空则用 defaultLLMCLI
	SystemPrompt string                // 系统提示词，非空则作为 --append-system-prompt 的独立 argv
	Prompt       string                // 用户提示词，写入子进程 stdin
	Resume       string                // 非空则作为 --resume <sessionId> 续接上次会话
	Cwd          string                // 工作目录（空则继承父进程）
	Timeout      time.Duration         // 超时
	Env          map[string]string     // 额外环境变量
	Builtins     *builtinvars.Registry // 内置变量注册表，nil 时跳过该层查找（Cwd 已在构造时展开，此字段仅保持结构一致）
}

// LLMRunner 是 LLM 的一等执行形态（对标 ADBRunner）：自己构 argv 调 CLI，
// 解析 stream-json，只把 assistant 的 text/thinking 增量 emit 为 "llm"/"llm-thinking"；
// Result.Stdout 只放 assistant text（供 workflow 的 if 表达式判断回答内容）。
//
// 关键收益：system prompt 作为**独立 argv** 传给子进程，不经 sh -c / PowerShell 字符串，
// 因此多行、含引号、含 $ 的内容零转义风险；prompt 走 stdin 同理。
type LLMRunner struct {
	Cfg LLMConfig
}

// Run 执行 LLM CLI，流式解析 stream-json 并推送。params 只用于 env 注入（供 CLI 内部读），
// 不参与 System/Prompt 的替换——它们进来时已是终值。
func (r *LLMRunner) Run(ctx context.Context, params map[string]any, emit EmitFunc) Result {
	start := time.Now()

	cfg := r.Cfg
	if cfg.Prompt == "" {
		err := fmt.Errorf("command.llm: prompt 为空（检查 llm.prompt 指向的 param 是否已填）")
		if emit != nil {
			emit("stderr", err.Error())
		}
		return Result{ExitCode: -1, Err: err, Duration: time.Since(start),
			Outputs: map[string]string{"exit_code": "-1", "success": "false"}}
	}

	cmd := buildLLMCommand(cfg)
	cmd.Stdin = strings.NewReader(cfg.Prompt)
	hideWindow(cmd) // Windows 上不弹控制台黑框
	setPgid(cmd)    // Unix: 新进程组，cancel 时杀整组
	if cfg.Cwd != "" {
		cmd.Dir = cfg.Cwd
	}
	cmd.Env = buildEnv(params, cfg.Env)

	var textBuf, thinkingBuf strings.Builder
	outputs := map[string]string{}

	outcome := Run(ctx, ExecRequest{Cmd: cmd, Timeout: cfg.Timeout}, func(stream, line string) {
		if stream == "stderr" {
			emit("stderr", line) // CLI 诊断信息，原样推前端，不进 Result
			return
		}
		recordStructuredFields(line, outputs)
		kind, delta, ok := parseLLMLine(line)
		if !ok {
			return
		}
		if kind == "thinking" {
			thinkingBuf.WriteString(delta)
			emit("llm-thinking", delta)
		} else if kind == "tool_use" || kind == "tool_result" {
			// 工具调用对原样透传（delta 已是 JSON），不进 buffers——只供聊天页工序段展示
			emit("llm-tool", delta)
		} else {
			textBuf.WriteString(delta)
			emit("llm", delta)
		}
	})

	if textBuf.Len() > 0 {
		outputs["text"] = textBuf.String()
	}
	if thinkingBuf.Len() > 0 {
		outputs["thinking"] = thinkingBuf.String()
	}

	stdout := textBuf.String()
	return Result{
		ExitCode: outcome.ExitCode, Err: outcome.Err, Duration: outcome.Duration,
		Stdout: stdout, Outputs: finalizeOutputs(outputs, outcome.ExitCode, stdout, ""),
	}
}

// buildLLMCommand 拼 argv：<CLI> <固定flags...> [--resume <id>] [--append-system-prompt <system>]。
// 不经 shell，故 system 里的引号/换行/$ 都原样抵达子进程。
func buildLLMCommand(cfg LLMConfig) *exec.Cmd {
	cli := cfg.CLI
	if cli == "" {
		cli = defaultLLMCLI
	}
	args := make([]string, 0, len(llmFixedArgs)+4)
	args = append(args, llmFixedArgs...)
	if cfg.Resume != "" {
		args = append(args, "--resume", cfg.Resume)
	}
	if cfg.SystemPrompt != "" {
		args = append(args, "--append-system-prompt", cfg.SystemPrompt)
	}
	return exec.Command(cli, args...)
}
