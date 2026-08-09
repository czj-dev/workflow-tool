// Package file implements the file-transfer domain (push / pull / list /
// mkdir / delete / rename / directory-size / storage-info) as a set of
// self-registering adb operations.
//
// Each operation is registered with adb.RegisterOperation in init(); the
// orchestrator wires a blank import of this package so registration runs.
package file

import (
	"regexp"
	"time"

	"workflow-tool/internal/adb"
)

const (
	defaultPath = "/sdcard/"
	dirType     = "directory"
	regularType = "file"
	symlinkType = "symlink"
	otherType   = "other"
	sizeUnknown = "-"
	sizeDirNone = "--"

	transferRetries = 3
	transferDelay   = 2 * time.Second
)

// adbProgressPattern matches adb push/pull progress lines such as
// "[ 45%] /data/local/tmp/x.apk". adb writes these to stderr using '\r' to
// refresh the line; adbcore.RunStreaming splits on both '\n' and '\r', so each
// refresh arrives as its own line.
var adbProgressPattern = regexp.MustCompile(`\[\s*(\d+)%\]\s*(.*)`)

func init() {
	adb.RegisterOperation("push", handlePush)
	adb.RegisterOperation("pull", handlePull)
	adb.RegisterOperation("push-multiple", handlePushMultiple)
	adb.RegisterOperation("pull-multiple", handlePullMultiple)
	adb.RegisterOperation("list-files", handleListFiles)
	adb.RegisterOperation("mkdir", handleMkdir)
	adb.RegisterOperation("delete", handleDelete)
	adb.RegisterOperation("rename", handleRename)
	adb.RegisterOperation("directory-size", handleDirectorySize)
	adb.RegisterOperation("storage-info", handleStorageInfo)
}
