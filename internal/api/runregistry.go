package api

import (
	"context"
	"sync"

	"workflow-tool/internal/target"
	"workflow-tool/internal/targetlock"
)

// runRegistry 是「id → cancel / 控制通道」的运行簿记：拒绝同 id 并发、结束清理、
// 按 id 取消、运行期控制通道按 id 寻址（UpdateLogcatFilter → logcat-stream）。
// action / workflow / AI 任务三条路径各一个实例。
//
// 互斥的真相在落盘的目标锁（internal/targetlock）：begin / beginChild 先占它，再登记
// 进程内的取消入口。于是应用内的运行、独立执行器、Agent 从 shell 发起的 CLI 运行对同一
// 个目标互斥；进程内的登记只多提供两样东西——取消入口，以及「这个目标此刻在跑」的
// 即时答案（不必每次去读锁文件）。
type runRegistry struct {
	kind  target.Kind
	locks *targetlock.Locks

	mu       sync.Mutex
	running  map[string]context.CancelFunc
	releases map[string]func()   // 本进程持有的目标锁的释放函数（hold 登记的运行没有）
	controls map[string]chan any // 可选：logcat-stream 启动时登记（其余动作无登记）
}

func newRunRegistry(kind target.Kind, locks *targetlock.Locks) *runRegistry {
	return &runRegistry{
		kind:     kind,
		locks:    locks,
		running:  map[string]context.CancelFunc{},
		releases: map[string]func(){},
		controls: map[string]chan any{},
	}
}

// begin 登记 id 并创建可取消 ctx；目标已被占（本进程的另一个运行、执行器、别的进程）
// 时返回 ok=false（拒绝并发）。cancel 存在 registry 内部，取消统一走 cancel(id)。
func (r *runRegistry) begin(id string) (context.Context, bool) {
	return r.beginChild(id, context.Background())
}

// beginChild 登记 id 并把 ctx 挂在 parent 之下：既占目标锁，又随 parent 取消而终止。
// 用于 workflow 的 AI 步骤——取消工作流（parent）或从任务上 cancel(id) 都会终止该步骤。
// 目标已被占时返回 ok=false：撞锁不等待，由调用方决定失败。
func (r *runRegistry) beginChild(id string, parent context.Context) (context.Context, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.running[id]; exists {
		return nil, false
	}
	release, err := r.locks.Acquire(r.kind, id)
	if err != nil {
		return nil, false
	}
	ctx, cancel := context.WithCancel(parent)
	r.running[id] = cancel
	r.releases[id] = release
	return ctx, true
}

// hold 登记一个「由别的进程执行」的运行（执行器）：目标锁在执行器手里，这里只登记
// 取消入口。cancel 由调用方给出（执行器运行的取消是写停止标记）。撞上已登记的 id
// 返回 false。
func (r *runRegistry) hold(id string, cancel context.CancelFunc) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.running[id]; exists {
		return false
	}
	r.running[id] = cancel
	return true
}

// held 报告 id 此刻是否登记在册。
func (r *runRegistry) held(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.running[id]
	return ok
}

// end 清除 id 的运行登记（含控制通道与本进程持有的目标锁；execute goroutine defer 调用）。
func (r *runRegistry) end(id string) {
	r.mu.Lock()
	release := r.releases[id]
	delete(r.running, id)
	delete(r.releases, id)
	delete(r.controls, id)
	r.mu.Unlock()
	if release != nil {
		release()
	}
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
