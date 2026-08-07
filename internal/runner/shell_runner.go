package runner

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// ShellConfig 是已解析、待执行的命令配置。
type ShellConfig struct {
	Shell         string            // 内联命令（与 Script 二选一）
	Script        string            // 脚本路径不含扩展名（与 Shell 二选一）
	Cwd           string            // 工作目录（必须存在）
	Timeout       time.Duration     // 超时
	Env           map[string]string // 额外环境变量
	BaseDir       string            // exe 目录，用于解析相对 script 路径
	Stream        string            // "" 普通逐行；"llm" 走 pumpLLM 解析 stream-json
	CaptureOutput *bool             // nil 或指向 true = 捕获全量 stdout/stderr 供 outputs 使用；指向 false = 关闭（长跑/持续输出 action 用）
}

// ShellRunner 执行单条 shell 命令或脚本文件，流式输出。
type ShellRunner struct {
	Cfg ShellConfig
}

// Run 执行配置的命令，通过 emit 流式推送输出。
func (r *ShellRunner) Run(ctx context.Context, params map[string]any, emit EmitFunc) Result {
	start := time.Now()
	timeoutCtx, cancel := context.WithTimeout(ctx, r.Cfg.Timeout)
	defer cancel()

	// Phase 3：所有 Runner 实现都用 params 替换 ${VAR}（params>env，未定义保留+warning）
	cfg := r.Cfg
	cfg.Shell = Expand(cfg.Shell, params)
	cfg.Script = Expand(cfg.Script, params)
	cfg.Cwd = Expand(cfg.Cwd, params)
	cfg.Env = ExpandMap(cfg.Env, params)

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

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return Result{Err: fmt.Errorf("stdout pipe: %w", err), Duration: time.Since(start)}
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return Result{Err: fmt.Errorf("stderr pipe: %w", err), Duration: time.Since(start)}
	}

	if err := cmd.Start(); err != nil {
		return Result{Err: fmt.Errorf("start: %w", err), Duration: time.Since(start)}
	}

	captureOn := cfg.CaptureOutput == nil || *cfg.CaptureOutput
	var stdoutBuf, stderrBuf *strings.Builder
	outputs := map[string]string{}
	if captureOn {
		stdoutBuf = &strings.Builder{}
		stderrBuf = &strings.Builder{}
	}

	doneOut := make(chan struct{})
	doneErr := make(chan struct{})
	if cfg.Stream == "llm" {
		go pumpLLM(stdoutPipe, emit, doneOut, outputs)
	} else {
		go pump(stdoutPipe, "stdout", emit, doneOut, stdoutBuf, outputs)
	}
	go pump(stderrPipe, "stderr", emit, doneErr, stderrBuf, nil)

	waitCh := make(chan error, 1)
	go func() {
		<-doneOut
		<-doneErr
		waitCh <- cmd.Wait()
	}()

	select {
	case <-timeoutCtx.Done():
		killGroup(cmd) // ponytail: 杀进程组而非单进程，否则 sh -c 的子进程(如 adb logcat)残留
		<-waitCh
		exitCode := -1
		stdout, stderr := bufString(stdoutBuf), bufString(stderrBuf)
		return Result{
			ExitCode: exitCode, Err: timeoutCtx.Err(), Duration: time.Since(start),
			Stdout: stdout, Stderr: stderr, Outputs: finalizeOutputs(outputs, exitCode, stdout, stderr),
		}
	case werr := <-waitCh:
		exitCode := 0
		if werr != nil {
			if ee, ok := werr.(*exec.ExitError); ok {
				exitCode = ee.ExitCode()
			} else {
				return Result{Err: fmt.Errorf("wait: %w", werr), Duration: time.Since(start)}
			}
		}
		stdout, stderr := bufString(stdoutBuf), bufString(stderrBuf)
		return Result{
			ExitCode: exitCode, Duration: time.Since(start),
			Stdout: stdout, Stderr: stderr, Outputs: finalizeOutputs(outputs, exitCode, stdout, stderr),
		}
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

// pump 逐行读取 r 并 emit；buf 非 nil 时同时把整行 append 进 buf，
// outputs 非 nil 时对每行尝试解析 ##[output key=value] 协议写入 outputs。
func pump(r io.Reader, stream string, emit EmitFunc, done chan<- struct{}, buf *strings.Builder, outputs map[string]string) {
	defer close(done)
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := stripANSI(sc.Text())
		emit(stream, line)
		if buf != nil {
			buf.WriteString(line)
			buf.WriteString("\n")
		}
		if outputs != nil {
			if key, value, ok := parseOutputLine(line); ok {
				outputs[key] = value
			}
		}
	}
}

// bufString 返回 buf 内容；buf 为 nil（capture_output=false）时返回空字符串。
func bufString(buf *strings.Builder) string {
	if buf == nil {
		return ""
	}
	return buf.String()
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
