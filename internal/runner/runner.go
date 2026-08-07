package runner

import (
	"context"
	"time"
)

// EmitFunc 把一行输出推到前端。stream 为 "stdout" 或 "stderr"。
type EmitFunc func(stream string, line string)

// Result 是一次执行的产物。
type Result struct {
	ExitCode int
	Err      error
	Duration time.Duration
	Stdout   string            // capture_output=true 时填充：全部 stdout 原文
	Stderr   string            // capture_output=true 时填充：全部 stderr 原文
	Outputs  map[string]string // ##[output key=value] 协议解析结果 + reserved key
}

// Runner 是执行单元接口。Phase 1 唯一实现是 ShellRunner。
// params 为 Phase 3（参数表单）预留，Phase 1 传 nil。
// 接口为 Phase 2/3/4 稳定不变。
type Runner interface {
	Run(ctx context.Context, params map[string]any, emit EmitFunc) Result
}
