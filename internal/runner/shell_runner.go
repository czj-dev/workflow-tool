package runner

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"time"

	"workflow-tool/internal/builtinvars"
)

// ShellConfig 是已解析、待执行的命令配置。
type ShellConfig struct {
	Shell         string                // 内联命令（与 Script 二选一）
	Script        string                // 脚本路径不含扩展名（与 Shell 二选一）
	Cwd           string                // 工作目录（必须存在）
	Timeout       time.Duration         // 超时
	Env           map[string]string     // 额外环境变量
	BaseDir       string                // exe 目录，用于解析相对 script 路径
	CaptureOutput *bool                 // nil 或指向 true = 捕获全量 stdout/stderr 供 outputs 使用；指向 false = 关闭（长跑/持续输出 action 用）
	Builtins      *builtinvars.Registry // 内置变量注册表（CURRENT_DATE/CURRENT_TIME/ADB_SERIAL），nil 时跳过该层查找
}

// ShellRunner 执行单条 shell 命令或脚本文件，流式输出。
type ShellRunner struct {
	Cfg ShellConfig
}

// Run 执行配置的命令，通过 emit 流式推送输出。
func (r *ShellRunner) Run(ctx context.Context, params map[string]any, emit EmitFunc) Result {
	start := time.Now()

	cfg := r.Cfg

	// Phase 3：所有 Runner 实现都用 params 替换 ${VAR}（params > 内置变量 > env，未定义保留+warning）
	cfg.Shell = Expand(ctx, cfg.Shell, params, cfg.Builtins)
	cfg.Script = Expand(ctx, cfg.Script, params, cfg.Builtins)
	cfg.Cwd = Expand(ctx, cfg.Cwd, params, cfg.Builtins)
	cfg.Env = ExpandMap(ctx, cfg.Env, params, cfg.Builtins)

	cmd, err := buildCommandFromCfg(cfg)
	if err != nil {
		return Result{Err: err, Duration: time.Since(start)}
	}
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

// buildCommandFromCfg 按 Shell/Script 和 OS 构造 exec.Cmd。
func buildCommandFromCfg(cfg ShellConfig) (*exec.Cmd, error) {
	if cfg.Shell == "" && cfg.Script == "" {
		return nil, fmt.Errorf("command: shell 和 script 必须二选一")
	}
	if cfg.Shell != "" && cfg.Script != "" {
		return nil, fmt.Errorf("command: shell 和 script 互斥")
	}
	if runtime.GOOS == "windows" {
		if cfg.Shell != "" {
			// Windows 默认用 PowerShell（引号与 ${VAR} 传递比 cmd /c 可靠）；优先 pwsh 7，回退 Windows PowerShell
			if path, err := exec.LookPath("pwsh"); err == nil {
				return exec.Command(path, "-NoProfile", "-Command", cfg.Shell), nil
			}
			return exec.Command("powershell", "-NoProfile", "-Command", cfg.Shell), nil
		}
		script, err := resolveScript(cfg.Script, ".ps1", cfg.BaseDir)
		if err != nil {
			return nil, err
		}
		if path, err := exec.LookPath("pwsh"); err == nil {
			return exec.Command(path, "-NoProfile", "-File", script), nil
		}
		return exec.Command("powershell", "-NoProfile", "-File", script), nil
	}
	if cfg.Shell != "" {
		return exec.Command("sh", "-c", cfg.Shell), nil
	}
	script, err := resolveScript(cfg.Script, ".sh", cfg.BaseDir)
	if err != nil {
		return nil, err
	}
	return exec.Command("sh", script), nil
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
