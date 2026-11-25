package scrcpy

import (
	"slices"
	"testing"
)

func TestToArgsRecord(t *testing.T) {
	// 录制路径 + 显式格式：两个 flag 都在。
	args := (Options{RecordPath: "/tmp/录.mp4", RecordFormat: "mkv"}).ToArgs()
	if !slices.Contains(args, "--record=/tmp/录.mp4") {
		t.Fatalf("应输出 --record，got %v", args)
	}
	if !slices.Contains(args, "--record-format=mkv") {
		t.Fatalf("应输出 --record-format，got %v", args)
	}

	// 未填录制路径：不出现任何录制 flag（普通投屏不受影响）。
	for _, arg := range (Options{MaxSize: 1280}).ToArgs() {
		if arg == "--record=/tmp/x.mp4" || len(arg) > 9 && arg[:9] == "--record" {
			t.Fatalf("未填 RECORD_PATH 时不应输出录制 flag，got %v", arg)
		}
	}
}
