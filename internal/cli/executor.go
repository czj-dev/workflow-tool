package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"workflow-tool/internal/airun"
	"workflow-tool/internal/runner"
	"workflow-tool/internal/runstore"
)

// 执行器（M4）：调度到点与立即运行不由应用进程自己跑，而是拉起同一可执行文件的 run 子命令
// （run --record <run-id>），不随应用退出而终止。应用先建好运行记录，执行器在这里接手：
//
//	接手记录（runstore.Attach）→ 占目标锁 → 运行，输出落进运行日志 → 落终态、释放锁
//
// 接手排在一切加载之前：应用的核对循环只认记录里的心跳与进程身份，加载目标与依赖
// 要花秒级时间——先加载后接手的话，拉起到接手之间这条记录没有 pid 也没有心跳，核对
// 循环会把运行误判成中断，执行器随后的接手必然失败（M4 上线后调度全部「没有过程」
// 的竞态就是它；runstore.AttachGrace 兜住接手前残留的盲窗）。
//
// 运行期间每 heartbeatEvery 回写一次心跳；每 stopPollEvery 看一眼停止标记（应用写入
// runs/<run-id>/STOP），见到即取消——取消经 ctx 传导，runner 杀掉整个进程组，以 cancelled
// 收尾。不依赖 POSIX 信号，Windows 同样可用。
//
// 执行器是 headless 的 run 子命令，应用组装与调度器都不在这里启动——定时任务不会再拉起
// 定时任务。

// ExecuteRecord 以执行器的身份接手并跑完一条运行记录，返回进程退出码。
// allowAI 为 true 时放行 AI 任务与含 AI 步骤的 workflow（调度可以指向它们）。
// 接手不了（没有这条记录、已终结）返回 exitCLIError，不动任何记录。
// 接手先于加载：见文件头的说明。
func ExecuteRecord(ctx context.Context, baseDir, runID string, allowAI bool) int {
	sess, err := runstore.Attach(baseDir, runID)
	if err != nil {
		fmt.Fprintln(os.Stderr, "执行器无法接手运行记录:", err)
		return exitCLIError
	}
	e := loadEnv(baseDir)
	e.allowAI = allowAI
	return e.executeSession(ctx, sess)
}

// executeRecord 接手一条运行记录并跑完它（执行环境已就绪，测试直入这条路径）。
func (e *env) executeRecord(ctx context.Context, runID string) int {
	sess, err := runstore.Attach(e.baseDir, runID)
	if err != nil {
		fmt.Fprintln(os.Stderr, "执行器无法接手运行记录:", err)
		return exitCLIError
	}
	return e.executeSession(ctx, sess)
}

// executeSession 跑一条已接手的运行记录。心跳与停止标记的轮询从进入这一刻就转起来：
// 解析目标、构造执行段都可能耗时，别让它们再制造一段没有心跳的空窗。
func (e *env) executeSession(ctx context.Context, sess *runstore.Session) int {
	tgt := sess.Target()
	log := runstore.NewLogEmitter(tgt.Kind == runstore.KindWorkflow)
	log.Sink = sess

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stopWatching := e.watchRun(cancel, sess, filepath.Join(e.baseDir, runstore.DirName, sess.ID(), runstore.StopFile))
	defer stopWatching()

	resolved, cerr := e.resolve(tgt.ID, string(tgt.Kind))
	if cerr != nil {
		return e.finishRecord(sess, log, cliFailure(cerr), "")
	}

	res, rules := e.runTarget(ctx, resolved, sess.Params(), "", func(stream, line string) { log.Output(stream, line) })
	return e.finishRecord(sess, log, res, rules)
}

// finishRecord 把一次执行的结果落进运行记录：先写 done 行（终态落定后日志不再可写），
// 再写终态。返回进程退出码。
func (e *env) finishRecord(sess *runstore.Session, log *runstore.LogEmitter, res runner.Result, rules string) int {
	tgt := sess.Target()
	// 调度到点撞上运行中的目标（应用预检与这里真正占锁之间只有微秒级窗口）：规格「冲突
	// 只跳过」——留档为 skipped、没有过程，不覆盖上一次真实运行的结果。
	var cliErr *cliError
	if errors.As(res.Err, &cliErr) && cliErr.Kind == "target_locked" && sess.Origin() == runstore.OriginSchedule {
		sess.Finish(runstore.StatusSkipped, res.Err.Error(), nil, nil)
		return res.ExitCode
	}
	var readout map[string]any
	if tgt.Kind == runstore.KindAI && len(res.Outputs) > 0 {
		readout = airun.Readout(res.Outputs, res.Duration)
	}
	log.Done(res.ExitCode, errText(res.Err), res.Duration, readout, tgt.Kind != runstore.KindWorkflow)
	sess.SetRules(rules)
	status, reason := runstore.Outcome(res.ExitCode, res.Err)
	sess.Finish(status, reason, &res.ExitCode, res.Outputs)
	return res.ExitCode
}

// watchRun 起一个协程：按间隔回写心跳、轮询停止标记；见到标记即取消运行。返回的函数停掉协程。
func (e *env) watchRun(cancel context.CancelFunc, sess *runstore.Session, stopPath string) (stop func()) {
	done := make(chan struct{})
	go func() {
		heartbeat := time.NewTicker(e.heartbeatEvery)
		poll := time.NewTicker(e.stopPollEvery)
		defer heartbeat.Stop()
		defer poll.Stop()
		for {
			select {
			case <-done:
				return
			case <-heartbeat.C:
				sess.Heartbeat()
			case <-poll.C:
				if _, err := os.Stat(stopPath); err == nil {
					cancel()
					return
				}
			}
		}
	}()
	return func() { close(done) }
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
