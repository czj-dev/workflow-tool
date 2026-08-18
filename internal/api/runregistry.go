package api

import (
	"context"
	"sync"
)

// runRegistry 是「id → cancel / 控制通道」的运行簿记：拒绝同 id 并发、结束清理、
// 按 id 取消、运行期控制通道按 id 寻址（UpdateLogcatFilter → logcat-stream）。
// action 与 workflow 两条执行路径共用同一语义（原先两份 map+mutex 各写一遍）。
type runRegistry struct {
	mu       sync.Mutex
	running  map[string]context.CancelFunc
	controls map[string]chan any // 可选：logcat-stream 启动时登记（其余动作无登记）
}

func newRunRegistry() *runRegistry {
	return &runRegistry{
		running:  map[string]context.CancelFunc{},
		controls: map[string]chan any{},
	}
}

// begin 登记 id 并创建可取消 ctx；id 已在运行时返回 ok=false（拒绝并发）。
// cancel 存在 registry 内部，取消统一走 cancel(id)。
func (r *runRegistry) begin(id string) (context.Context, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.running[id]; exists {
		return nil, false
	}
	ctx, cancel := context.WithCancel(context.Background())
	r.running[id] = cancel
	return ctx, true
}

// end 清除 id 的运行登记（含控制通道；execute goroutine defer 调用）。
func (r *runRegistry) end(id string) {
	r.mu.Lock()
	delete(r.running, id)
	delete(r.controls, id)
	r.mu.Unlock()
}

// setControl 登记 id 的运行期控制通道（logcat-stream 启动时由 RunAction 注入）。
// 双向通道：UpdateLogcatFilter 满时会挤掉一条过期更新（接收操作需要双向）。
func (r *runRegistry) setControl(id string, ch chan any) {
	r.mu.Lock()
	r.controls[id] = ch
	r.mu.Unlock()
}

// control 取 id 的控制通道；未登记返回 ok=false。
func (r *runRegistry) control(id string) (chan any, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ch, ok := r.controls[id]
	return ch, ok
}

// cancel 取消 id 的运行；未运行时空操作。
func (r *runRegistry) cancel(id string) {
	r.mu.Lock()
	c, ok := r.running[id]
	r.mu.Unlock()
	if ok {
		c()
	}
}
