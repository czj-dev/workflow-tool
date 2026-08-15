//go:build windows

package adbcore

import "context"

// runStreamingPTY 在 Windows 上是 no-op：adb 不检查 isatty，管道读取即可拿到进度。
// 返回 ok=false 让 RunStreaming 走原生 pipe 分支。
func runStreamingPTY(_ context.Context, _ StreamingRequest) (*ExecResult, error, bool) {
	return nil, nil, false
}
