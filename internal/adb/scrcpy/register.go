package scrcpy

import "workflow-tool/internal/adb"

// init self-registers every scrcpy-domain operation. Operation names are disjoint
// from the other domains, so duplicate-registration panics are impossible here.
// The orchestrator adds a blank import of this package elsewhere so init runs.
func init() {
	adb.RegisterOperation("scrcpy-start", handleScrcpyStart)
	adb.RegisterOperation("scrcpy-record-start", handleScrcpyRecordStart)
	adb.RegisterOperation("scrcpy-record-stop", handleScrcpyRecordStop)
	adb.RegisterOperation("clipboard-set", handleClipboardSet)
	adb.RegisterOperation("clipboard-get", handleClipboardGet)
	adb.RegisterOperation("screenshot", handleScreenshot)
}
