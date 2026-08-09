package packagemgr

import (
	"strings"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// runOrFail 执行一次 adb ExecRequest。
// 成功（exit 0）返回 (res, nil)；执行失败或非零退出返回 (nil, &OpResult)。
// 非零退出时会通过 op.EmitStderr 推送 stderr 并构造结构化 OperationError。
func runOrFail(op *adb.OpContext, opName, failMsg string, req adbcore.ExecRequest, retryable bool) (*adbcore.ExecResult, *adb.OpResult) {
	res, err := adbcore.RunCommand(op.Ctx, req)
	if res == nil {
		// adbcore 在进程无法启动时返回 (nil, *OperationError)。
		return nil, &adb.OpResult{ExitCode: -1, Err: err, Stderr: err.Error()}
	}
	if res.ExitCode != 0 {
		op.EmitStderr(res.Stderr)
		return nil, &adb.OpResult{
			ExitCode: res.ExitCode,
			Stderr:   res.Stderr,
			Err:      adbcore.NewOperationError(opName, failMsg, strings.TrimSpace(res.Stderr), retryable),
		}
	}
	return res, nil
}

// parsePackagesList 把 PACKAGES 入参（换行或逗号分隔）拆成去空白后的非空切片。
func parsePackagesList(raw string) []string {
	out := make([]string, 0, 4)
	for _, chunk := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == '\n' || r == '\r' || r == ',' || r == ';' || r == ' ' || r == '\t'
	}) {
		trimmed := strings.TrimSpace(chunk)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
