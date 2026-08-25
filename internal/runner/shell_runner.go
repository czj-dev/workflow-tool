package runner

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"workflow-tool/internal/builtinvars"
)

// ShellConfig 是已解析、待执行的命令配置。
type ShellConfig struct {
	Run           string                // 内联命令（与 Script 二选一），执行时落临时脚本文件
	Shell         string                // 解释器逻辑名（空 = bash；内置名或含 {0} 的自定义模板）
	Script        string                // 脚本路径带扩展名（与 Run 二选一），按扩展名路由解释器
	Cwd           string                // 工作目录（必须存在）
	Timeout       time.Duration         // 超时
	Env           map[string]string     // 额外环境变量
	BaseDir       string                // exe 目录，用于解析相对 script 路径
	CaptureOutput *bool                 // nil 或指向 true = 捕获全量 stdout/stderr 供 outputs 使用；指向 false = 关闭（长跑/持续输出 action 用）
	Builtins      *builtinvars.Registry // 内置变量注册表（CURRENT_DATE/CURRENT_TIME/ADB_SERIAL），nil 时跳过该层查找
	BashPath      string                // config.yaml BASH_PATH 覆盖（bash/sh 解析级联第一优先），空则级联探测
}

// ShellRunner 执行单条 shell 命令或脚本文件，流式输出。
type ShellRunner struct {
	Cfg ShellConfig
}

// Run 执行配置的命令，通过 emit 流式推送输出。
func (r *ShellRunner) Run(ctx context.Context, params map[string]any, emit EmitFunc) Result {
	start := time.Now()

	cfg := r.Cfg

	// Phase 3：所有 Runner 实现都用 params 替换 ${VAR}（params > 内置变量 > env，未定义保留+warning）。
	// cfg.Env 的终值也纳入查找源（env > params，与 buildEnv 覆盖顺序对齐）：
	// PowerShell 的 ${VAR} 是 PS 变量语法读不到环境变量，Go 侧统一展开才能跨平台一致。
	cfg.Env = ExpandMap(ctx, cfg.Env, params, cfg.Builtins)
	lookup := params
	if len(cfg.Env) > 0 {
		lookup = make(map[string]any, len(params)+len(cfg.Env))
		for k, v := range params {
			lookup[k] = v
		}
		for k, v := range cfg.Env {
			lookup[k] = v
		}
	}
	cfg.Run = Expand(ctx, cfg.Run, lookup, cfg.Builtins)
	cfg.Script = Expand(ctx, cfg.Script, lookup, cfg.Builtins)
	cfg.Cwd = Expand(ctx, cfg.Cwd, lookup, cfg.Builtins)

	cmd, cleanup, err := buildCommandFromCfg(cfg)
	if err != nil {
		return Result{Err: err, Duration: time.Since(start)}
	}
	defer cleanup()
	hideWindow(cmd) // Windows 上隐藏子进程控制台窗口（action 执行不再弹黑框）；非 Windows 空操作
	setPgid(cmd)    // Unix: 新进程组，cancel 时杀整组（含子进程）；Windows: 空操作
	if cfg.Cwd != "" {
		cmd.Dir = cfg.Cwd
	}
	// 子进程环境变量：父进程 env + params（全局+动作参数，供脚本内部 $env:VAR 读）+ 动作 env
	cmd.Env = buildEnv(params, cfg.Env)

	captureOn := cfg.CaptureOutput == nil || *cfg.CaptureOutput
	var stdoutBuf, stderrBuf *capBuffer
	outputs := map[string]string{}
	if captureOn {
		stdoutBuf = newCapBuffer(maxCaptureBytes)
		stderrBuf = newCapBuffer(maxCaptureBytes)
	}

	outcome := Run(ctx, ExecRequest{Cmd: cmd, Timeout: cfg.Timeout}, func(stream, line string) {
		if stream == "stdout" {
			// ##[progress ...] 改走 progress 流（前端原地覆盖上一条），不进 stdout 捕获
			if text, ok := parseProgressLine(line); ok {
				emit("progress", text)
				return
			}
		}
		emit(stream, line)
		if stream == "stdout" {
			stdoutBuf.WriteLine(line)
			if key, value, ok := parseOutputLine(line); ok {
				outputs[key] = value
			}
		} else {
			stderrBuf.WriteLine(line)
		}
	})

	stdout, stderr := stdoutBuf.String(), stderrBuf.String()
	return Result{
		ExitCode: outcome.ExitCode, Err: outcome.Err, Duration: outcome.Duration,
		Stdout: stdout, Stderr: stderr, Outputs: finalizeOutputs(outputs, outcome.ExitCode, stdout, stderr),
	}
}

// buildCommandFromCfg 按 Run/Script 与 ShellSpec 构造 exec.Cmd（GHA 语义）。
// Run 落临时脚本文件（返回 cleanup 供调用方 defer 删除）；Script 直接用真实路径，
// 解释器默认按扩展名路由、cfg.Shell 显式指定时以指定为准。
func buildCommandFromCfg(cfg ShellConfig) (*exec.Cmd, func(), error) {
	if cfg.Run == "" && cfg.Script == "" {
		return nil, nil, fmt.Errorf("command: run 和 script 必须二选一")
	}
	if cfg.Run != "" && cfg.Script != "" {
		return nil, nil, fmt.Errorf("command: run 和 script 互斥")
	}
	var spec ShellSpec
	var scriptPath string
	cleanup := func() {}
	if cfg.Run != "" {
		var err error
		spec, err = LookupShellSpec(cfg.Shell)
		if err != nil {
			return nil, nil, err
		}
		scriptPath, cleanup, err = writeRunScript(spec, cfg.Run)
		if err != nil {
			return nil, nil, err
		}
	} else {
		name := cfg.Shell
		if name == "" {
			var err error
			if name, err = ShellNameByScript(cfg.Script); err != nil {
				return nil, nil, err
			}
		}
		var err error
		if spec, err = LookupShellSpec(name); err != nil {
			return nil, nil, err
		}
		if scriptPath, err = resolveScriptPath(cfg.Script, cfg.BaseDir); err != nil {
			return nil, nil, err
		}
	}
	argv := expandTemplate(spec.Template, scriptPath)
	exe, err := resolveInterpreter(argv[0], cfg.BashPath)
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	return exec.Command(exe, argv[1:]...), cleanup, nil
}

// expandTemplate 把 argv 模板里的 {0} 替换为脚本路径（每个元素至多替换一次）。
func expandTemplate(template []string, scriptPath string) []string {
	argv := make([]string, len(template))
	for i, a := range template {
		argv[i] = strings.Replace(a, scriptPlaceholder, scriptPath, 1)
	}
	return argv
}

// buildEnv 构造子进程环境变量：父进程 env + params（全局配置 + 动作参数，供脚本内部
// $env:VAR / ${VAR} 读取）+ 动作 env。三者同名时后者覆盖前者（动作 env > params > 父 env）。
func buildEnv(params map[string]any, cfgEnv map[string]string) []string {
	env := os.Environ()
	for k, v := range params {
		env = append(env, k+"="+fmt.Sprint(v))
	}
	for k, v := range cfgEnv {
		env = append(env, k+"="+v)
	}
	return env
}

// finalizeOutputs 补齐通用 Layer 1 outputs：exit_code/stdout/stderr/success。
// 协议行已提前写入 outputs，若与 reserved key 同名则协议值优先（不覆盖回退）。
func finalizeOutputs(outputs map[string]string, exitCode int, stdout, stderr string) map[string]string {
	if _, ok := outputs["exit_code"]; !ok {
		outputs["exit_code"] = fmt.Sprint(exitCode)
	}
	if _, ok := outputs["stdout"]; !ok {
		outputs["stdout"] = stdout
	}
	if _, ok := outputs["stderr"]; !ok {
		outputs["stderr"] = stderr
	}
	if _, ok := outputs["success"]; !ok {
		outputs["success"] = fmt.Sprint(exitCode == 0)
	}
	return outputs
}
