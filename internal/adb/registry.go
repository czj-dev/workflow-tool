// Package adb 提供 command.adb 形态的执行框架：ADBRunner 按 operation 分发到
// 各域 handler。各域子包（package/logcat/file/scrcpy）在自己的 init() 中调用
// RegisterOperation 自登记，避免多 agent 并行写共享文件。
package adb

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"workflow-tool/internal/adbcore"
	"workflow-tool/internal/runner"
)

// EmitFunc 与 runner.EmitFunc 同签名（stream 为 stdout/stderr/progress）。
// 用类型别名，使域子包只依赖 adb 包而不直接依赖 runner。
type EmitFunc = runner.EmitFunc

// OpContext 是单次 operation 调用的运行时上下文，由 ADBRunner 构造并传给 handler。
type OpContext struct {
	Ctx       context.Context
	Operation string
	Serial    string // 解析到的激活设备 serial（可能为 ""）
	Params    map[string]any
	Emit      EmitFunc
	Timeout   time.Duration

	adbPath      string
	fastbootPath string
	scrcpyPath   string
}

// Adb 构造针对当前设备的 adb ExecRequest（serial 非空时前置 -s serial）。
func (op *OpContext) Adb(args ...string) adbcore.ExecRequest {
	full := make([]string, 0, len(args)+2)
	if op.Serial != "" {
		full = append(full, "-s", op.Serial)
	}
	full = append(full, args...)
	return adbcore.ExecRequest{Command: op.adbPath, Args: full, Timeout: op.Timeout}
}

// AdbGlobal 构造不带 -s serial 的 adb ExecRequest（如 devices）。
func (op *OpContext) AdbGlobal(args ...string) adbcore.ExecRequest {
	return adbcore.ExecRequest{Command: op.adbPath, Args: args, Timeout: op.Timeout}
}

// AdbStream 构造流式 adb 请求（\n+\r 切行）。capture=true 同时缓存全量输出。
func (op *OpContext) AdbStream(capture bool, onLine func(stream, line string), args ...string) adbcore.StreamingRequest {
	req := op.Adb(args...)
	return adbcore.StreamingRequest{
		Command: req.Command, Args: req.Args, Timeout: req.Timeout,
		Capture: capture, OnLine: onLine,
	}
}

// Fastboot 构造 fastboot ExecRequest（serial 非空时前置 -s serial）。
func (op *OpContext) Fastboot(args ...string) adbcore.ExecRequest {
	full := make([]string, 0, len(args)+2)
	if op.Serial != "" {
		full = append(full, "-s", op.Serial)
	}
	full = append(full, args...)
	return adbcore.ExecRequest{Command: op.fastbootPath, Args: full, Timeout: op.Timeout}
}

// AdbPath / ScrcpyPath 返回解析到的二进制路径。
func (op *OpContext) AdbPath() string    { return op.adbPath }
func (op *OpContext) ScrcpyPath() string { return op.scrcpyPath }

// ParamStr 取 params[key] 的字符串值（fmt.Sprint + trim）。缺失返回 ""。
func (op *OpContext) ParamStr(key string) string {
	v, ok := op.Params[key]
	if !ok || v == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(v))
}

// ParamBool 取 params[key] 的布尔值。
func (op *OpContext) ParamBool(key string) bool {
	v, ok := op.Params[key]
	if !ok || v == nil {
		return false
	}
	switch t := v.(type) {
	case bool:
		return t
	case string:
		b, _ := strconv.ParseBool(strings.TrimSpace(t))
		return b
	default:
		return false
	}
}

// EmitStdout / EmitStderr / EmitProgress 是 emit 的便捷封装。
func (op *OpContext) EmitStdout(line string) {
	if op.Emit != nil {
		op.Emit("stdout", line)
	}
}
func (op *OpContext) EmitStderr(line string) {
	if op.Emit != nil {
		op.Emit("stderr", line)
	}
}
func (op *OpContext) EmitProgress(line string) {
	if op.Emit != nil {
		op.Emit("progress", line)
	}
}

// OpResult 是 handler 的产物。
type OpResult struct {
	ExitCode int
	Err      error
	Stdout   string // 可选：供 output 协议/捕获使用
	Stderr   string
}

// Handler 处理单个 operation。
type Handler func(op *OpContext) OpResult

var (
	routeMu sync.RWMutex
	routes  = map[string]Handler{}
)

// RegisterOperation 注册一个 operation handler。各域包在 init() 中调用。
// 重复注册 panic（编程错误，尽早暴露）。
func RegisterOperation(name string, h Handler) {
	routeMu.Lock()
	defer routeMu.Unlock()
	if _, exists := routes[name]; exists {
		panic("adb: duplicate operation registration: " + name)
	}
	if h == nil {
		panic("adb: nil handler for operation: " + name)
	}
	routes[name] = h
}

func lookupHandler(name string) (Handler, bool) {
	routeMu.RLock()
	defer routeMu.RUnlock()
	h, ok := routes[name]
	return h, ok
}

// RegisteredOperations 返回已注册 operation 名（字母序），供调试/文档。
func RegisteredOperations() []string {
	routeMu.RLock()
	defer routeMu.RUnlock()
	out := make([]string, 0, len(routes))
	for k := range routes {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
