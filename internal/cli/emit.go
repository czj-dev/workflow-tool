package cli

import (
	"encoding/json"
	"fmt"
	"os"

	"workflow-tool/internal/runner"
)

// exitCLIError 是 CLI 级错误（非命令失败）的进程退出码。
const exitCLIError = 2

// jsonEnc 是 *json.Encoder 的别名，省去调用方重复 import encoding/json。
type jsonEnc = json.Encoder

// cliError 是 CLI 级调用错误（「调错了」），区别于命令自身的非零退出（「命令失败了」）。
type cliError struct {
	Kind    string
	Message string
}

// outputLine / resultLine / errorLine 是 --json 模式的 NDJSON 三类对象。
type outputLine struct {
	Type   string `json:"type"`
	Stream string `json:"stream"`
	Line   string `json:"line"`
}

type resultLine struct {
	Type       string            `json:"type"`
	ExitCode   int               `json:"exit_code"`
	Success    bool              `json:"success"`
	DurationMs int64             `json:"duration_ms"`
	Error      *string           `json:"error"`
	Outputs    map[string]string `json:"outputs"`
}

type errorLine struct {
	Type    string `json:"type"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

// ndjsonEncoder 返回一个写 os.Stdout 的编码器：每次 Encode 自带换行，不转义 HTML。
func ndjsonEncoder() *json.Encoder {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	return enc
}

// rawEmit 原样透传：stderr 流进 os.Stderr，其余进 os.Stdout。
func rawEmit() runner.EmitFunc {
	return func(stream, line string) {
		if stream == "stderr" {
			fmt.Fprintln(os.Stderr, line)
			return
		}
		fmt.Fprintln(os.Stdout, line)
	}
}

// jsonEmit 把每行 emit 镜像成一条 output NDJSON（逐字镜像 stream，不解码）。
func jsonEmit(enc *json.Encoder) runner.EmitFunc {
	return func(stream, line string) {
		_ = enc.Encode(outputLine{Type: "output", Stream: stream, Line: line})
	}
}

// pickEmit 按模式选 emit。
func pickEmit(jsonMode bool, enc *json.Encoder) runner.EmitFunc {
	if jsonMode {
		return jsonEmit(enc)
	}
	return rawEmit()
}

// finish 收尾一次运行：json 模式打末行 result；raw 模式只在有错误时把错误写 stderr
// （正常输出已由 emit 实时打出）。返回命令退出码。
func finish(jsonMode bool, enc *json.Encoder, res runner.Result) int {
	if jsonMode {
		var errp *string
		if res.Err != nil {
			s := res.Err.Error()
			errp = &s
		}
		_ = enc.Encode(resultLine{
			Type:       "result",
			ExitCode:   res.ExitCode,
			Success:    res.ExitCode == 0,
			DurationMs: res.Duration.Milliseconds(),
			Error:      errp,
			Outputs:    res.Outputs,
		})
	} else if res.Err != nil {
		fmt.Fprintln(os.Stderr, res.Err.Error())
	}
	return res.ExitCode
}

// fail 报告 CLI 级错误：两种模式都写人读 stderr 行；json 模式另打一条 error NDJSON。
// 固定返回退出码 2。
func fail(jsonMode bool, enc *json.Encoder, e *cliError) int {
	fmt.Fprintf(os.Stderr, "错误[%s]: %s\n", e.Kind, e.Message)
	if jsonMode {
		_ = enc.Encode(errorLine{Type: "error", Kind: e.Kind, Message: e.Message})
	}
	return exitCLIError
}
