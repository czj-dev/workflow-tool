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

// fixture 取自真机多屏车机实测：块头 `Display: mDisplayId=N (organized)`，
// 每块一组焦点字段；mFocusedApp 可为 null；mInputMethodTarget 常缺失（容忍）。
const windowDumpFixture = `Dump time : 2026-08-15 05:38:46.479
WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)
  Display: mDisplayId=8 (organized)
    init=800x480 213dpi mMinSizeOfResizeableTaskDp=220 cur=800x480 app=800x480 rng=480x480-800x800
  mLayoutSeq=27
  mCurrentFocus=Window{72a7495 u0 com.tinnove.wecarnavi}
  mFocusedApp=null

  mHoldScreenWindow=null
  Display: mDisplayId=0 (organized)
    init=4032x845 213dpi
  mLayoutSeq=2
  mCurrentFocus=Window{635c825 u0 com.tinnove.aiassistant}
  mFocusedApp=ActivityRecord{c49d49a u0 com.baidu.che.codriver/.ui.DebugActivity t304}
    mTopFullscreenOpaqueWindowState=Window{d801b8f u0 com.baidu.che.codriver/com.baidu.che.codriver.ui.DebugActivity}
`

// 无块头的输出（部分 ROM 单屏直接给全局焦点行）应归入单个隐式块。
const windowDumpNoHeaderFixture = `  mCurrentFocus=Window{abc u0 com.foo/.Bar}
  mFocusedApp=null
`

func TestParseWindowDisplays(t *testing.T) {
	ws := parseWindowDisplays(windowDumpFixture)
	if len(ws) != 2 {
		t.Fatalf("expected 2 displays, got %d: %+v", len(ws), ws)
	}
	if ws[0].ID != "8" || len(ws[0].Focus) != 2 {
		t.Fatalf("display[0] = %+v", ws[0])
	}
	if ws[0].Focus[0] != (focusKV{Key: "mCurrentFocus", Value: "Window{72a7495 u0 com.tinnove.wecarnavi}"}) {
		t.Fatalf("focus[0] = %+v", ws[0].Focus[0])
	}
	if ws[0].Focus[1] != (focusKV{Key: "mFocusedApp", Value: "null"}) {
		t.Fatalf("focus[1] = %+v", ws[0].Focus[1])
	}
	if ws[1].ID != "0" || len(ws[1].Focus) != 3 {
		t.Fatalf("display[1] = %+v", ws[1])
	}
	if ws[1].Focus[2].Key != "mTopFullscreenOpaqueWindowState" {
		t.Fatalf("focus[2] = %+v", ws[1].Focus[2])
	}
}

func TestParseWindowDisplaysNoHeaderFallback(t *testing.T) {
	ws := parseWindowDisplays(windowDumpNoHeaderFixture)
	if len(ws) != 1 {
		t.Fatalf("expected 1 implicit display, got %d", len(ws))
	}
	if ws[0].ID != "" || len(ws[0].Focus) != 2 {
		t.Fatalf("got %+v", ws[0])
	}
}

func TestParseWindowDisplaysEmpty(t *testing.T) {
	if ws := parseWindowDisplays("unrelated output"); len(ws) != 0 {
		t.Fatalf("expected 0, got %+v", ws)
	}
}
