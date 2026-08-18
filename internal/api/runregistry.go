package api

import (
	"context"
	"sync"
)

// runRegistry 是「id → cancel」的运行簿记：拒绝同 id 并发、结束清理、按 id 取消。
// action 与 workflow 两条执行路径共用同一语义（原先两份 map+mutex 各写一遍）。
type runRegistry struct {
	mu      sync.Mutex
	running map[string]context.CancelFunc
}

func newRunRegistry() *runRegistry {
	return &runRegistry{running: map[string]context.CancelFunc{}}
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

// end 清除 id 的运行登记（execute goroutine defer 调用）。
func (r *runRegistry) end(id string) {
	r.mu.Lock()
	delete(r.running, id)
	r.mu.Unlock()
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
