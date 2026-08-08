package runner

import (
	"bufio"
	"context"
	"io"
	"os/exec"
	"sync"
	"time"
)

// OnLine 是逐行回调；stream 为 "stdout" 或 "stderr"。
// 调用方（ShellRunner/LLMRunner）在回调里做自己的 buffer 累积和 emit。
// Run 保证同一时刻只有一个 goroutine 调用 onLine（stdout/stderr 内部已加锁互斥），
// 调用方无需自行加锁即可安全地累积到共享变量。
type OnLine func(stream, line string)

// ExecRequest 是一次进程执行的入参。
type ExecRequest struct {
	Cmd     *exec.Cmd
	Timeout time.Duration
}

// ExecOutcome 是进程执行的产物（不含 stdout/stderr 内容——由调用方在 onLine 里累积）。
type ExecOutcome struct {
	ExitCode int
	Err      error
	Duration time.Duration
}

// Run 启动 req.Cmd，stdout/stderr 按行回调 onLine（\n 与 \r 都切行，
// 修复 adb push/install 等 \r 刷新进度条的场景）；超时则杀整个进程组。
// hideWindow/setPgid 需由调用方在传入 req.Cmd 前完成（沿用现有跨平台实现）。
func Run(ctx context.Context, req ExecRequest, onLine OnLine) ExecOutcome {
	start := time.Now()
	timeoutCtx, cancel := context.WithTimeout(ctx, req.Timeout)
	defer cancel()

	cmd := req.Cmd
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return ExecOutcome{ExitCode: -1, Err: err, Duration: time.Since(start)}
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return ExecOutcome{ExitCode: -1, Err: err, Duration: time.Since(start)}
	}
	if err := cmd.Start(); err != nil {
		return ExecOutcome{ExitCode: -1, Err: err, Duration: time.Since(start)}
	}

	doneOut := make(chan struct{})
	doneErr := make(chan struct{})
	var mu sync.Mutex
	safeOnLine := func(stream, line string) {
		mu.Lock()
		defer mu.Unlock()
		onLine(stream, line)
	}
	go scanLines(stdoutPipe, "stdout", safeOnLine, doneOut)
	go scanLines(stderrPipe, "stderr", safeOnLine, doneErr)

	waitCh := make(chan error, 1)
	go func() {
		<-doneOut
		<-doneErr
		waitCh <- cmd.Wait()
	}()

	select {
	case <-timeoutCtx.Done():
		killGroup(cmd)
		<-waitCh
		return ExecOutcome{ExitCode: -1, Err: timeoutCtx.Err(), Duration: time.Since(start)}
	case werr := <-waitCh:
		exitCode := 0
		if werr != nil {
			if ee, ok := werr.(*exec.ExitError); ok {
				exitCode = ee.ExitCode()
			} else {
				return ExecOutcome{ExitCode: -1, Err: werr, Duration: time.Since(start)}
			}
		}
		return ExecOutcome{ExitCode: exitCode, Duration: time.Since(start)}
	}
}

// scanLines 用 bufio.Scanner 配 splitLines（\n 与 \r 都切行）逐行回调，并去除 ANSI 转义序列。
func scanLines(r io.Reader, stream string, onLine OnLine, done chan<- struct{}) {
	defer close(done)
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	sc.Split(splitLines)
	for sc.Scan() {
		onLine(stream, stripANSI(sc.Text()))
	}
}

// splitLines 是 bufio.SplitFunc：\n 或 \r 均视为行结束（adb push/install
// 等命令用 \r 刷新同一行显示进度，标准 bufio.ScanLines 只认 \n 会把整条进度流当一行）。
func splitLines(data []byte, atEOF bool) (advance int, token []byte, err error) {
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
