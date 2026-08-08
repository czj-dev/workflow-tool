package runner

import (
	"context"
	"strings"
	"time"
)

// LLMConfig 是 LLM action 的执行配置（与 ShellConfig 字段一致）。
type LLMConfig = ShellConfig

// LLMRunner 执行 claude CLI 命令，解析 stream-json，只把 assistant 的
// text/thinking 增量 emit 为 "llm"/"llm-thinking"；Result.Stdout 只放
// assistant text（供 if 表达式判断 LLM 回答内容，如 outputs.ask.stdout contains "重试"）。
type LLMRunner struct {
	Cfg LLMConfig
}

// Run 执行配置的 claude 命令，流式解析 stream-json 并推送。
func (r *LLMRunner) Run(ctx context.Context, params map[string]any, emit EmitFunc) Result {
	start := time.Now()

	cfg := r.Cfg
	cfg.Shell = Expand(cfg.Shell, params)
	cfg.Script = Expand(cfg.Script, params)
	cfg.Cwd = Expand(cfg.Cwd, params)
	cfg.Env = ExpandMap(cfg.Env, params)

	cmd, err := buildCommandFromCfg(cfg)
	if err != nil {
		return Result{Err: err, Duration: time.Since(start)}
	}
	hideWindow(cmd)
	setPgid(cmd)
	if cfg.Cwd != "" {
		cmd.Dir = cfg.Cwd
	}
	cmd.Env = buildEnv(params, cfg.Env)

	var textBuf, thinkingBuf strings.Builder
	outputs := map[string]string{}

	outcome := Run(ctx, ExecRequest{Cmd: cmd, Timeout: cfg.Timeout}, func(stream, line string) {
		if stream == "stderr" {
			emit("stderr", line) // claude 诊断信息，原样推前端，不进 Result
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
