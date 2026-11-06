package file

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adb/binary"
	"workflow-tool/internal/runner"
)

func fakeListRunner(t *testing.T, script string, timeout time.Duration) *adb.ADBRunner {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake adb uses a POSIX shell")
	}
	filename := filepath.Join(t.TempDir(), "adb")
	if err := os.WriteFile(filename, []byte("#!/bin/sh\n"+script), 0o700); err != nil {
		t.Fatal(err)
	}
	return &adb.ADBRunner{
		Operation: "list-files", Timeout: timeout,
		ResolvePaths: func() binary.Paths { return binary.Paths{Adb: filename} },
	}
}

func runList(t *testing.T, ctx context.Context, r *adb.ADBRunner, params map[string]any) (runner.Result, adb.TreeFrame, []string) {
	t.Helper()
	var frame adb.TreeFrame
	var warnings []string
	result := r.Run(ctx, params, func(stream, line string) {
		if stream == "tree" {
			if err := json.Unmarshal([]byte(line), &frame); err != nil {
				t.Errorf("invalid tree: %v", err)
			}
		}
		if stream == "stderr" {
			warnings = append(warnings, line)
		}
	})
	return result, frame, warnings
}

func TestListFilesRecursesFourLevelsWithProperties(t *testing.T) {
	r := fakeListRunner(t, `
for last do :; done
case "$last" in
  "'/sdcard/'") printf '%s\n' 'drwxr-xr-x 2 root root 4096 2026-09-05 11:02 a' 'lrwxrwxrwx 1 root root 7 2026-09-05 11:02 shortcut -> a' 'drwxr-xr-x 2 root root 4096 2026-09-05 11:02 .hidden' ;;
  "'/sdcard/a/'") printf '%s\n' 'drwxr-xr-x 2 root root 4096 2026-09-05 11:02 b' ;;
  "'/sdcard/a/b/'") printf '%s\n' 'drwxr-xr-x 2 root root 4096 2026-09-05 11:02 c' ;;
  "'/sdcard/a/b/c/'") printf '%s\n' '-rw-r--r-- 1 root root 42 2026-09-05 11:02 file.txt' 'drwxr-xr-x 2 root root 4096 2026-09-05 11:02 deeper' ;;
  *) exit 19 ;;
esac
`, time.Second)
	result, frame, warnings := runList(t, context.Background(), r, map[string]any{"ADB_SERIAL": "fake", "REMOTE_PATH": "/sdcard"})
	if result.Err != nil || result.ExitCode != 0 || len(warnings) != 0 || !frame.DefaultExpandAll {
		t.Fatalf("result=%+v frame=%+v warnings=%v", result, frame, warnings)
	}
	root := frame.Nodes[0]
	if len(root.Children) != 2 || root.Children[1].Kind != "symlink" || root.Children[1].Properties["target"] != "a" {
		t.Fatalf("root children = %+v", root.Children)
	}
	file := root.Children[0].Children[0].Children[0].Children[0]
	if file.Path != "/sdcard/a/b/c/file.txt" || file.Properties["size"] != "42 B" || file.Properties["modifiedAt"] != "2026-09-05 11:02" || file.Properties["permissions"] != "-rw-r--r--" || file.Properties["type"] != "file" {
		t.Fatalf("file = %+v", file)
	}
	if len(root.Children[0].Children[0].Children[0].Children[1].Children) != 0 {
		t.Fatal("directory at depth 4 was traversed")
	}
}

func TestListFilesKeepsPartialTreeOnTimeout(t *testing.T) {
	r := fakeListRunner(t, `
for last do :; done
case "$last" in
  "'/sdcard/'") printf '%s\n' 'drwxr-xr-x 2 root root 4096 2026-09-05 11:02 a' 'drwxr-xr-x 2 root root 4096 2026-09-05 11:02 waiting' ;;
  "'/sdcard/a/'") sleep 3 ;;
esac
`, 900*time.Millisecond)
	result, frame, warnings := runList(t, context.Background(), r, map[string]any{"ADB_SERIAL": "fake"})
	if result.Err != nil || result.ExitCode != 0 || len(frame.Nodes) != 1 || len(frame.Nodes[0].Children) != 2 || frame.Nodes[0].Children[0].Properties["status"] != "未扫描完（超时）" || frame.Nodes[0].Children[1].Properties["status"] != "未扫描（超时）" || !strings.Contains(strings.Join(warnings, " "), "超时") {
		t.Fatalf("result=%+v frame=%+v warnings=%v", result, frame, warnings)
	}
}

func TestListFilesKeepsReadableSiblingsWhenChildIsDenied(t *testing.T) {
	r := fakeListRunner(t, `
for last do :; done
case "$last" in
  "'/sdcard/'") printf '%s\n' 'drwxr-xr-x 2 root root 4096 2026-09-05 11:02 denied' 'drwxr-xr-x 2 root root 4096 2026-09-05 11:02 readable' ;;
  "'/sdcard/denied/'") printf '%s\n' 'ls: permission denied' >&2; exit 1 ;;
  "'/sdcard/readable/'") printf '%s\n' '-rw-r--r-- 1 root root 10 2026-09-05 11:02 ok.txt' ;;
esac
`, time.Second)
	result, frame, warnings := runList(t, context.Background(), r, map[string]any{"ADB_SERIAL": "fake", "DEPTH": "2"})
	if result.Err != nil || result.ExitCode != 0 || len(frame.Nodes) != 1 || len(frame.Nodes[0].Children) != 2 || len(frame.Nodes[0].Children[1].Children) != 1 || !strings.Contains(strings.Join(warnings, " "), "denied") {
		t.Fatalf("result=%+v frame=%+v warnings=%v", result, frame, warnings)
	}
	if frame.Nodes[0].Children[0].Properties["error"] == nil {
		t.Fatalf("denied directory not marked: %+v", frame.Nodes[0].Children[0])
	}
}

func TestListFilesFailsWhenRootTimesOutBeforeAnyResult(t *testing.T) {
	r := fakeListRunner(t, `sleep 3`, 100*time.Millisecond)
	result, frame, _ := runList(t, context.Background(), r, map[string]any{"ADB_SERIAL": "fake"})
	if result.Err == nil || result.ExitCode == 0 || len(frame.Nodes) != 0 {
		t.Fatalf("result=%+v frame=%+v", result, frame)
	}
}

func TestListFilesFailsWhenRootIsUnreadable(t *testing.T) {
	r := fakeListRunner(t, `printf '%s\n' 'ls: permission denied' >&2; exit 1`, time.Second)
	result, frame, _ := runList(t, context.Background(), r, map[string]any{"ADB_SERIAL": "fake"})
	if result.Err == nil || result.ExitCode == 0 || len(frame.Nodes) != 0 {
		t.Fatalf("result=%+v frame=%+v", result, frame)
	}
}

func TestListFilesIncludesHiddenEntriesWhenRequested(t *testing.T) {
	r := fakeListRunner(t, `printf '%s\n' '-rw-r--r-- 1 root root 2 2026-09-05 11:02 .secret'`, time.Second)
	result, frame, _ := runList(t, context.Background(), r, map[string]any{"ADB_SERIAL": "fake", "DEPTH": "1", "SHOW_HIDDEN": true})
	if result.Err != nil || len(frame.Nodes) != 1 || len(frame.Nodes[0].Children) != 1 || frame.Nodes[0].Children[0].Label != ".secret" {
		t.Fatalf("result=%+v frame=%+v", result, frame)
	}
}

func TestListFilesRejectsInvalidDepth(t *testing.T) {
	r := fakeListRunner(t, `exit 99`, time.Second)
	for _, depth := range []string{"0", "-1", "bad"} {
		t.Run(depth, func(t *testing.T) {
			result, frame, _ := runList(t, context.Background(), r, map[string]any{"ADB_SERIAL": "fake", "DEPTH": depth})
			if result.Err == nil || len(frame.Nodes) != 0 {
				t.Fatalf("result=%+v frame=%+v", result, frame)
			}
		})
	}
}

func TestListFilesFailsOnDeviceDisconnection(t *testing.T) {
	r := fakeListRunner(t, `
for last do :; done
case "$last" in
  "'/sdcard/'") printf '%s\n' 'drwxr-xr-x 2 root root 4096 2026-09-05 11:02 a' ;;
  *) printf '%s\n' 'error: device offline' >&2; exit 1 ;;
esac
`, time.Second)
	result, frame, _ := runList(t, context.Background(), r, map[string]any{"ADB_SERIAL": "fake"})
	if result.Err == nil || result.ExitCode == 0 || len(frame.Nodes) != 0 {
		t.Fatalf("result=%+v frame=%+v", result, frame)
	}
}

func TestListFilesFailsOnUserCancellation(t *testing.T) {
	r := fakeListRunner(t, `sleep 3`, time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result, frame, _ := runList(t, ctx, r, map[string]any{"ADB_SERIAL": "fake"})
	if result.Err == nil || result.ExitCode == 0 || len(frame.Nodes) != 0 {
		t.Fatalf("result=%+v frame=%+v", result, frame)
	}
}

func TestListFilesDoesNotCapNodeCount(t *testing.T) {
	r := fakeListRunner(t, `
i=0
while [ "$i" -lt 5001 ]; do
  printf '%s\n' "-rw-r--r-- 1 root root 1 2026-09-05 11:02 file-$i"
  i=$((i + 1))
done
`, 5*time.Second)
	result, frame, warnings := runList(t, context.Background(), r, map[string]any{"ADB_SERIAL": "fake", "DEPTH": "1"})
	if result.Err != nil || len(frame.Nodes) != 1 || len(frame.Nodes[0].Children) != 5001 || len(warnings) != 0 {
		t.Fatalf("result=%+v nodes=%d warnings=%v", result, len(frame.Nodes), warnings)
	}
}
