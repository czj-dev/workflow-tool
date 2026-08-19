package adb

import (
	"context"
	"fmt"
	"strings"
	"time"

	"workflow-tool/internal/adb/binary"
	"workflow-tool/internal/runner"
)

// deviceResolver 抽象 ADBRunner 所需的设备解析能力。
// 用接口而非具体 *device.Service，便于测试注入 fake，也解耦 runner 对 device 包的强依赖。
type deviceResolver interface {
	ResolveActive(ctx context.Context) (string, error)
	IsReady(ctx context.Context, serial string) bool
}

// builtinResolver 是 ADB_SERIAL 内置变量兜底所需的最小能力
// （*builtinvars.Registry 实现；单独定义方便测试用 stub，避免本包依赖具体类型细节）。
type builtinResolver interface {
	Resolve(ctx context.Context, name string) (string, bool)
}

// ADBRunner 实现 runner.Runner：按 command.adb.operation 分发到域 handler。
// 共享依赖（ResolvePaths/Dev）挂在结构上；Operation/Timeout 由调用方按动作设置。
type ADBRunner struct {
	// ResolvePaths 返回当前解析好的三个二进制路径（config 覆盖 → PATH → 常见路径）。
	// 由调用方注入（api.binPaths），路径解析知识只此一份；可空（测试时得零值路径）。
	ResolvePaths func() binary.Paths
	Dev          deviceResolver
	Operation    string        // 动作的 command.adb.operation
	Timeout      time.Duration // 动作超时（透传给每个子命令）
	// Control 运行期控制通道（透传给 OpContext.Control；logcat-stream 过滤更新用）。可空。
	Control chan any
	// Builtins 内置变量兜底（ADB_SERIAL），nil 时跳过该层，行为与改动前一致。
	Builtins builtinResolver
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

	// 解析 serial：优先 params 里的 ${ADB_SERIAL}（config.yaml 显式覆盖时经此路径），
	// 但需校验仍在线；未命中或失效时依次尝试 builtins（内置变量兜底）与 ResolveActive。
	// 设备（尤其车载/网络 ADB）重连后 transport serial 可能变化，缓存的 ADB_SERIAL 会失效；
	// 若盲目把失效 serial 传给 adb，会得到 "- waiting for device -" 并悬挂到超时。
	serial := resolveSerial(ctx, r.Dev, r.Builtins, strParam(params, "ADB_SERIAL"))

	// 解析二进制路径：调用方注入的 ResolvePaths 是唯一实现（config 覆盖 -> PATH -> 常见路径）。
	var paths binary.Paths
	if r.ResolvePaths != nil {
		paths = r.ResolvePaths()
	}

	op := &OpContext{
		Ctx: ctx, Operation: r.Operation, Serial: serial, Params: params,
		Emit: emit, Timeout: r.Timeout, Control: r.Control,
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

// resolveSerial 决定本次 adb 命令的目标 serial，按优先级：
// 1. paramSerial 非空且仍在线 → 沿用（尊重 UI 选择的设备 / config.yaml 显式 ADB_SERIAL）；
// 2. builtins 命中（内置变量兜底，ADB_SERIAL 走 device.Service.ResolveActive）；
// 3. dev.ResolveActive（重新选首个 ready 设备），避免 adb -s <失效serial> 无限 waiting；
// 4. 全部落空则保留 paramSerial 原值（可能为空，交给下游 adb 自行报错）。
// dev 为 nil（测试/无设备服务）时跳过第 1/3 步；builtins 为 nil 时跳过第 2 步。
func resolveSerial(ctx context.Context, dev deviceResolver, builtins builtinResolver, paramSerial string) string {
	if paramSerial != "" && dev != nil && dev.IsReady(ctx, paramSerial) {
		return paramSerial
	}
	if builtins != nil {
		if s, ok := builtins.Resolve(ctx, "ADB_SERIAL"); ok {
			return s
		}
	}
	if dev != nil {
		if s, err := dev.ResolveActive(ctx); err == nil && s != "" {
			return s
		}
	}
	return paramSerial
}
