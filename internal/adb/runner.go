package adb

import (
	"context"
	"fmt"
	"strings"
	"time"

	"workflow-tool/internal/adb/binary"
	"workflow-tool/internal/adb/device"
	"workflow-tool/internal/runner"
)

// ADBRunner 实现 runner.Runner：按 command.adb.operation 分发到域 handler。
// 共享依赖（Bin/Dev/Overrides）挂在结构上；Operation/Timeout 由调用方按动作设置。
type ADBRunner struct {
	Bin       *binary.Service
	Dev       *device.Service
	Operation string        // 动作的 command.adb.operation
	Timeout   time.Duration // 动作超时（透传给每个子命令）
	// GetOverrides 返回 config.yaml 里的 ADB_PATH/FASTBOOT_PATH/SCRCPY_PATH（可空）。
	GetOverrides func() map[string]string
}

// Run 实现 runner.Runner。
func (r *ADBRunner) Run(ctx context.Context, params map[string]any, emit runner.EmitFunc) runner.Result {
	start := time.Now()

	handler, ok := lookupHandler(r.Operation)
	if !ok {
		msg := fmt.Sprintf("未知 adb operation: %s", r.Operation)
		if emit != nil {
			emit("stderr", msg)
		}
		return runner.Result{
			ExitCode: -1, Err: fmt.Errorf("%s", msg), Duration: time.Since(start),
			Outputs: map[string]string{"exit_code": "-1", "success": "false"},
		}
	}

	// 解析 serial：优先 params 里的 ${ADB_SERIAL}（api 已注入），否则自动选首个 ready 设备。
	serial := strParam(params, "ADB_SERIAL")
	if serial == "" && r.Dev != nil {
		if s, err := r.Dev.ResolveActive(ctx); err == nil {
			serial = s
		}
	}

	// 解析二进制路径（config 覆盖 -> PATH -> 常见路径）。
	var ov map[string]string
	if r.GetOverrides != nil {
		ov = r.GetOverrides()
	}
	paths := r.Bin.Paths(strMap(ov, "ADB_PATH"), strMap(ov, "FASTBOOT_PATH"), strMap(ov, "SCRCPY_PATH"))

	op := &OpContext{
		Ctx: ctx, Operation: r.Operation, Serial: serial, Params: params,
		Emit: emit, Timeout: r.Timeout,
		adbPath: paths.Adb, fastbootPath: paths.Fastboot, scrcpyPath: paths.Scrcpy,
	}

	res := handler(op)
	exitCode := res.ExitCode
	success := exitCode == 0 && res.Err == nil
	return runner.Result{
		ExitCode: exitCode,
		Err:      res.Err,
		Duration: time.Since(start),
		Stdout:   res.Stdout,
		Stderr:   res.Stderr,
		Outputs: map[string]string{
			"exit_code": fmt.Sprint(exitCode),
			"success":   fmt.Sprint(success),
		},
	}
}

func strParam(params map[string]any, key string) string {
	v, ok := params[key]
	if !ok || v == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(v))
}

func strMap(m map[string]string, key string) string {
	if m == nil {
		return ""
	}
	return m[key]
}
