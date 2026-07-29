package runner

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os/exec"
	"runtime"
	"time"
)

// ShellConfig 是已解析、待执行的命令配置。
type ShellConfig struct {
	Shell   string            // 内联命令（与 Script 二选一）
	Script  string            // 脚本路径不含扩展名（与 Shell 二选一）
	Cwd     string            // 工作目录（必须存在）
	Timeout time.Duration     // 超时
	Env     map[string]string // 额外环境变量
	BaseDir string            // exe 目录，用于解析相对 script 路径
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
	if cfg.Cwd != "" {
		cmd.Dir = cfg.Cwd
	}
	for k, v := range cfg.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}

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

	doneOut := make(chan struct{})
	doneErr := make(chan struct{})
	go pump(stdoutPipe, "stdout", emit, doneOut)
	go pump(stderrPipe, "stderr", emit, doneErr)

	waitCh := make(chan error, 1)
	go func() {
		<-doneOut
		<-doneErr
		waitCh <- cmd.Wait()
	}()

	select {
	case <-timeoutCtx.Done():
		_ = cmd.Process.Kill()
		<-waitCh
		return Result{ExitCode: -1, Err: timeoutCtx.Err(), Duration: time.Since(start)}
	case werr := <-waitCh:
		exitCode := 0
		if werr != nil {
			if ee, ok := werr.(*exec.ExitError); ok {
				exitCode = ee.ExitCode()
			} else {
				return Result{Err: fmt.Errorf("wait: %w", werr), Duration: time.Since(start)}
			}
		}
		return Result{ExitCode: exitCode, Duration: time.Since(start)}
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
			return exec.Command("cmd", "/c", cfg.Shell), nil
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

// pump 逐行读取 r 并 emit。
func pump(r io.Reader, stream string, emit EmitFunc, done chan<- struct{}) {
	defer close(done)
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		emit(stream, sc.Text())
	}
}
