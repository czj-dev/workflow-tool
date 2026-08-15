//go:build !windows

package adbcore

import (
	"bufio"
	"bytes"
	"context"
	"os/exec"
	"regexp"
	"sync"
	"time"

	"github.com/creack/pty"
)

// ansiEscape 匹配 CSI 转义序列。adb 在 TTY 下用 \x1b[K（清到行尾）刷新进度条，
// 不剥掉会直接漏进 UI 文本。仅 PTY 路径需要（pipe 路径 adb 不输出转义）。
var ansiEscape = regexp.MustCompile(`\x1b\[[0-9;?]*[a-zA-Z]`)

// runStreamingPTY 用伪终端启动子进程：stdout 与 stderr 各挂一个独立 pty。
// adb push/pull 的 [NN%] 进度条写的是 **stderr**，且只在 isatty(stderr) 时才输出，
// 走管道完全静默（`script -q /dev/null bash -c 'adb push x y 2>&1 >/dev/null'` 可复现）。
// 两个 pty 而非合流一个：保留 stream=="stdout"/"stderr" 分流语义，
// file/transfer.go 靠它区分进度行与错误详情。
// 返回 ok=false 表示未运行（在 windows 上永远返回 false，让调用方回退到 pipe 版本）。
func runStreamingPTY(ctx context.Context, req StreamingRequest) (result *ExecResult, retErr error, ok bool) {
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	cmd := exec.Command(req.Command, req.Args...)
	configureChild(cmd)

	outPtmx, outTTY, err := pty.Open()
	if err != nil {
		return nil, NewOperationError("exec", "failed to open pty", err.Error(), true), true
	}
	defer outPtmx.Close()
	errPtmx, errTTY, err := pty.Open()
	if err != nil {
		outTTY.Close()
		return nil, NewOperationError("exec", "failed to open pty", err.Error(), true), true
	}
	defer errPtmx.Close()

	cmd.Stdin = outTTY
	cmd.Stdout = outTTY
	cmd.Stderr = errTTY

	if err := cmd.Start(); err != nil {
		outTTY.Close()
		errTTY.Close()
		return nil, NewOperationError("exec", "failed to start process", err.Error(), true), true
	}
	// 父进程侧关掉 tty 从端：子进程 exit 后 ptmx 读端才能收到 EOF
	outTTY.Close()
	errTTY.Close()

	start := time.Now()
	var stdoutBuf, stderrBuf bytes.Buffer
	var bufMu sync.Mutex
	var wg sync.WaitGroup

	scan := func(r interface {
		Read(p []byte) (int, error)
	}, stream string, buf *bytes.Buffer) {
		defer wg.Done()
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		sc.Split(scanProgressLines)
		for sc.Scan() {
			line := ansiEscape.ReplaceAllString(sc.Text(), "")
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
	go scan(outPtmx, "stdout", &stdoutBuf)
	go scan(errPtmx, "stderr", &stderrBuf)

	waitCh := make(chan error, 1)
	go func() {
		wg.Wait()
		waitCh <- cmd.Wait()
	}()

	select {
	case <-ctx.Done():
		killGroup(cmd)
		<-waitCh
		return nil, ctx.Err(), true
	case werr := <-waitCh:
		exitCode := 0
		if werr != nil {
			if ee, ok := werr.(*exec.ExitError); ok {
				exitCode = ee.ExitCode()
			} else {
				return nil, NewOperationError("exec", "process wait failed", werr.Error(), true), true
			}
		}
		return &ExecResult{
			Stdout:   stdoutBuf.String(),
			Stderr:   stderrBuf.String(),
			ExitCode: exitCode,
			Duration: time.Since(start),
		}, werr, true
	}
}
