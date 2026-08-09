package adbcore

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"os/exec"
	"sync"
	"time"
)

// ExecRequest 是一次进程执行的入参。
type ExecRequest struct {
	Command string
	Args    []string
	Timeout time.Duration
}

// ExecResult 是进程执行的产物。
type ExecResult struct {
	Stdout   string        `json:"stdout"`
	Stderr   string        `json:"stderr"`
	ExitCode int           `json:"exitCode"`
	Duration time.Duration `json:"duration"`
}

// RunCommand 执行进程并捕获全部 stdout/stderr（超时由 req.Timeout 控制）。
func RunCommand(ctx context.Context, req ExecRequest) (*ExecResult, error) {
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}
	cmd := exec.Command(req.Command, req.Args...)
	configureChild(cmd)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	start := time.Now()
	err := cmd.Run()
	duration := time.Since(start)

	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			return nil, NewOperationError("exec", "failed to run process", err.Error(), true)
		}
	}
	return &ExecResult{
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		ExitCode: exitCode,
		Duration: duration,
	}, err
}

// RunCommandWithStdin 执行一个需要 stdin 输入的进程。
func RunCommandWithStdin(ctx context.Context, req ExecRequest, stdin string) (*ExecResult, error) {
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}
	cmd := exec.Command(req.Command, req.Args...)
	configureChild(cmd)
	cmd.Stdin = bytes.NewBufferString(stdin)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	start := time.Now()
	err := cmd.Run()
	duration := time.Since(start)

	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			return nil, NewOperationError("exec", "failed to run process", err.Error(), true)
		}
	}
	return &ExecResult{
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		ExitCode: exitCode,
		Duration: duration,
	}, err
}

// StreamingRequest 扩展 ExecRequest，提供逐行回调。
// Capture=false 时不缓存（适合 logcat/进度这类长流，避免内存膨胀）。
type StreamingRequest struct {
	Command string
	Args    []string
	Timeout time.Duration
	Capture bool // true=把 stdout/stderr 全量缓存进 ExecResult
	OnLine  func(stream, line string)
}

// RunStreaming 启动进程并逐行流式回调（\n 与 \r 都切行，适配 adb 进度刷新）。
// 超时/取消时杀整个进程组。Capture 控制是否同时缓存全量输出。
func RunStreaming(ctx context.Context, req StreamingRequest) (*ExecResult, error) {
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	cmd := exec.Command(req.Command, req.Args...)
	configureChild(cmd)

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, NewOperationError("exec", "failed to create stdout pipe", err.Error(), true)
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return nil, NewOperationError("exec", "failed to create stderr pipe", err.Error(), true)
	}
	if err := cmd.Start(); err != nil {
		return nil, NewOperationError("exec", "failed to start process", err.Error(), true)
	}

	start := time.Now()
	var stdoutBuf, stderrBuf bytes.Buffer
	var bufMu sync.Mutex
	var wg sync.WaitGroup

	scan := func(r io.Reader, stream string, buf *bytes.Buffer) {
		defer wg.Done()
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		sc.Split(scanProgressLines)
		for sc.Scan() {
			line := sc.Text()
			if req.Capture {
				bufMu.Lock()
				buf.WriteString(line)
				buf.WriteByte('\n')
				bufMu.Unlock()
			}
			if req.OnLine != nil {
				req.OnLine(stream, line)
			}
		}
	}
	wg.Add(2)
	go scan(stdoutPipe, "stdout", &stdoutBuf)
	go scan(stderrPipe, "stderr", &stderrBuf)

	waitCh := make(chan error, 1)
	go func() {
		wg.Wait()
		waitCh <- cmd.Wait()
	}()

	select {
	case <-ctx.Done():
		killGroup(cmd)
		<-waitCh
		return nil, ctx.Err()
	case werr := <-waitCh:
		exitCode := 0
		if werr != nil {
			if ee, ok := werr.(*exec.ExitError); ok {
				exitCode = ee.ExitCode()
			} else {
				return nil, NewOperationError("exec", "process wait failed", werr.Error(), true)
			}
		}
		return &ExecResult{
			Stdout:   stdoutBuf.String(),
			Stderr:   stderrBuf.String(),
			ExitCode: exitCode,
			Duration: time.Since(start),
		}, werr
	}
}

// scanProgressLines 同时以 \n 与 \r 作为行结束（adb 用 \r 刷新进度条）。
func scanProgressLines(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	for i, b := range data {
		if b == '\n' || b == '\r' {
			return i + 1, data[:i], nil
		}
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}
