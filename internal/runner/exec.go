package runner

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"
)

// OnLine 是逐行回调；stream 为 "stdout" 或 "stderr"。
// 调用方（ShellRunner/AIRunner）在回调里做自己的 buffer 累积和 emit。
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
		// 组长恰好正在 fork 时被杀：SIGKILL 打断不了进行中的 fork，刚出世的孩子诞生在内核
		// 遍历进程组之后，躲过这一次组杀，握着管道不松手——Run 就永远等不到扫描结束。
		// 管道没在 killSettleDelay 内关闭就按进程组再补杀一次（组长已死无妨，孤儿进程仍在
		// 原来的组里）。
		timer := time.NewTimer(killSettleDelay)
		select {
		case <-waitCh:
			timer.Stop()
		case <-timer.C:
			killGroup(cmd)
			<-waitCh
		}
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

// killSettleDelay 是组杀之后等管道关闭的时长：正常情况下进程一死扫描立刻结束，
// 只有躲过组杀的孤儿子进程才会让这里等到头，触发补杀。
const killSettleDelay = 500 * time.Millisecond

// maxScanLine 是 bufio.Scanner 单行上限。默认 64KB 会截断脚本的大协议行：
// SPM 浏览模式的 ##[tree 树帧随条目数增长（实测 8676 条目 ≈1.2MB），
// 旧上限 1MB 触发 ErrTooLong 后整条输出流被静默丢弃。上限只限制单行长度，
// 内存仍按需增长，不会按上限预分配。
const maxScanLine = 64 * 1024 * 1024

// scanLines 用 bufio.Scanner 配 splitLines（\n 与 \r 都切行）逐行回调，并去除 ANSI 转义序列。
func scanLines(r io.Reader, stream string, onLine OnLine, done chan<- struct{}) {
	defer close(done)
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), maxScanLine)
	sc.Split(splitLines)
	for sc.Scan() {
		onLine(stream, stripANSI(sc.Text()))
	}
	// ErrTooLong（单行超限）会终止扫描：不检查 sc.Err() 则该行及之后所有输出
	// 静默丢失，表现为"动作输出凭空消失"。上报为 stderr 行，让用户看得见。
	if err := sc.Err(); err != nil {
		onLine("stderr", fmt.Sprintf(
			"[workflow-tool] 读取 %s 输出中断: %v（单行超过 %dMB 上限）",
			stream, err, maxScanLine/(1024*1024)))
	}
}

// splitLines 是 bufio.SplitFunc：\n 或 \r 均视为行结束（adb push/install
// 等命令用 \r 刷新同一行显示进度，标准 bufio.ScanLines 只认 \n 会把整条进度流当一行）。
// \r\n（CRLF，Windows 子进程如 PowerShell 的标准行尾）视作单个行结束，
// 避免行尾后多出一个空行。
func splitLines(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	for i, b := range data {
		if b == '\n' || b == '\r' {
			if b == '\r' {
				if i+1 < len(data) {
					if data[i+1] == '\n' {
						return i + 2, data[:i], nil // CRLF：一起消费
					}
					return i + 1, data[:i], nil // 单 \r：进度刷新行
				}
				if !atEOF {
					return 0, nil, nil // \r 在缓冲末尾：等下一字节判断是否 CRLF
				}
			}
			return i + 1, data[:i], nil
		}
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}
