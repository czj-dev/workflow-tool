package file

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// handlePush pushes a single local file or directory to the device.
// Params: LOCAL_PATH (required), REMOTE_PATH (required), ALLOW_PROTECTED (optional).
func handlePush(op *adb.OpContext) adb.OpResult {
	const opName = "push"
	localPath := op.ParamStr("LOCAL_PATH")
	if localPath == "" {
		return paramErr(op, opName, "LOCAL_PATH is required", "local path is empty")
	}
	info, err := statHostPath(opName, localPath)
	if err != nil {
		return abortWith(op, opName, err)
	}
	normalizedRemote, err := normalizeRemotePath(op.ParamStr("REMOTE_PATH"))
	if err != nil {
		return abortWith(op, opName, err)
	}
	if !op.ParamBool("ALLOW_PROTECTED") {
		if err := validateRemoteMutationPath(opName, normalizedRemote); err != nil {
			return abortWith(op, opName, err)
		}
	}

	fileName := info.Name()
	successMsg := fmt.Sprintf("Pushed %s -> %s", localPath, normalizedRemote)
	return runTransfer(op, opName, "push", fileName, []string{"push", localPath, normalizedRemote}, successMsg)
}

// handlePull pulls a single remote file to the host.
// Params: REMOTE_PATH (required), LOCAL_PATH (required).
func handlePull(op *adb.OpContext) adb.OpResult {
	const opName = "pull"
	normalizedRemote, err := normalizeRemotePath(op.ParamStr("REMOTE_PATH"))
	if err != nil {
		return abortWith(op, opName, err)
	}
	localPath := op.ParamStr("LOCAL_PATH")
	if localPath == "" {
		return paramErr(op, opName, "LOCAL_PATH is required", "local destination path is empty")
	}

	fileName := path.Base(normalizedRemote)
	successMsg := fmt.Sprintf("Pulled %s -> %s", normalizedRemote, localPath)
	// -a preserves the remote file's timestamp and mode.
	return runTransfer(op, opName, "pull", fileName, []string{"pull", "-a", normalizedRemote, localPath}, successMsg)
}

// handlePushMultiple pushes every child of a local directory into a remote
// directory. Params: LOCAL_PATH (local dir), REMOTE_PATH (remote dir).
func handlePushMultiple(op *adb.OpContext) adb.OpResult {
	const opName = "push-multiple"
	localDir := op.ParamStr("LOCAL_PATH")
	if localDir == "" {
		return paramErr(op, opName, "LOCAL_PATH is required", "local directory is empty")
	}
	info, err := statHostPath(opName, localDir)
	if err != nil {
		return abortWith(op, opName, err)
	}
	if !info.IsDir() {
		return paramErr(op, opName, "LOCAL_PATH must be a directory", "path is not a directory")
	}
	normalizedRemoteDir, err := normalizeRemotePath(op.ParamStr("REMOTE_PATH"))
	if err != nil {
		return abortWith(op, opName, err)
	}
	if !op.ParamBool("ALLOW_PROTECTED") {
		if err := validateRemoteMutationPath(opName, normalizedRemoteDir); err != nil {
			return abortWith(op, opName, err)
		}
	}

	entries, err := os.ReadDir(localDir)
	if err != nil {
		return abortWith(op, opName, adbcore.NewOperationError(opName, "Failed to read local directory", err.Error(), true))
	}

	success := 0
	var failures []string
	for _, e := range entries {
		if op.Ctx.Err() != nil {
			return cancelledResult(opName)
		}
		childLocal := filepath.Join(localDir, e.Name())
		childRemote := path.Join(normalizedRemoteDir, e.Name())
		res := runTransfer(op, opName, "push", e.Name(),
			[]string{"push", childLocal, childRemote},
			fmt.Sprintf("Pushed %s -> %s", childLocal, childRemote))
		if res.ExitCode == 0 && res.Err == nil {
			success++
		} else {
			failures = append(failures, fmt.Sprintf("%s: %s", e.Name(), resultErrorMessage(res)))
		}
	}
	return summarize(op, fmt.Sprintf("Pushed %d item(s) to %s", success, normalizedRemoteDir), len(entries), failures)
}

// handlePullMultiple pulls every child of a remote directory into a local
// directory. Params: REMOTE_PATH (remote dir), LOCAL_PATH (local dir).
func handlePullMultiple(op *adb.OpContext) adb.OpResult {
	const opName = "pull-multiple"
	localDir := op.ParamStr("LOCAL_PATH")
	if localDir == "" {
		return paramErr(op, opName, "LOCAL_PATH is required", "local destination directory is empty")
	}
	normalizedRemoteDir, err := normalizeRemotePath(op.ParamStr("REMOTE_PATH"))
	if err != nil {
		return abortWith(op, opName, err)
	}

	// Enumerate the remote directory so we know which children to pull.
	listRes, runErr := adbcore.RunCommand(op.Ctx, op.Adb("shell", "ls", "-lAL", quoteShellArg(normalizedRemoteDir)))
	if runErr != nil {
		return runFail(op, opName, "Failed to list remote directory", listRes, runErr, true)
	}
	entries, parseErr := parseFileListOutput(listRes.Stdout, normalizedRemoteDir, true)
	if parseErr != nil {
		return paramErr(op, opName, "Failed to parse remote directory listing", parseErr.Error())
	}

	success := 0
	var failures []string
	for _, e := range entries {
		if op.Ctx.Err() != nil {
			return cancelledResult(opName)
		}
		childLocal := filepath.Join(localDir, e.Name)
		res := runTransfer(op, opName, "pull", e.Name,
			[]string{"pull", "-a", e.Path, childLocal},
			fmt.Sprintf("Pulled %s -> %s", e.Path, childLocal))
		if res.ExitCode == 0 && res.Err == nil {
			success++
		} else {
			failures = append(failures, fmt.Sprintf("%s: %s", e.Name, resultErrorMessage(res)))
		}
	}
	return summarize(op, fmt.Sprintf("Pulled %d item(s) to %s", success, localDir), len(entries), failures)
}

// runTransfer executes one adb push or pull with progress emission and
// transient-error retries. Capture=false keeps the framework from buffering
// (large transfers); instead stderr is accumulated in onLine so transient
// errors can still be classified.
//
//   - opName     registered operation name (used in errors)
//   - direction  "push"/"pull" progress label
//   - fileName   default name shown in progress lines
//   - args       adb subcommand args (without -s serial; op.AdbStream adds it)
//   - successMsg emitted + returned as Stdout on success
func runTransfer(op *adb.OpContext, opName, direction, fileName string, args []string, successMsg string) adb.OpResult {
	transferCtx, cancel := context.WithCancel(op.Ctx)
	defer cancel()

	var stderrBuf bytes.Buffer
	for attempt := 1; attempt <= transferRetries; attempt++ {
		if err := transferCtx.Err(); err != nil {
			return cancelledResult(opName)
		}
		stderrBuf.Reset()
		onLine := func(stream, line string) {
			if m := adbProgressPattern.FindStringSubmatch(line); len(m) > 1 {
				name := fileName
				if len(m) > 2 {
					if base := path.Base(strings.TrimSpace(m[2])); base != "" && base != "." && base != "/" {
						name = base
					}
				}
				op.EmitProgress(fmt.Sprintf("%s %s: %d%%", direction, name, parseAdbPercent(m[1])))
				return
			}
			if stream == "stderr" {
				if trimmed := strings.TrimSpace(line); trimmed != "" {
					stderrBuf.WriteString(trimmed)
					stderrBuf.WriteByte('\n')
				}
			}
		}
		res, err := adbcore.RunStreaming(transferCtx, op.AdbStreamPTY(false, onLine, args...))
		if err == nil {
			op.EmitProgress(fmt.Sprintf("%s %s: 100%%", direction, fileName))
			op.EmitStdout(successMsg)
			return adb.OpResult{ExitCode: 0, Stdout: successMsg}
		}
		if transferCtx.Err() != nil {
			return cancelledResult(opName)
		}
		detail := strings.TrimSpace(stderrBuf.String())
		if detail == "" {
			detail = err.Error()
		}
		if !isTransientADBError(detail) || attempt == transferRetries {
			code := -1
			if res != nil {
				code = res.ExitCode
			}
			op.EmitStderr(detail)
			return adb.OpResult{
				ExitCode: code,
				Err:      adbcore.NewOperationError(opName, transferFailMessage(opName), detail, true),
				Stderr:   detail,
			}
		}
		// Transient error: back off then retry, unless cancelled.
		select {
		case <-transferCtx.Done():
			return cancelledResult(opName)
		case <-time.After(transferDelay):
		}
	}
	return cancelledResult(opName)
}

func transferFailMessage(opName string) string {
	if opName == "pull" || opName == "pull-multiple" {
		return "Failed to pull file"
	}
	return "Failed to push file"
}

// summarize emits a batch summary and returns a partial-success OpResult.
// Exit code is 0 when everything succeeded, 1 when any item failed.
func summarize(op *adb.OpContext, prefix string, total int, failures []string) adb.OpResult {
	msg := prefix
	code := 0
	if len(failures) > 0 {
		code = 1
		msg = fmt.Sprintf("%s. Failed: %d of %d. Details: %s", msg, len(failures), total, strings.Join(failures, " | "))
		for _, f := range failures {
			op.EmitStderr(f)
		}
	}
	op.EmitStdout(msg)
	return adb.OpResult{ExitCode: code, Stdout: msg}
}
