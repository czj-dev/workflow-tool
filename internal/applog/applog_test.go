package applog

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func readLines(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if text == "" {
		return nil
	}
	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	return lines
}

func TestOpenCreatesLogDirAndAppendsNDJSON(t *testing.T) {
	dir := t.TempDir()
	logger, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer logger.Close()
	path := filepath.Join(dir, "logs", "app.log")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("Open did not create %s: %v", path, err)
	}

	logger.Log("schedule.trigger", map[string]any{"schedule_id": "nightly", "run_id": "r1"})
	logger.Log("run.skipped", map[string]any{"reason": "目标正在运行"})

	lines := readLines(t, path)
	if len(lines) != 2 {
		t.Fatalf("lines = %q, want 2", lines)
	}
	var first map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatalf("line is not JSON: %v", err)
	}
	if first["event"] != "schedule.trigger" || first["schedule_id"] != "nightly" || first["run_id"] != "r1" {
		t.Fatalf("unexpected record: %v", first)
	}
	if ts, _ := first["time"].(string); ts == "" || !strings.Contains(ts, "T") {
		t.Fatalf("time missing or not RFC3339: %v", first)
	}
	if strings.Contains(lines[0], "<") || strings.Contains(lines[0], "\\u003c") {
		t.Fatalf("HTML characters should not be escaped: %q", lines[0])
	}
}

func TestReopenKeepsExistingContentAndCountsSize(t *testing.T) {
	dir := t.TempDir()
	first, err := open(dir, 1<<20, 3)
	if err != nil {
		t.Fatal(err)
	}
	first.Log("one", nil)
	first.Close()

	second, err := open(dir, 1<<20, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if second.size == 0 {
		t.Fatal("reopened logger did not adopt the existing file size")
	}
	second.Log("two", nil)
	if got := len(readLines(t, filepath.Join(dir, "logs", "app.log"))); got != 2 {
		t.Fatalf("reopen truncated the log: %d lines", got)
	}
}

func TestRotationKeepsAtMostConfiguredFilesWithoutSplittingLines(t *testing.T) {
	dir := t.TempDir()
	// 每行约 50 字节：60 字节的上限容一行，第二行触发轮转
	logger, err := open(dir, 60, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer logger.Close()
	const total = 9
	for i := 0; i < total; i++ {
		logger.Log("tick", map[string]any{"i": i})
	}
	logs := filepath.Join(dir, "logs")
	for i := 1; i <= 2; i++ {
		if _, err := os.Stat(filepath.Join(logs, "app.log."+strconv.Itoa(i))); err != nil {
			t.Fatalf("rotated file app.log.%d missing: %v", i, err)
		}
	}
	if _, err := os.Stat(filepath.Join(logs, "app.log.3")); !os.IsNotExist(err) {
		t.Fatalf("rotation kept more than 3 files: %v", err)
	}
	// 每个留存文件都是完整的 JSON 行（没有行被上限切断），且合计正好是最近写入的那些
	seen := map[int]bool{}
	for _, name := range []string{"app.log", "app.log.1", "app.log.2"} {
		for _, line := range readLines(t, filepath.Join(logs, name)) {
			var rec map[string]any
			if err := json.Unmarshal([]byte(line), &rec); err != nil {
				t.Fatalf("%s holds a split line %q: %v", name, line, err)
			}
			seen[int(rec["i"].(float64))] = true
		}
	}
	// 最新的那条一定在；被轮转掉的最早的几条不在
	if !seen[total-1] {
		t.Fatalf("newest record lost: %v", seen)
	}
	for i := 0; i < total; i++ {
		if i > total-1-3 && !seen[i] {
			t.Fatalf("latest records must all survive rotation, missing %d: %v", i, seen)
		}
	}
}

func TestOversizedSingleLineStillGetsWritten(t *testing.T) {
	dir := t.TempDir()
	logger, err := open(dir, 10, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer logger.Close()
	logger.Log("big", map[string]any{"payload": strings.Repeat("x", 500)})
	lines := readLines(t, filepath.Join(dir, "logs", "app.log"))
	if len(lines) != 1 || !strings.Contains(lines[0], "big") {
		t.Fatalf("oversized line dropped: %q", lines)
	}
}

func TestNilLoggerAndNilFieldsAreSafe(t *testing.T) {
	var logger *Logger
	logger.Log("noop", nil) // 不 panic

	dir := t.TempDir()
	logger, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer logger.Close()
	logger.Log("plain", nil)
	lines := readLines(t, filepath.Join(dir, "logs", "app.log"))
	if len(lines) != 1 {
		t.Fatalf("lines = %q", lines)
	}
	var rec map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &rec); err != nil || rec["event"] != "plain" {
		t.Fatalf("unexpected record %q: %v", lines[0], err)
	}
}

func TestOpenFailsWhenLogsPathIsNotADirectory(t *testing.T) {
	dir := t.TempDir()
	blocker := filepath.Join(dir, "logs")
	if err := os.WriteFile(blocker, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir); err == nil {
		t.Fatal("expected Open to fail when logs/ cannot be created")
	}
}

func TestCloseIsIdempotentAndLogAfterCloseIsDropped(t *testing.T) {
	dir := t.TempDir()
	logger, err := open(dir, 1<<20, 3)
	if err != nil {
		t.Fatal(err)
	}
	logger.Log("before-close", nil)
	if err := logger.Close(); err != nil {
		t.Fatal(err)
	}
	if err := logger.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	logger.Log("after-close", nil) // 已关闭的日志不再接收，也不 panic
	lines := readLines(t, filepath.Join(dir, "logs", "app.log"))
	if len(lines) != 1 || !strings.Contains(lines[0], "before-close") {
		t.Fatalf("lines = %q", lines)
	}
}

func TestLogOutputIsLineDelimitedUnderConcurrentWriters(t *testing.T) {
	dir := t.TempDir()
	logger, err := open(dir, 1<<20, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer logger.Close()
	done := make(chan struct{})
	for w := 0; w < 8; w++ {
		go func(w int) {
			defer func() { done <- struct{}{} }()
			for i := 0; i < 50; i++ {
				logger.Log("concurrent", map[string]any{"w": w, "i": i})
			}
		}(w)
	}
	for w := 0; w < 8; w++ {
		<-done
	}
	f, err := os.Open(filepath.Join(dir, "logs", "app.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	count := 0
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var rec map[string]any
		if err := json.Unmarshal(sc.Bytes(), &rec); err != nil {
			t.Fatalf("interleaved or torn line %q: %v", sc.Text(), err)
		}
		count++
	}
	if count != 8*50 {
		t.Fatalf("count = %d, want %d", count, 8*50)
	}
}
