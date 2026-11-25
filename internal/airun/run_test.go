package airun

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"workflow-tool/internal/runner"
	"workflow-tool/internal/workflow"
)

// slowCli 是一个只会拖时间的假 AI CLI：供超时用例。
const slowCli = `#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-slow"}'
sleep 30
`

// echoCli 把子进程环境里的 NOTE 与 TOPIC 打到 stderr：供步骤 env 用例。
const echoCli = `#!/bin/sh
printf 'NOTE<%s>|TOPIC<%s>\n' "$NOTE" "$TOPIC" 1>&2
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}'
`

// fakeCliEnv 建一个把 config.yaml 的 AI_CLI 指向给定假 CLI 的执行环境。
func fakeCliEnv(t *testing.T, script string) (Deps, map[string]string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("假 AI CLI 是 sh 脚本")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "fake-ai.sh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return Deps{BaseDir: dir}, map[string]string{"AI_CLI": filepath.Join(dir, "fake-ai.sh")}
}

// collect 返回一个记下每一行的 emit，以及存放它们的切片。
func collect() (runner.EmitFunc, *[]string) {
	var lines []string
	return func(stream, line string) { lines = append(lines, stream+":"+line) }, &lines
}

// 构造阶段就失败（缺必填参数）：不启动进程，原因推到 stderr，产出标明失败，守则为空。
func TestRunReportsBuildFailureOnStderr(t *testing.T) {
	lt := loadTask(t, "id: demo\ntitle: 演示\nparams:\n  - { id: TOPIC, type: text, required: true }\nprompt: 介绍一下 ${TOPIC}\n")
	emit, lines := collect()

	res, rules := Run(context.Background(), lt, Deps{}, Options{Params: map[string]any{}}, emit)
	if res.ExitCode != -1 || res.Err == nil || !strings.Contains(res.Err.Error(), "TOPIC") {
		t.Fatalf("build failure result = %+v", res)
	}
	if res.Outputs["success"] != "false" || rules != "" {
		t.Fatalf("outputs/rules on build failure = %v / %q", res.Outputs, rules)
	}
	if len(*lines) != 1 || !strings.HasPrefix((*lines)[0], "stderr:") {
		t.Fatalf("build failure was not announced on stderr: %v", *lines)
	}
}

// 超时是失败不是取消：原因写明上限与续接办法，底层原因仍是 DeadlineExceeded；
// 已经拿到的 session_id 留在产出里。守则全文随结果返回，供运行记录留档。
func TestRunTimeoutNamesTheLimitAndKeepsTheCause(t *testing.T) {
	deps, global := fakeCliEnv(t, slowCli)
	lt := loadTask(t, "id: slow\ntitle: 慢\nprompt: 慢慢来\ntimeout: 1s\n")
	emit, _ := collect()

	res, rules := Run(context.Background(), lt, deps, Options{Global: global}, emit)
	if !errors.Is(res.Err, context.DeadlineExceeded) {
		t.Fatalf("timeout error lost its cause: %v", res.Err)
	}
	var timeout *TimeoutError
	if !errors.As(res.Err, &timeout) || timeout.Limit != time.Second || !strings.Contains(res.Err.Error(), "resume") {
		t.Fatalf("timeout error = %v, want the actionable message naming the 1s limit", res.Err)
	}
	if res.Outputs["session_id"] != "sess-slow" || rules == "" {
		t.Fatalf("outputs/rules after a timeout = %v / %q", res.Outputs, rules)
	}
}

// 工作流的 AI 步骤：params 原样交给 Build（${VAR} 在那里展开成提示词），step env 先用
// merged 展开 ${VAR}，再覆盖任务定义里的同名 env。
func TestStepExpandsStepEnvAndPassesParamsThrough(t *testing.T) {
	deps, global := fakeCliEnv(t, echoCli)
	global["NOTE"] = "from-config"
	lt := loadTask(t, "id: demo\ntitle: 演示\nparams:\n  - { id: TOPIC, type: text }\nprompt: 介绍一下 ${TOPIC}\nenv:\n  NOTE: from-task\n")
	emit, lines := collect()

	res := Step(context.Background(), lt, deps, Options{Global: global}, workflow.AIRequest{
		TaskID: "demo",
		Params: map[string]any{"TOPIC": "调度"},
		Env:    map[string]string{"NOTE": "step-${NOTE}"},
		Emit:   emit,
	}, map[string]any{"NOTE": "from-merged"}, emit)
	if res.ExitCode != 0 || res.Err != nil {
		t.Fatalf("step result = %+v", res)
	}
	joined := strings.Join(*lines, "\n")
	if !strings.Contains(joined, "NOTE<step-from-merged>") || !strings.Contains(joined, "TOPIC<调度>") {
		t.Fatalf("child process did not see the expanded env and the step params: %v", *lines)
	}
}

func TestAiReadoutIncludesSessionID(t *testing.T) {
	outputs := map[string]string{
		"session_id":    "abc-123",
		"cost_usd":      "0.02",
		"input_tokens":  "10",
		"output_tokens": "20",
	}
	r := Readout(outputs, 3_500_000_000)
	if r["sessionId"] != "abc-123" {
		t.Fatalf("sessionId 未透传: %+v", r)
	}
	if r["durationMs"] != int64(3500) {
		t.Fatalf("durationMs 不符: %+v", r)
	}
	// 失败/超时场景：result 事件未到达（无 cost/tokens），但 system/init 的 session_id 已写入，
	// sessionId 必须随 readout 下发（否则历史条目丢会话 id，无法查现场/--resume）。
	fail := Readout(map[string]string{"session_id": "abc"}, 0)
	if fail == nil || fail["sessionId"] != "abc" {
		t.Fatalf("失败时 sessionId 应单独撑起 readout，got %+v", fail)
	}
	// 完全无可读字段（连 session_id 都没有）才返回 nil
	if got := Readout(map[string]string{}, 0); got != nil {
		t.Fatalf("完全无可读字段应返回 nil，got %+v", got)
	}
}
