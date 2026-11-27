package runner

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"time"
)

// piProviderPrefix 是 pi_setup.go 写入 models.json 的固定自定义 provider id，
// --model 引用其下模型时须带该前缀。
const piProviderPrefix = "workflow-tool/"

// AIConfig 是一次 pi 运行的执行配置。Rules、SystemPrompt、Prompt 都是**终值文本**
// （已由 airun.Build 展开），Runner 不再做变量替换；PiBin / Model / AgentDir /
// SessionDir 同为 Build 层解析后的终值（airun 的 resolvePiBin 与三键校验产出）。
type AIConfig struct {
	PiBin        string            // pi 可执行路径（AI_PI_BIN > <BaseDir>/pi/pi > PATH）
	Model        string            // 模型 id（config.yaml AI_MODEL，argv 带 provider 前缀）
	Rules        string            // 无人值守守则全文（airun.LoadRules 读取）
	SystemPrompt string            // 任务的 system（角色与纪律），可为空
	Prompt       string            // 用户提示词，写入子进程 stdin
	Resume       string            // 非空则作为 --session <sessionId> 续接上次会话
	Cwd          string            // 工作目录（空则继承父进程）
	Timeout      time.Duration     // 超时
	Env          map[string]string // 额外环境变量（任务 env + workflow/step 注入）
	// Inputs 是进入子进程 env 的变量源（config.yaml + 已声明的输入），供 pi 经
	// models.json 的 ${AI_AUTH_KEY} 插值在请求时读取。保留运行参数 prompt/system/resume
	// 不在其中：大段提示词不该进子进程环境。
	Inputs map[string]any
	// SkillDirs 是任务绑定的 skill 源目录（零拷贝，--skill <dir> 直读，不复制）。
	SkillDirs []string
	// AgentDir 是 hermetic agent 目录（<BaseDir>/pi-agent，Build 负责建目录与写
	// models.json）：pi 没有 CLI flag，官方机制是 env PI_CODING_AGENT_DIR
	//（configuration.md），由 Run 注入子进程环境，用户自己的 ~/.pi 不生效。
	AgentDir string
	// SessionDir 是 hermetic 会话目录（<BaseDir>/pi-sessions，--session-dir argv）。
	SessionDir string
	// SkillReport 是 Build 层注入的 [skill] 报告行，Run 开头最先以 stdout 流 emit
	//（进输出面板）；不经 pi 输出解析，不进 Result.Stdout。
	SkillReport []string
	// BuildWarnings 是 Build 层前置警告行（如 config.yaml 残留 AI_CLI 的提示），
	// stderr 流，与 SkillReport 同时机最先 emit。
	BuildWarnings []string
}

// AIRunner 是 AI 任务的执行器（对标 ADBRunner）：自己拼 argv 调 pi（唯一 AI 运行器），
// 逐行解析 pi 的 JSONL 事件流（pi_events.go），把 assistant 的 text / thinking 增量
// emit 为 "ai" / "ai-thinking"，工具调用对 emit 为 "ai-tool"；Result.Stdout 只放
// run 级累计的 assistant text（供 workflow 的 if 表达式判断回答内容）。
//
// 关键收益：系统提示作为**独立 argv** 传给子进程，不经 sh -c / PowerShell 字符串，
// 因此多行、含引号、含 $ 的内容零转义风险；prompt 走 stdin 同理。
type AIRunner struct {
	Cfg AIConfig
}

// Run 执行 pi，流式解析事件并推送。
// 子进程 env 取 cfg.Inputs + cfg.Env（AgentDir 另映射 PI_CODING_AGENT_DIR）；params
// 形参是为了满足 Runner 接口而保留的，一律忽略——这样调用方即使把含
// prompt/system/resume 的原始参数传进来，它们也不会进子进程环境。
func (r *AIRunner) Run(ctx context.Context, _ map[string]any, emit EmitFunc) Result {
	start := time.Now()

	cfg := r.Cfg
	// Build 层前置行先于一切失败路径 emit（skill 报告 / 配置警告），不经 pi 输出解析
	if emit != nil {
		for _, w := range cfg.BuildWarnings {
			emit("stderr", w)
		}
		for _, l := range cfg.SkillReport {
			emit("stdout", l)
		}
	}
	if err := piPreflight(cfg); err != nil {
		if emit != nil {
			emit("stderr", err.Error())
		}
		return Result{ExitCode: -1, Err: err, Duration: time.Since(start),
			Outputs: map[string]string{"exit_code": "-1", "success": "false"}}
	}

	cmd := buildPICommand(cfg)
	cmd.Stdin = strings.NewReader(cfg.Prompt)
	hideWindow(cmd) // Windows 上不弹控制台黑框
	setPgid(cmd)    // Unix: 新进程组，cancel 时杀整组
	if cfg.Cwd != "" {
		cmd.Dir = cfg.Cwd
	}
	cmd.Env = piEnv(cfg)

	p := newPiEventParser()
	outputs := map[string]string{}

	outcome := Run(ctx, ExecRequest{Cmd: cmd, Timeout: cfg.Timeout}, func(stream, line string) {
		if stream == "stderr" {
			if emit != nil {
				emit("stderr", line) // pi 诊断信息，原样推前端，不进 Result
			}
			return
		}
		p.feed(line, emit)
	})

	p.writeOutputs(outputs)
	stdout := p.text()
	if stdout != "" {
		outputs["text"] = stdout
	}
	if th := p.thinking(); th != "" {
		outputs["thinking"] = th
	}

	// 失败语义（设计 §3）：pi 的模型层失败不产生非零退出码（阶段 0 实测：网关 503
	// 时 pi exit 0，errorMessage 携带完整文案），流内 error/aborted 才是真相——
	// exit 0 + 流内失败 → 判失败（workflow executor 靠 ExitCode 判定步骤成败），
	// 文案同时推到 stderr 让前端诊断面板可见。进程自身错误（超时/取消/启动失败）
	// 优先于流内判定。
	exitCode, err := outcome.ExitCode, outcome.Err
	if err == nil {
		if msg, bad := p.streamError(); bad {
			err = errors.New(msg)
			exitCode = -1
			if emit != nil {
				emit("stderr", msg)
			}
		}
	}

	return Result{
		ExitCode: exitCode, Err: err, Duration: outcome.Duration,
		Stdout: stdout, Outputs: finalizeOutputs(outputs, exitCode, stdout, ""),
	}
}

// piPreflight 前置校验（不启动子进程）：提示词、pi 可执行路径、模型三缺一早失败。
// 三键齐不齐由 Build 层校验；这里兜的是 Build 缺位或字段被误清空的情况。
func piPreflight(cfg AIConfig) error {
	if strings.TrimSpace(cfg.Prompt) == "" {
		return errors.New("AI 运行的提示词为空")
	}
	if cfg.PiBin == "" {
		return errors.New("pi 可执行路径为空（AI_PI_BIN / <BaseDir>/pi/pi / PATH 均未解析到）")
	}
	if cfg.Model == "" {
		return errors.New("AI 运行缺少模型配置（config.yaml AI_MODEL）")
	}
	return nil
}

// buildPICommand 拼 argv（设计 §1，阶段 0 已用真实端点验证）：
//
//	pi --mode json --offline --no-approve --session-dir <dir> --no-skills
//	   [--skill <src> ...] --model workflow-tool/<Model>
//	   [--session <resume id>] [--append-system-prompt <system>]
//
// system 是守则与任务 system 合成的一段（见 joinSystemPrompt），只传一次。不经
// shell，故 system 里的引号/换行/$ 都原样抵达子进程。--no-skills 恒传：只加载
// --skill 显式目录，不捡 cwd 祖先链上的意外内容；--no-approve 忽略信任门控的
// 项目本地配置与资源，hermetic 且不影响内置工具执行（ADR-0007：无人值守无审批）。
func buildPICommand(cfg AIConfig) *exec.Cmd {
	args := make([]string, 0, 16)
	args = append(args, "--mode", "json", "--offline", "--no-approve")
	if cfg.SessionDir != "" {
		args = append(args, "--session-dir", cfg.SessionDir)
	}
	args = append(args, "--no-skills")
	for _, dir := range cfg.SkillDirs {
		if dir != "" {
			args = append(args, "--skill", dir)
		}
	}
	if cfg.Model != "" {
		args = append(args, "--model", piProviderPrefix+cfg.Model)
	}
	if cfg.Resume != "" {
		args = append(args, "--session", cfg.Resume)
	}
	if system := joinSystemPrompt(cfg.Rules, cfg.SystemPrompt); system != "" {
		args = append(args, "--append-system-prompt", system)
	}
	return exec.Command(cfg.PiBin, args...)
}

// piEnv 构造子进程 env：通用 buildEnv（父 env + Inputs + cfg.Env）之上把 hermetic
// agent 目录映射为 PI_CODING_AGENT_DIR。复制 cfg.Env 后写入，不污染调用方的映射；
// AgentDir 为空时不注入（共享的 buildEnv 保持零改动）。
func piEnv(cfg AIConfig) []string {
	if cfg.AgentDir == "" {
		return buildEnv(cfg.Inputs, cfg.Env)
	}
	merged := make(map[string]string, len(cfg.Env)+1)
	for k, v := range cfg.Env {
		merged[k] = v
	}
	merged["PI_CODING_AGENT_DIR"] = cfg.AgentDir
	return buildEnv(cfg.Inputs, merged)
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
