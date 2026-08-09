package scrcpy

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"time"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// recordingEntry tracks one in-flight headless scrcpy recording. The process is
// detached (background) so it outlives the record-start operation; record-stop
// looks it up by device serial to stop it.
type recordingEntry struct {
	cmd  *exec.Cmd
	path string
	done chan struct{} // closed once the recording process has fully exited
}

var (
	recordingMu sync.Mutex
	recordings  = make(map[string]*recordingEntry) // keyed by device serial
)

// handleScrcpyStart runs scrcpy in the foreground for the lifetime of the action.
// scrcpy blocks until its window closes, so RunStreaming ties the process to
// op.Ctx — cancelling the action kills the whole process group (handled by
// adbcore). A cancelled/expired ctx is treated as a clean stop (exit 0).
func handleScrcpyStart(op *adb.OpContext) adb.OpResult {
	scrcpyPath := op.ScrcpyPath()
	if scrcpyPath == "" {
		return adb.OpResult{ExitCode: 2, Err: adbcore.NewOperationError("scrcpy-start", "scrcpy binary is not available", "", false)}
	}

	args := optionsFromParams(op).ToArgs()
	if op.Serial != "" {
		args = append([]string{"--serial", op.Serial}, args...)
	}

	op.EmitProgress("Starting scrcpy session...")

	// Capture=false: a mirror session can run for hours; we stream each line via
	// Emit instead of buffering the whole transcript in memory.
	res, err := adbcore.RunStreaming(op.Ctx, adbcore.StreamingRequest{
		Command: scrcpyPath,
		Args:    args,
		Timeout: op.Timeout,
		Capture: false,
		OnLine: func(stream, line string) {
			if line == "" {
				return
			}
			if stream == "stderr" {
				op.EmitStderr(line)
				return
			}
			op.EmitStdout(line)
		},
	})
	if err != nil {
		// Context cancellation/timeout == the user stopped the session; not an error.
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			op.EmitStdout("scrcpy session stopped")
			return adb.OpResult{ExitCode: 0, Stdout: "scrcpy session stopped"}
		}
		return adb.OpResult{ExitCode: -1, Err: err, Stderr: err.Error()}
	}
	if res.ExitCode != 0 {
		op.EmitStderr(res.Stderr)
		return adb.OpResult{
			ExitCode: res.ExitCode,
			Stderr:   res.Stderr,
			Err:      adbcore.NewOperationError("scrcpy-start", "scrcpy exited with an error", res.Stderr, false),
		}
	}
	op.EmitStdout("scrcpy session ended")
	return adb.OpResult{ExitCode: 0, Stdout: "scrcpy session ended"}
}

// handleScrcpyRecordStart launches scrcpy headless (--no-playback) writing to
// RECORD_PATH, then returns immediately. The process is tracked in the package
// registry so scrcpy-record-stop can terminate it.
func handleScrcpyRecordStart(op *adb.OpContext) adb.OpResult {
	scrcpyPath := op.ScrcpyPath()
	if scrcpyPath == "" {
		return adb.OpResult{ExitCode: 2, Err: adbcore.NewOperationError("scrcpy-record-start", "scrcpy binary is not available", "", false)}
	}
	recordPath := op.ParamStr("RECORD_PATH")
	if recordPath == "" {
		return adb.OpResult{ExitCode: 2, Err: adbcore.NewOperationError("scrcpy-record-start", "RECORD_PATH is required", "", false)}
	}

	key := op.Serial
	recordingMu.Lock()
	if _, exists := recordings[key]; exists {
		recordingMu.Unlock()
		op.EmitStderr("a recording is already in progress for this device")
		return adb.OpResult{ExitCode: 1, Err: adbcore.NewOperationError("scrcpy-record-start", "Recording already in progress", "stop the current recording first", true)}
	}
	recordingMu.Unlock()

	opts := optionsFromParams(op)
	args := []string{"--no-playback", "--record=" + recordPath}
	if op.Serial != "" {
		args = append(args, "--serial="+op.Serial)
	}
	args = append(args, opts.recordArgs()...)

	// Background process: detached from op.Ctx so it survives after this handler
	// returns. The ADB env var points scrcpy at the resolved adb binary (scrcpy
	// honors the ADB environment variable before searching PATH).
	cmd := exec.Command(scrcpyPath, args...)
	if adbPath := op.AdbPath(); adbPath != "" {
		cmd.Env = append(os.Environ(), "ADB="+adbPath)
	}

	if err := cmd.Start(); err != nil {
		return adb.OpResult{
			ExitCode: -1,
			Err:      adbcore.NewOperationError("scrcpy-record-start", "Failed to start scrcpy recording", err.Error(), true),
			Stderr:   err.Error(),
		}
	}

	entry := &recordingEntry{cmd: cmd, path: recordPath, done: make(chan struct{})}
	recordingMu.Lock()
	recordings[key] = entry
	recordingMu.Unlock()

	// Reap the process and self-clean the registry. If scrcpy exits on its own
	// (device disconnect, crash), the entry is removed so record-stop reports the
	// right state rather than dangling.
	go func() {
		_ = cmd.Wait()
		recordingMu.Lock()
		if cur, ok := recordings[key]; ok && cur == entry {
			delete(recordings, key)
		}
		recordingMu.Unlock()
		close(entry.done)
	}()

	msg := fmt.Sprintf("Recording started: %s", recordPath)
	op.EmitStdout(msg)
	return adb.OpResult{ExitCode: 0, Stdout: recordPath}
}

// handleScrcpyRecordStop terminates the active headless recording for op.Serial.
// It signals Interrupt (graceful), waits up to 5s, then falls back to Kill —
// matching ADBKit's stop flow — and confirms the output file is non-empty.
func handleScrcpyRecordStop(op *adb.OpContext) adb.OpResult {
	key := op.Serial
	recordingMu.Lock()
	entry, ok := recordings[key]
	recordingMu.Unlock()
	if !ok || entry == nil {
		op.EmitStderr("no active recording for this device")
		return adb.OpResult{ExitCode: 1, Err: adbcore.NewOperationError("scrcpy-record-stop", "No active recording found", "start a recording before stopping", true)}
	}

	if entry.cmd != nil && entry.cmd.Process != nil {
		_ = entry.cmd.Process.Signal(os.Interrupt)
		select {
		case <-entry.done:
		case <-time.After(5 * time.Second):
			_ = entry.cmd.Process.Kill()
			<-entry.done
		}
	}

	// Defensive cleanup in case the reaper goroutine hasn't removed it yet.
	recordingMu.Lock()
	if cur, ok := recordings[key]; ok && cur == entry {
		delete(recordings, key)
	}
	recordingMu.Unlock()

	// Abnormal-exit detection: if scrcpy failed to capture, the file is missing
	// or empty — surface a clear error rather than a silent success.
	if info, err := os.Stat(entry.path); err != nil || info.Size() == 0 {
		op.EmitStderr("recording stopped but the output file is missing or empty")
		return adb.OpResult{ExitCode: 1, Err: adbcore.NewOperationError("scrcpy-record-stop", "Recording file was not created", "scrcpy may have failed to capture video", true)}
	}

	op.EmitStdout(entry.path)
	return adb.OpResult{ExitCode: 0, Stdout: entry.path}
}
