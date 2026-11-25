// executor.go：调度到点与立即运行交给独立执行器（M4）。
//
// 应用不自己跑这两类运行：建好运行记录后拉起同一可执行文件的 `run --record <run-id>`
// （internal/cli 的执行器模式），它接手这条记录——占目标锁、写心跳、续写日志、落终态，
// 不随应用退出而终止。应用这边做三件事：
//   - 发起（launchExecutor）；
//   - 核对（watchExecutorRuns）：定期 Poll 在途的执行器运行，执行器写完终态就同步索引、
//     更新调度卡、通知前端；执行器没了就留中断；
//   - 停止（stopExecutor）：写停止标记，执行器轮询到即取消。
//
// 手动运行仍留在应用进程内（规格「进程模型」）。
package api

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"workflow-tool/internal/runner"
	"workflow-tool/internal/runstore"
	"workflow-tool/internal/target"
)

// executorEnv 是执行器进程带的环境标记。执行器是 headless 的 run 子命令，本来就不启动
// 调度器——标记留作辨识用（排查时一眼区分应用进程与执行器）。
const executorEnv = "WORKFLOW_TOOL_EXECUTOR"

// executorPollEvery 是应用核对在途执行器运行的间隔。包级变量，测试调短。
var executorPollEvery = 2 * time.Second

// executorSpawner 拉起执行器进程。生产环境是真进程；测试换成在当前进程里跑同一份执行器
// 代码（internal/cli.ExecuteRecord），免得把测试二进制自己当执行器拉起来。
type executorSpawner func(s *Service, kind target.Kind, id, runID string) error

var spawnExecutor executorSpawner = func(s *Service, kind target.Kind, id, runID string) error {
	return s.spawnExecutorProcess(kind, id, runID)
}

// launchExecutor 为一次调度发起的运行拉起执行器。
//
// 执行器接手时要读这条记录，所以记录必须先于进程存在。进程内登记与「运行中」的通告
// 也都赶在拉起之前：执行器可能极快结束，核对（pollExecutorRun）一旦抢在登记前面，
// 一个已经结束的运行就会被登记成「在跑」、调度卡会卡在运行中。
// 拉不起来就由应用自己把记录落成 failed（source.runID 非空即告诉 launch：这次运行的
// 记录与调度卡都已交代过）。
func (s *Service) launchExecutor(kind target.Kind, id string, params map[string]any, source *runSource) error {
	reg := s.registryFor(kind)
	if reg.held(id) || s.locks.Busy(kind, id) {
		return s.onTargetBusy(kind, id, params, source)
	}
	sess := s.startRun(runstore.Record{
		Target: target.Target{Kind: kind, ID: id}, Origin: source.origin, ScheduleID: source.scheduleID,
		Params: params, Process: &runstore.Process{Mode: runstore.ProcessExecutor},
	}, source)
	runID := sess.ID()
	reg.hold(id, func() { s.stopExecutor(runID) })
	s.beginScheduledRun(source)
	if err := spawnExecutor(s, kind, id, runID); err != nil {
		err = fmt.Errorf("启动执行器失败: %w", err)
		s.endRun(sess, -1, err, nil)
		s.finishScheduleRun(source, source.token, -1, err, 0)
		reg.end(id)
		return err
	}
	sess.Detach() // 日志、心跳与终态从此归执行器
	return nil
}

// spawnExecutorProcess 拉起真正的执行器进程：同一可执行文件的 run 子命令，标准输出与
// 标准错误落进该次运行目录下的 executor.log（执行器自己不往这里写运行内容，留下的
// 只会有 panic 之类的意外）。放进新进程组，不随应用的终端信号走。
func (s *Service) spawnExecutorProcess(_ target.Kind, _ string, runID string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "run", "--record", runID, "--allow-ai", "--base-dir", s.baseDir)
	cmd.Env = append(os.Environ(), executorEnv+"=1")
	runner.DetachProcessGroup(cmd)
	if logFile, err := os.OpenFile(filepath.Join(s.baseDir, runstore.DirName, runID, "executor.log"),
		os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
		cmd.Stdout, cmd.Stderr = logFile, logFile
		defer logFile.Close()
	}
	return cmd.Start()
}

// registryFor 返回某种目标的进程内簿记。
func (s *Service) registryFor(kind target.Kind) *runRegistry {
	switch kind {
	case target.Workflow:
		return s.wfRunning
	case target.AI:
		return s.aiRunning
	}
	return s.running
}

// stopExecutor 请求停止一条执行器运行：在它的目录下写停止标记。
func (s *Service) stopExecutor(runID string) {
	if err := s.runs.RequestStop(runID); err != nil {
		s.appLog.Log("run.stop.failed", map[string]any{"run_id": runID, "error": err.Error()})
	}
}

// adoptExecutorRuns 在应用启动时把仍在运行的执行器运行登记进进程内簿记：
// 调度卡知道它们在跑，界面上也能停它们（取消入口是写停止标记）。
func (s *Service) adoptExecutorRuns() {
	for _, rec := range s.runs.List(runstore.Filter{Status: runstore.StatusRunning}) {
		if rec.Process == nil || rec.Process.Mode != runstore.ProcessExecutor {
			continue
		}
		runID := rec.ID
		s.registryFor(rec.Target.Kind).hold(rec.Target.ID, func() { s.stopExecutor(runID) })
	}
}

// watchExecutorRuns 定期核对在途的执行器运行，直到 ctx 结束。
func (s *Service) watchExecutorRuns(ctx context.Context) {
	ticker := time.NewTicker(executorPollEvery)
	defer ticker.Stop()
	for {
		s.pollExecutorRuns()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// pollExecutorRuns 核对每一条在途的执行器运行。应用内的运行不在此列——它们有自己的
// 执行路径。
func (s *Service) pollExecutorRuns() {
	for _, rec := range s.runs.List(runstore.Filter{Status: runstore.StatusRunning}) {
		if rec.Process == nil || rec.Process.Mode != runstore.ProcessExecutor {
			continue
		}
		s.pollExecutorRun(rec.ID)
	}
}

// pollExecutorRun 核对一条执行器运行；发现它已结束时收尾：撤销进程内登记、通知前端、
// 更新调度卡。
func (s *Service) pollExecutorRun(runID string) {
	rec, ended := s.runs.Poll(runID)
	if !ended {
		return
	}
	s.registryFor(rec.Target.Kind).end(rec.Target.ID)
	s.notify(eventRunsChanged, runsChangedPayload(rec.ID, rec.Status, rec.Target.Kind, rec.Target.ID))
	if rec.ScheduleID != "" {
		s.finishScheduleFromRecord(rec)
	}
}

// finishScheduleFromRecord 用一条执行器运行的终态更新调度卡的最近结果。只接「这张卡
// 正等着的那一次运行」——内存里是更新的另一次运行时不覆盖。
func (s *Service) finishScheduleFromRecord(rec runstore.Record) {
	s.scheduleMu.Lock()
	state := s.scheduleRuns[rec.ScheduleID]
	if state != nil && state.Running && state.LastRun != nil && state.LastRun.RunID == rec.ID {
		s.scheduleRuns[rec.ScheduleID] = &scheduleRunState{Token: state.Token, LastRun: lastRunFromRecord(rec)}
	}
	s.scheduleMu.Unlock()
	s.emitScheduleChanged(rec.ScheduleID)
}

// ResumeRun 续跑：以一条 AI 运行记录的同一份输入，加上 resume: <session_id>，发起一次
// 新的手动运行（留在应用进程内）。返回新运行的 run-id。
// 只有 AI 运行能续跑——续接的是 Agent 的会话；上一次运行没留下会话 id 时也续不了。
func (s *Service) ResumeRun(runID string) (string, error) {
	rec, err := s.runs.Get(runID)
	if errors.Is(err, runstore.ErrNotFound) {
		return "", fmt.Errorf("未知的运行记录 %q", runID)
	}
	if err != nil {
		return "", err
	}
	if rec.Target.Kind != target.AI {
		return "", fmt.Errorf("只有 AI 运行可以续跑（这条是 %s）", targetLabel(rec.Target.Kind))
	}
	sessionID := rec.Outputs["session_id"]
	if sessionID == "" {
		return "", fmt.Errorf("这次运行没有留下会话 id，无法续跑")
	}
	params := make(map[string]any, len(rec.Params)+1)
	for k, v := range rec.Params {
		params[k] = v
	}
	params["resume"] = sessionID
	source := &runSource{origin: runstore.OriginManual}
	if err := s.runAi(rec.Target.ID, params, source); err != nil {
		return "", err
	}
	return source.runID, nil
}
