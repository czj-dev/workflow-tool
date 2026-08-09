// Package logcat 提供结构化 logcat 抓取 operation：前台流式（logcat-stream）
// 与批量落盘（logcat-batch）。两者共享 `logcat -v threadtime` 的解析与 LEVEL/TAG/
// INCLUDE/EXCLUDE 过滤逻辑（移植自 ADBKit logcat_service.go，但改用 Go 端过滤，
// 并以 adb.OpContext 的 AdbStream + EmitStdout 取代 Wails v2 事件通道）。
package logcat

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

const (
	opStream = "logcat-stream"
	opBatch  = "logcat-batch"
)

func init() {
	adb.RegisterOperation(opStream, handleStream)
	adb.RegisterOperation(opBatch, handleBatch)
}

// handleStream 前台流式 logcat：逐行解析 threadtime，按 LEVEL(>=阈值)/TAG(子串)/
// INCLUDE/EXCLUDE(message 子串) 过滤后经 EmitStdout 推送。RunStreaming 遵循 ctx
// 取消，故取消动作即停止流；ctx 取消/超时视为正常结束 (ExitCode 0)。
func handleStream(op *adb.OpContext) adb.OpResult {
	f, ok := buildFilter(op.ParamStr("LEVEL"), op.ParamStr("TAG"), op.ParamStr("INCLUDE"), op.ParamStr("EXCLUDE"))
	if !ok {
		opErr := adbcore.NewOperationError(opStream, "invalid LEVEL (expect V/D/I/W/E/F or verbose/warn/error...)", op.ParamStr("LEVEL"), false)
		op.EmitStderr(opErr.Error())
		return adb.OpResult{ExitCode: 2, Err: opErr, Stderr: opErr.Error()}
	}

	// RunStreaming 的 OnLine 由 stdout/stderr 两个扫描 goroutine 并发回调，
	// 故对 emit 串行化，避免输出交错（logcat 绝大多数输出走 stdout，争用极低）。
	var emitMu sync.Mutex
	onLine := func(stream, line string) {
		e := parseEntry(line)
		if !f.allow(&e) {
			return
		}
		emitMu.Lock()
		op.EmitStdout(line)
		emitMu.Unlock()
	}

	req := op.AdbStream(false, onLine, "logcat", "-v", "threadtime")
	res, err := adbcore.RunStreaming(op.Ctx, req)
	switch {
	case err == nil:
		op.EmitStdout(fmt.Sprintf("logcat stream ended (exit %d)", res.ExitCode))
		if res.ExitCode != 0 {
			opErr := adbcore.NewOperationError(opStream, "logcat exited with non-zero status", res.Stderr, false)
			return adb.OpResult{ExitCode: res.ExitCode, Stderr: res.Stderr, Err: opErr}
		}
		return adb.OpResult{ExitCode: 0}
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		// 取消/超时是前台流的预期终止方式。
		op.EmitStdout("logcat stream stopped")
		return adb.OpResult{ExitCode: 0}
	default:
		// 进程错误（启动失败、非零退出等）；res 可能为 nil 或携带退出码/stderr。
		exitCode := -1
		stderr := err.Error()
		if res != nil {
			exitCode = res.ExitCode
			if res.Stderr != "" {
				stderr = res.Stderr
			}
		}
		op.EmitStderr(stderr)
		opErr := adbcore.NewOperationError(opStream, "logcat stream failed", stderr, false)
		return adb.OpResult{ExitCode: exitCode, Err: opErr, Stderr: stderr}
	}
}

// handleBatch 批量抓取 logcat 到 LOGS_DIR 下文件，命名与 scripts/adb-logcat.* 对齐：
// logcat_<yyyyMMdd_HHmmss>.log。先 best-effort 清空缓冲区（logcat -c，避免混入历史日志），
// 再流式抓取并逐行过滤落盘；ctx 取消/超时/进程退出后关闭文件并 EmitStdout 已保存路径。
func handleBatch(op *adb.OpContext) adb.OpResult {
	logsDir := op.ParamStr("LOGS_DIR")
	if logsDir == "" {
		opErr := adbcore.NewOperationError(opBatch, "LOGS_DIR is required", "", false)
		op.EmitStderr(opErr.Error())
		return adb.OpResult{ExitCode: 2, Err: opErr, Stderr: opErr.Error()}
	}

	f, ok := buildFilter(op.ParamStr("LEVEL"), op.ParamStr("TAG"), op.ParamStr("INCLUDE"), op.ParamStr("EXCLUDE"))
	if !ok {
		opErr := adbcore.NewOperationError(opBatch, "invalid LEVEL (expect V/D/I/W/E/F or verbose/warn/error...)", op.ParamStr("LEVEL"), false)
		op.EmitStderr(opErr.Error())
		return adb.OpResult{ExitCode: 2, Err: opErr, Stderr: opErr.Error()}
	}

	if mkErr := os.MkdirAll(logsDir, 0o755); mkErr != nil {
		opErr := adbcore.NewOperationError(opBatch, "cannot create LOGS_DIR", mkErr.Error(), false)
		op.EmitStderr(opErr.Error())
		return adb.OpResult{ExitCode: -1, Err: opErr, Stderr: opErr.Error()}
	}

	outPath := filepath.Join(logsDir, "logcat_"+time.Now().Format("20060102_150405")+".log")
	fh, cErr := os.Create(outPath)
	if cErr != nil {
		opErr := adbcore.NewOperationError(opBatch, "cannot create output file", outPath+": "+cErr.Error(), false)
		op.EmitStderr(opErr.Error())
		return adb.OpResult{ExitCode: -1, Err: opErr, Stderr: opErr.Error()}
	}

	// CLEAR_BUFFER=true 时才清空缓冲区（best-effort，失败仅告警，不中断）。
	// 默认 false：保留已有日志，避免静默丢失历史。
	if op.ParamBool("CLEAR_BUFFER") {
		if _, clearErr := adbcore.RunCommand(op.Ctx, op.Adb("logcat", "-c")); clearErr != nil {
			op.EmitStderr("warning: logcat -c failed: " + clearErr.Error())
		}
	}

	// 文件写入/计数由两个扫描 goroutine 并发触发，须加锁。
	var writeMu sync.Mutex
	count := 0
	onLine := func(stream, line string) {
		e := parseEntry(line)
		if !f.allow(&e) {
			return
		}
		writeMu.Lock()
		fmt.Fprintln(fh, line)
		count++
		writeMu.Unlock()
	}

	req := op.AdbStream(false, onLine, "logcat", "-v", "threadtime")
	res, runErr := adbcore.RunStreaming(op.Ctx, req)

	// 无论正常/取消，先关闭文件保证已抓内容落盘（RunStreaming 返回时扫描 goroutine 已退出）。
	closeErr := fh.Close()

	if runErr != nil && !(errors.Is(runErr, context.Canceled) || errors.Is(runErr, context.DeadlineExceeded)) {
		exitCode := -1
		stderr := runErr.Error()
		if res != nil {
			exitCode = res.ExitCode
			if res.Stderr != "" {
				stderr = res.Stderr
			}
		}
		op.EmitStderr(stderr)
		opErr := adbcore.NewOperationError(opBatch, "logcat capture failed", stderr, false)
		return adb.OpResult{ExitCode: exitCode, Err: opErr, Stderr: stderr}
	}
	if closeErr != nil {
		op.EmitStderr("warning: failed to close log file: " + closeErr.Error())
	}

	op.EmitStdout(outPath)
	op.EmitStdout(fmt.Sprintf("captured %d lines -> %s", count, outPath))
	return adb.OpResult{ExitCode: 0, Stdout: outPath}
}
