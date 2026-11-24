package runner

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"time"
)

// aiFixedArgs 是所有 AI 运行共用的固定 flag：
//   - -p / --output-format=stream-json / --verbose：headless 打印 + stream-json 流式
//   - --thinking enabled：附带思考过程增量
//   - --permission-mode bypassPermissions：无人值守没有交互通道，遇工具/权限询问会直接
//     失败退出，必须启动时声明「不问」（ADR-0007：所有 AI 运行固定 bypass，不新增审批机制）。
//
// 任务在 YAML 里不写任何 CLI flag，全部由 Runner 兜住（与 ADBRunner 内部拼 adb flag 同理）。
var aiFixedArgs = []string{
	"-p", "--output-format=stream-json", "--verbose",
	"--thinking", "enabled",
	"--permission-mode", "bypassPermissions",
}

// DefaultAICLI 是 CLI 名缺省值（config.yaml 的 AI_CLI 未设时使用）。
const DefaultAICLI = "ducc"

// AIConfig 是一次 AI 运行的执行配置。Rules、SystemPrompt、Prompt 都是**终值文本**
// （已由 airun.Build 展开），Runner 不再做变量替换。
type AIConfig struct {
	CLI          string            // CLI 命令名，空则用 DefaultAICLI
	Rules        string            // 无人值守守则全文（airun.LoadRules 读取）
	SystemPrompt string            // 任务的 system（角色与纪律），可为空
	Prompt       string            // 用户提示词，写入子进程 stdin
	Resume       string            // 非空则作为 --resume <sessionId> 续接上次会话
	Cwd          string            // 工作目录（空则继承父进程）
	Timeout      time.Duration     // 超时
	Env          map[string]string // 额外环境变量（任务 env + workflow/step 注入）
	// Inputs 是进入子进程 env 的变量源（config.yaml + 已声明的输入），供 CLI 内部读。
	// 保留运行参数 prompt/system/resume 不在其中：大段提示词不该进子进程环境。
	Inputs map[string]any
	// SkillSyncReport 是 Build 层注入的 [skill-sync] 报告行，Run 开头最先以
	// stdout 流 emit（进输出面板）；不经 CLI 输出解析，不进 Result.Stdout。
	SkillSyncReport []string
	// SkillSyncWarnings 是同步警告行（未知 CLI 回退、账本写失败），stderr 流。
	SkillSyncWarnings []string
}

// AIRunner 是 AI 任务的执行器（对标 ADBRunner）：自己构 argv 调 CLI，解析 stream-json，
// 只把 assistant 的 text/thinking 增量 emit 为 "ai"/"ai-thinking"，工具调用对 emit 为
// "ai-tool"；Result.Stdout 只放 assistant text（供 workflow 的 if 表达式判断回答内容）。
//
// 关键收益：系统提示作为**独立 argv** 传给子进程，不经 sh -c / PowerShell 字符串，
// 因此多行、含引号、含 $ 的内容零转义风险；prompt 走 stdin 同理。
type AIRunner struct {
	Cfg AIConfig
}

// Run 执行 AI CLI，流式解析 stream-json 并推送。
// 子进程 env 只取 cfg.Inputs；params 形参是为满足 Runner 接口而保留的，一律忽略——
// 这样调用方即使把含 prompt/system/resume 的原始参数传进来，它们也不会进子进程环境。
func (r *AIRunner) Run(ctx context.Context, _ map[string]any, emit EmitFunc) Result {
	start := time.Now()

	cfg := r.Cfg
	// skill 同步报告行/警告行先于一切失败路径 emit（Build 层注入，不经 CLI 输出解析）
	if emit != nil {
		for _, w := range cfg.SkillSyncWarnings {
			emit("stderr", w)
		}
		for _, l := range cfg.SkillSyncReport {
			emit("stdout", l)
		}
	}
	if strings.TrimSpace(cfg.Prompt) == "" {
		err := errors.New("AI 运行的提示词为空")
		if emit != nil {
			emit("stderr", err.Error())
		}
		return Result{ExitCode: -1, Err: err, Duration: time.Since(start),
			Outputs: map[string]string{"exit_code": "-1", "success": "false"}}
	}

	cmd := buildAICommand(cfg)
	cmd.Stdin = strings.NewReader(cfg.Prompt)
	hideWindow(cmd) // Windows 上不弹控制台黑框
	setPgid(cmd)    // Unix: 新进程组，cancel 时杀整组
	if cfg.Cwd != "" {
		cmd.Dir = cfg.Cwd
	}
	cmd.Env = buildEnv(cfg.Inputs, cfg.Env)

	var textBuf, thinkingBuf strings.Builder
	outputs := map[string]string{}

	outcome := Run(ctx, ExecRequest{Cmd: cmd, Timeout: cfg.Timeout}, func(stream, line string) {
		if stream == "stderr" {
			emit("stderr", line) // CLI 诊断信息，原样推前端，不进 Result
			return
		}
		recordStructuredFields(line, outputs)
		kind, delta, ok := parseAILine(line)
		if !ok {
			return
		}
		if kind == "thinking" {
			thinkingBuf.WriteString(delta)
			emit("ai-thinking", delta)
		} else if kind == "tool_use" || kind == "tool_result" {
			// 工具调用对原样透传（delta 已是 JSON），不进 buffers——只供聊天页工序段展示
			emit("ai-tool", delta)
		} else {
			textBuf.WriteString(delta)
			emit("ai", delta)
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

// buildAICommand 拼 argv：<CLI> <固定flags...> [--resume <id>] [--append-system-prompt <system>]。
// system 是守则与任务 system 合成的一段（见 joinSystemPrompt），只传一次。
// 不经 shell，故 system 里的引号/换行/$ 都原样抵达子进程。
func buildAICommand(cfg AIConfig) *exec.Cmd {
	cli := cfg.CLI
	if cli == "" {
		cli = DefaultAICLI
	}
	args := make([]string, 0, len(aiFixedArgs)+4)
	args = append(args, aiFixedArgs...)
	if cfg.Resume != "" {
		args = append(args, "--resume", cfg.Resume)
	}
	if system := joinSystemPrompt(cfg.Rules, cfg.SystemPrompt); system != "" {
		args = append(args, "--append-system-prompt", system)
	}
	return exec.Command(cli, args...)
}

// joinSystemPrompt 把无人值守守则与任务 system 合成一段：守则在前（所有任务通用的
// 纪律），任务 system 在后（角色与任务范围）。两者皆空时返回空串，不传该 flag。
func joinSystemPrompt(rules, system string) string {
	hasRules := strings.TrimSpace(rules) != ""
	hasSystem := strings.TrimSpace(system) != ""
	switch {
	case hasRules && hasSystem:
		return strings.TrimSpace(rules) + "\n\n" + system
	case hasRules:
		return rules
	default:
		return system
	}
}
