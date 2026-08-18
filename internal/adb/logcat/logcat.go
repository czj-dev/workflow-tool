// Package logcat 提供结构化 logcat 抓取 operation：前台流式（logcat-stream，
// stream.go：统一规则求值 + raw ring 重放）与批量落盘（logcat-batch，本文件）。
// 两者共享 `logcat -v threadtime` 的解析（filter.go）；batch 仍用旧 buildFilter
// 入参过滤，stream 走 rule.go 统一规则（spec: 2026-08-18-logcat-filter-chips-design）。
package logcat

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

const opBatch = "logcat-batch"

func init() {
	adb.RegisterOperation(OpStream, handleStream) // 实现在 stream.go（raw ring + 运行期规则更新）
	adb.RegisterOperation(opBatch, handleBatch)
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
	// PACKAGE 过滤（batch 为一次性短捕获，启动时解析一次即可，不做重试）。
	pkg := op.ParamStr("PACKAGE")
	var pids map[int]struct{}
	if pkg != "" {
		pids = resolvePids(op, pkg)
		if len(pids) == 0 {
			op.EmitStderr("warning: no running process found for package " + pkg)
		}
	}
	onLine := func(stream, line string) {
		e := parseEntry(line)
		if !f.allow(&e) {
			return
		}
		if pids != nil {
			if _, ok := pids[e.Pid]; !ok {
				return
			}
		}
		writeMu.Lock()
		fmt.Fprintln(fh, e.Raw)
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

// resolvePids 查询设备上 pkg 当前运行的 pid 集合（adb shell pidof）。
// 包未运行/查询失败返回空（非 nil）map；多进程应用返回多个 pid。
// 与 Android Studio Logcat 的 package 过滤同思路：包名不在 adb 层直接过滤，而是解析为 pid。
func resolvePids(op *adb.OpContext, pkg string) map[int]struct{} {
	out := make(map[int]struct{})
	if pkg == "" {
		return out
	}
	res, err := adbcore.RunCommand(op.Ctx, op.Adb("shell", "pidof", pkg))
	if err != nil || res == nil {
		return out
	}
	for _, f := range strings.Fields(res.Stdout) {
		if p := atoi(f); p > 0 {
			out[p] = struct{}{}
		}
	}
	return out
}

// logcatPayload 是下发给前端的 JSON 行结构（stream="logcat" 的 line 字段）。
// 字段对齐 adbkit-logcat Entry：date/time/pid/tid/level(单字母)/tag/message。
// 前端按 level 着色、按 tag 分列、对 message 做运行时搜索。
type logcatPayload struct {
	Date    string `json:"date"`
	Time    string `json:"time"`
	Pid     int    `json:"pid"`
	Tid     int    `json:"tid"`
	Level   string `json:"level"`
	Tag     string `json:"tag"`
	Message string `json:"message"`
}

// entryJSON 把内部 Entry 转成下发用 logcatPayload（剔除 Raw，避免重复传输）。
func entryJSON(e Entry) logcatPayload {
	return logcatPayload{
		Date: e.Date, Time: e.Time, Pid: e.Pid, Tid: e.Tid,
		Level: e.Level, Tag: e.Tag, Message: e.Message,
	}
}
