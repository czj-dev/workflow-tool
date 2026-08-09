package file

import (
	"fmt"
	"os"
	"path"
	"strconv"
	"strings"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// Entry describes one remote filesystem entry, parsed from `ls -lAL`.
type Entry struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Type        string `json:"type"`
	Size        int64  `json:"size"`
	SizeHuman   string `json:"sizeHuman"`
	Permissions string `json:"permissions"`
	ModifiedAt  string `json:"modifiedAt"`
	IsHidden    bool   `json:"isHidden"`
}

// StorageInfo describes device storage usage, parsed from `df -k`.
type StorageInfo struct {
	MountPoint string `json:"mountPoint"`
	TotalBytes int64  `json:"totalBytes"`
	UsedBytes  int64  `json:"usedBytes"`
	FreeBytes  int64  `json:"freeBytes"`
	UsedPct    int    `json:"usedPct"`
}

// ---- result / error builders ------------------------------------------------

// paramErr emits detail and returns a precondition-failure OpResult (exit 2).
func paramErr(op *adb.OpContext, opName, message, detail string) adb.OpResult {
	if detail == "" {
		detail = message
	}
	e := adbcore.NewOperationError(opName, message, detail, false)
	op.EmitStderr(detail)
	return adb.OpResult{ExitCode: 2, Err: e, Stderr: detail}
}

// abortWith emits an existing OperationError and returns an exit-2 OpResult.
// Used for normalize/validate/stat pre-flight failures.
func abortWith(op *adb.OpContext, opName string, err error) adb.OpResult {
	detail := err.Error()
	op.EmitStderr(detail)
	return adb.OpResult{ExitCode: 2, Err: err, Stderr: detail}
}

// cancelledResult returns a user-cancelled failure OpResult.
func cancelledResult(opName string) adb.OpResult {
	e := adbcore.NewOperationError(opName, "Operation cancelled by user", "context cancelled", false)
	return adb.OpResult{ExitCode: -1, Err: e, Stderr: e.Error()}
}

// runFail builds a failure OpResult from a RunCommand error, preferring the
// captured stderr/stdout over the Go error string.
func runFail(op *adb.OpContext, opName, message string, res *adbcore.ExecResult, err error, retryable bool) adb.OpResult {
	detail := ""
	code := -1
	if res != nil {
		detail = strings.TrimSpace(res.Stderr)
		if detail == "" {
			detail = strings.TrimSpace(res.Stdout)
		}
		code = res.ExitCode
	} else {
		detail = err.Error()
	}
	if detail == "" {
		detail = message
	}
	op.EmitStderr(detail)
	return adb.OpResult{
		ExitCode: code,
		Err:      adbcore.NewOperationError(opName, message, detail, retryable),
		Stderr:   detail,
	}
}

// resultErrorMessage extracts a human-readable message from an OpResult.
func resultErrorMessage(res adb.OpResult) string {
	if res.Err != nil {
		return res.Err.Error()
	}
	return res.Stderr
}

// ---- remote path handling ---------------------------------------------------

// normalizeRemotePath trims, defaults to /sdcard/, rejects null/newline bytes,
// ensures a leading slash, and cleans the result.
func normalizeRemotePath(remotePath string) (string, error) {
	trimmed := strings.TrimSpace(remotePath)
	if trimmed == "" {
		trimmed = defaultPath
	}
	if strings.Contains(trimmed, "\x00") {
		return "", adbcore.NewOperationError("validate_remote_path", "Invalid remote path", "path contains null byte", false)
	}
	if strings.Contains(trimmed, "\n") || strings.Contains(trimmed, "\r") {
		return "", adbcore.NewOperationError("validate_remote_path", "Invalid remote path", "path contains newline characters", false)
	}
	if !strings.HasPrefix(trimmed, "/") {
		trimmed = "/" + trimmed
	}
	cleaned := path.Clean(trimmed)
	if cleaned == "." {
		cleaned = defaultPath
	}
	return cleaned, nil
}

// validateRemoteMutationPath refuses mutating the device root or protected
// system partitions (defense-in-depth on top of adb's own read-only mounts).
func validateRemoteMutationPath(operationName, remotePath string) error {
	cleaned := path.Clean(strings.TrimSpace(remotePath))
	if cleaned == "." || cleaned == "/" {
		return adbcore.NewOperationError(operationName, "Remote path is too broad", "refusing to modify device root path", false)
	}
	restrictedPaths := []string{
		"/acct", "/apex", "/bin", "/config", "/data", "/dev", "/etc",
		"/init", "/mnt", "/proc", "/product", "/root", "/sbin", "/sys",
		"/system", "/system_ext", "/vendor", "/vendor_dlkm", "/odm_dlkm", "/metadata",
	}
	for _, restricted := range restrictedPaths {
		if cleaned == restricted || strings.HasPrefix(cleaned, restricted+"/") {
			return adbcore.NewOperationError(operationName, "Remote path is protected", fmt.Sprintf("refusing to modify protected device path: %s", restricted), false)
		}
	}
	return nil
}

func joinRemotePath(parentPath, name string) string {
	if strings.TrimSpace(parentPath) == "" {
		return path.Clean("/" + strings.TrimLeft(name, "/"))
	}
	return path.Clean(path.Join(parentPath, name))
}

// quoteShellArg single-quotes a path for safe inclusion in an `adb shell` argv.
// Paths passed to `adb push`/`adb pull` are NOT shell-interpolated and must NOT
// be quoted; only `adb shell <cmd> <arg>` values go through the device shell.
func quoteShellArg(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

// ---- host path handling -----------------------------------------------------

// statHostPath returns FileInfo for a local host path or an OperationError.
func statHostPath(opName, hostPath string) (os.FileInfo, error) {
	info, err := os.Stat(hostPath)
	if err != nil {
		return nil, adbcore.NewOperationError(opName, "Path could not be accessed", err.Error(), false)
	}
	return info, nil
}

// ---- output parsing ---------------------------------------------------------

// parseFileListOutput parses `ls -lAL` output into entries, dropping hidden
// entries when showHidden is false.
func parseFileListOutput(output, parentPath string, showHidden bool) ([]Entry, error) {
	entries := make([]Entry, 0)
	for _, rawLine := range splitLines(output) {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "total ") {
			continue
		}
		entry, ok, err := parseFileListLine(line, parentPath)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		if !showHidden && entry.IsHidden {
			continue
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

func parseFileListLine(line, parentPath string) (Entry, bool, error) {
	parts := strings.Fields(line)
	if len(parts) < 8 {
		return Entry{}, false, fmt.Errorf("unexpected ls output: %s", line)
	}
	permissions := parts[0]
	name := strings.Join(parts[7:], " ")
	if permissions != "" && permissions[0] == 'l' {
		name = strings.TrimSpace(strings.Split(name, " -> ")[0])
	}
	if name == "." || name == ".." || name == "" {
		return Entry{}, false, nil
	}
	sizeValue, err := strconv.ParseInt(parts[4], 10, 64)
	if err != nil {
		sizeValue = 0
	}
	entryType := parseFileType(permissions)
	entry := Entry{
		Name:        name,
		Path:        joinRemotePath(parentPath, name),
		Type:        entryType,
		Size:        sizeValue,
		SizeHuman:   formatFileSize(sizeValue),
		Permissions: permissions,
		ModifiedAt:  parts[5] + " " + parts[6],
		IsHidden:    strings.HasPrefix(name, "."),
	}
	if entryType == dirType {
		entry.Size = 0
		entry.SizeHuman = sizeDirNone
	}
	return entry, true, nil
}

func parseFileType(permissions string) string {
	if permissions == "" {
		return otherType
	}
	switch permissions[0] {
	case 'd':
		return dirType
	case 'l':
		return symlinkType
	case '-':
		return regularType
	default:
		return otherType
	}
}

// parseStorageInfoOutput parses `df -k` output into the first usable row.
func parseStorageInfoOutput(output string) (StorageInfo, error) {
	for _, rawLine := range splitLines(output) {
		line := strings.TrimSpace(rawLine)
		if strings.HasPrefix(line, "Filesystem") || line == "" {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 6 {
			continue
		}
		totalKB, err1 := strconv.ParseInt(parts[1], 10, 64)
		usedKB, err2 := strconv.ParseInt(parts[2], 10, 64)
		freeKB, err3 := strconv.ParseInt(parts[3], 10, 64)
		if err1 != nil || err2 != nil || err3 != nil {
			continue
		}
		pctStr := strings.TrimSuffix(parts[4], "%")
		pct, _ := strconv.Atoi(pctStr)
		return StorageInfo{
			MountPoint: parts[len(parts)-1],
			TotalBytes: totalKB * 1024,
			UsedBytes:  usedKB * 1024,
			FreeBytes:  freeKB * 1024,
			UsedPct:    pct,
		}, nil
	}
	return StorageInfo{}, fmt.Errorf("no valid df output found")
}

// parseDirectorySizeOutput returns the size field of the first `du -sh` line.
func parseDirectorySizeOutput(output string) string {
	line := firstNonEmptyLine(output)
	if line == "" {
		return sizeDirNone
	}
	parts := strings.Fields(line)
	if len(parts) == 0 {
		return sizeDirNone
	}
	return parts[0]
}

// ---- progress / formatting --------------------------------------------------

// parseAdbPercent parses a decimal percent string, tolerating surrounding spaces.
func parseAdbPercent(s string) int {
	pct := 0
	for _, c := range s {
		if c >= '0' && c <= '9' {
			pct = pct*10 + int(c-'0')
		}
	}
	return pct
}

func formatFileSize(size int64) string {
	if size < 0 {
		return sizeUnknown
	}
	if size < 1024 {
		return fmt.Sprintf("%d B", size)
	}
	units := []string{"KB", "MB", "GB", "TB"}
	value := float64(size)
	unitIndex := -1
	for value >= 1024 && unitIndex < len(units)-1 {
		value /= 1024
		unitIndex++
	}
	if unitIndex < 0 {
		return fmt.Sprintf("%d B", size)
	}
	return fmt.Sprintf("%.1f %s", value, units[unitIndex])
}

// isTransientADBError classifies network/device-flakiness error fragments so the
// transfer loop knows whether a retry is worth attempting.
func isTransientADBError(detail string) bool {
	normalized := strings.ToLower(strings.TrimSpace(detail))
	if normalized == "" {
		return false
	}
	transientFragments := []string{
		"device offline", "device not found", "no such device",
		"connection reset", "broken pipe", "protocol fault",
		"transport error", "resource temporarily unavailable",
	}
	for _, fragment := range transientFragments {
		if strings.Contains(normalized, fragment) {
			return true
		}
	}
	return false
}

// splitLines splits output on both '\n' and '\r' to tolerate mixed line endings.
func splitLines(output string) []string {
	normalized := strings.ReplaceAll(output, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	return strings.Split(normalized, "\n")
}

func firstNonEmptyLine(output string) string {
	for _, line := range splitLines(output) {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// formatEntry renders an Entry as a single readable line for the frontend.
func formatEntry(e Entry) string {
	tag := "?"
	switch e.Type {
	case dirType:
		tag = "D"
	case regularType:
		tag = "F"
	case symlinkType:
		tag = "L"
	}
	hidden := ""
	if e.IsHidden {
		hidden = " (hidden)"
	}
	return fmt.Sprintf("[%s] %-9s %-14s %s%s", tag, e.SizeHuman, e.ModifiedAt, e.Name, hidden)
}

// formatStorage renders a StorageInfo as a single readable line.
func formatStorage(s StorageInfo) string {
	return fmt.Sprintf("%s: %s / %s used (%d%%), %s free",
		s.MountPoint,
		formatFileSize(s.UsedBytes),
		formatFileSize(s.TotalBytes),
		s.UsedPct,
		formatFileSize(s.FreeBytes))
}
