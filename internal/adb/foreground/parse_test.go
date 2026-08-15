package foreground

import "testing"

// fixture 取自真机 Android 14 车机（DP8678GRP）实测 dumpsys 输出。
const activityDumpFixture = `ACTIVITY MANAGER RECENT TASKS (dumpsys activity recents)
    * Task{...}
ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
  Display #0 (activities from the recents)
    ResolvedActivity: TaskRecord{...}
    topResumedActivity=ActivityRecord{868ec37 u0 com.tinnove.launcher/.WallpaperActivity t271}
  ResumedActivity: ActivityRecord{868ec37 u0 com.tinnove.launcher/.WallpaperActivity t271}
`

func TestParseTopActivity(t *testing.T) {
	a, ok := parseTopActivity(activityDumpFixture)
	if !ok {
		t.Fatal("expected match, got none")
	}
	want := ForegroundActivity{
		Component: "com.tinnove.launcher/.WallpaperActivity",
		Package:   "com.tinnove.launcher",
		ShortName: "WallpaperActivity",
		TaskID:    "271",
	}
	if a != want {
		t.Fatalf("got %+v, want %+v", a, want)
	}
}

func TestParseTopActivityNoMatch(t *testing.T) {
	if _, ok := parseTopActivity("no such line here"); ok {
		t.Fatal("expected no match")
	}
}

func TestSplitComponentFull(t *testing.T) {
	pkg, short := splitComponent("com.baidu.che.codriver/.ui.DebugActivity")
	if pkg != "com.baidu.che.codriver" || short != "ui.DebugActivity" {
		t.Fatalf("got %q / %q", pkg, short)
	}
	// 无 '/' 的全名组件：包名取最后一个 '.' 前
	pkg, short = splitComponent("com.foo.BarActivity")
	if pkg != "com.foo" || short != "BarActivity" {
		t.Fatalf("got %q / %q", pkg, short)
	}
}
