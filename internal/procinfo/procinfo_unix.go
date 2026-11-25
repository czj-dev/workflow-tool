//go:build !windows

package procinfo

import (
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// processStartedAt 向系统查询 pid 的启动时刻。进程不存在（或 ps 失败）时 ok=false。
// 走 ps 的 etime（已存活时长）而不是 lstart：后者受系统语言环境影响输出格式，
// etime 恒为 [[dd-]hh:]mm:ss。
func processStartedAt(pid int) (time.Time, bool) {
	now := time.Now()
	out, _ := exec.Command("ps", "-o", "etime=", "-p", strconv.Itoa(pid)).Output()
	return startFromElapsed(strings.TrimSpace(string(out)), now)
}

// startFromElapsed 由「查询时刻」与「已存活时长」反推启动时刻。
func startFromElapsed(etime string, now time.Time) (time.Time, bool) {
	if etime == "" {
		return time.Time{}, false
	}
	var days int
	if d, rest, found := strings.Cut(etime, "-"); found {
		parsed, err := strconv.Atoi(d)
		if err != nil || parsed < 0 {
			return time.Time{}, false
		}
		days, etime = parsed, rest
	}
	parts := strings.Split(etime, ":")
	if len(parts) < 2 || len(parts) > 3 {
		return time.Time{}, false
	}
	units := []time.Duration{time.Second, time.Minute, time.Hour}
	elapsed := time.Duration(days) * 24 * time.Hour
	for i, part := range parts {
		value, err := strconv.Atoi(part)
		if err != nil || value < 0 {
			return time.Time{}, false
		}
		elapsed += time.Duration(value) * units[len(parts)-1-i]
	}
	return now.Add(-elapsed), true
}
