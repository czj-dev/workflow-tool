// Package procinfo 回答「某个 pid 是不是那个进程」。跨进程的目标锁（internal/targetlock）
// 与运行记录的认领（internal/runstore）都要核对进程身份：只比 pid 不够，pid 会被复用，
// 所以一律 pid 与启动时刻一起比。
//
// 不依赖仓库内其他包，也不依赖 Wails。
package procinfo

import (
	"os"
	"time"
)

// startSlack 是判定「启动时刻相符」的容差。两头都有偏差：记录下来的启动时刻取的是
// 进程内记下的第一个时刻，比真正的创建时刻晚一个运行时初始化的时长；向系统查到的
// 时刻按存活时长反推，粒度是一秒。容差内的偏差都算同一个进程。
//
// ponytail: 10 秒的容差意味着「旧进程死掉后 10 秒内 pid 被新进程复用」会被误判为仍在
// 运行——方向是保守的（多等一轮或跳过一次，不会重复运行），不值得为此读内核的精确值。
const startSlack = 10 * time.Second

// AliveFunc 报告某个 pid 是否是启动时刻相符的存活进程。目标锁（internal/targetlock）
// 与运行记录认领（internal/runstore）共用的类型，两边各自以它作别名，不重复定义。
type AliveFunc = func(pid int, startedAt string) bool

// selfStartedAt 是本进程内记下的第一个时刻，作为「本进程的启动时刻」落进目标锁与
// 运行记录。它比真正的进程创建时刻晚一个运行时初始化的时长，但两个进程不会在同一
// 纳秒启动，足以区分「同 pid 的不同进程」。这样取值不依赖平台相关的系统调用。
var selfStartedAt = time.Now()

// Self 返回本进程的 pid 与启动时刻（RFC3339Nano）。持有锁或运行的一方把它写下来，
// 别的进程用 Alive 核对。
func Self() (pid int, startedAt string) {
	return os.Getpid(), selfStartedAt.Format(time.RFC3339Nano)
}

// Alive 报告 pid 是否是一个启动时刻与 startedAt 相符的存活进程。
// startedAt 解析不了、pid 非正、进程不存在或启动时刻对不上，都返回 false。
func Alive(pid int, startedAt string) bool {
	recorded, err := time.Parse(time.RFC3339Nano, startedAt)
	if err != nil || pid <= 0 {
		return false
	}
	actual, ok := processStartedAt(pid)
	if !ok {
		return false
	}
	return durationAbs(actual.Sub(recorded)) <= startSlack
}

func durationAbs(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}
