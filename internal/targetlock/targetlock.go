// Package targetlock 是落盘的目标锁：同一目标同一时刻只有一个运行，跨进程成立。
//
// 应用内的手动运行、独立执行器（internal/cli 的执行器模式）与 Agent 从 shell 发起的
// CLI 运行都经这里占锁。每个目标一个锁文件 runs/locks/<kind>-<id>.lock，内容是持有者
// 的 pid 与进程启动时刻；持有者结束前释放。持有者崩溃时锁文件会留下，下一次占锁按
// 进程身份核对（internal/procinfo）：持有者已不在就是残留，接管。
//
// 不依赖 Wails；目标种类的词汇来自 internal/target。
package targetlock

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"workflow-tool/internal/procinfo"
	"workflow-tool/internal/target"
)

// ErrBusy 表示目标正被另一个运行占着（持有者进程仍然存活）。
var ErrBusy = errors.New("target is locked by another run")

const (
	// DirName 是应用目录下存放锁文件的相对路径。放在运行记录 runs/ 之下：同属运行时
	// 状态，一并不入仓库；runstore 只认 runs/<run-id>/ 目录，不会把它当记录。
	DirName = "runs/locks"
	// unreadableGrace 是读不出持有者信息的锁文件「算作被占着」的时长。持有者是先建文件
	// 再写内容的，极短的时间里文件是空的；过了这个时长还读不出来，就是崩溃留下的残骸。
	unreadableGrace = time.Minute
)

// AliveFunc 报告某个 pid 是否是启动时刻相符的存活进程；默认用 procinfo.Alive，测试注入。
type AliveFunc func(pid int, startedAt string) bool

// Locks 管理一个应用目录下的全部目标锁。
type Locks struct {
	dir   string
	alive AliveFunc
	// now 是时钟，测试注入。
	now func() time.Time
	// mu 串行化本进程内的占锁（探测残留 → 接管不是原子的，同进程内不能并发做）。
	mu sync.Mutex
}

// New 建立以 baseDir 为根的目标锁集合。
func New(baseDir string) *Locks {
	return &Locks{dir: filepath.Join(baseDir, DirName), alive: procinfo.Alive, now: time.Now}
}

// lockFile 是锁文件内容：持有者的进程身份。
type lockFile struct {
	PID       int    `json:"pid"`
	StartedAt string `json:"started_at"`
}

// Acquire 占住目标，返回释放函数（重复调用是空操作）。目标已被另一个存活进程占住时
// 返回 ErrBusy；锁文件是已死进程留下的则接管。
//
// ponytail: 接管残留（删旧文件、建新文件）跨进程不是原子的。两个进程同时接管同一把
// 残留锁、且恰好卡在两次系统调用之间时，可能双双以为自己占到了。窗口是微秒级，前提
// 是持有者刚刚异常退出；真要堵死得换成操作系统级的文件锁（flock / LockFileEx）。
func (l *Locks) Acquire(kind target.Kind, id string) (func(), error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := os.MkdirAll(l.dir, 0o755); err != nil {
		return nil, fmt.Errorf("create target lock dir %q: %w", l.dir, err)
	}
	path := l.path(kind, id)
	release, err := l.create(path)
	if err == nil {
		return release, nil
	}
	if !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	if !l.takeOverStale(path) {
		return nil, ErrBusy
	}
	release, err = l.create(path)
	if errors.Is(err, os.ErrExist) {
		return nil, ErrBusy // 接管与新占之间被别人抢先了
	}
	return release, err
}

// Busy 探测目标是否被占着，不占住。
func (l *Locks) Busy(kind target.Kind, id string) bool {
	release, err := l.Acquire(kind, id)
	if err != nil {
		return true
	}
	release()
	return false
}

// create 以 O_EXCL 新建锁文件并写入本进程的身份。文件已存在时返回包裹 os.ErrExist 的错误。
func (l *Locks) create(path string) (func(), error) {
	pid, startedAt := procinfo.Self()
	data, err := json.Marshal(lockFile{PID: pid, StartedAt: startedAt})
	if err != nil {
		return nil, fmt.Errorf("encode target lock %q: %w", path, err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, fmt.Errorf("create target lock %q: %w", path, err)
	}
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(path)
		return nil, fmt.Errorf("write target lock %q: %w", path, errors.Join(writeErr, closeErr))
	}
	var once sync.Once
	return func() { once.Do(func() { _ = os.Remove(path) }) }, nil
}

// takeOverStale 判定一把已存在的锁是不是残留；是则删掉并返回 true。调用方须持有 l.mu。
func (l *Locks) takeOverStale(path string) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return errors.Is(err, os.ErrNotExist) // 持有者刚好释放了
	}
	var holder lockFile
	if json.Unmarshal(data, &holder) == nil && holder.PID > 0 {
		if l.alive(holder.PID, holder.StartedAt) {
			return false
		}
	} else {
		info, err := os.Stat(path)
		if err != nil || l.now().Sub(info.ModTime()) < unreadableGrace {
			return false
		}
	}
	return os.Remove(path) == nil
}

func (l *Locks) path(kind target.Kind, id string) string {
	return filepath.Join(l.dir, string(kind)+"-"+id+".lock")
}
