package api

import (
	"context"
	"time"

	"workflow-tool/internal/cli"
	"workflow-tool/internal/target"
)

// 调度发起的运行走独立执行器（见 executor.go）。测试里不能把测试二进制自己当执行器拉起来，
// 改为在当前进程里跑同一份执行器代码：跑完立即核对这条记录，索引、调度卡与前端通知
// 随之同步——与真实的轮询核对是同一个入口（pollExecutorRun）。
func init() {
	spawnExecutor = func(s *Service, kind target.Kind, id, runID string) error {
		go func() {
			cli.ExecuteRecord(context.Background(), s.baseDir, runID, true)
			s.pollExecutorRun(runID)
		}()
		return nil
	}
	executorPollEvery = 20 * time.Millisecond
}
