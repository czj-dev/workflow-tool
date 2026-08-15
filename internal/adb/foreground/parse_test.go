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

// fixture 裁剪自真机 uiautomator dump 产物（保留属性结构，删减层数）。
const uiTreeFixture = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="com.tinnove.aiassistant:id/root_view" class="android.widget.FrameLayout" package="com.tinnove.aiassistant" content-desc="" clickable="false" bounds="[932,180][1984,1228]">
    <node text="" resource-id="com.tinnove.aiassistant:id/ai_cui_card_container" class="android.widget.FrameLayout" clickable="false" bounds="[932,180][1984,1228]">
      <node text="登录" resource-id="com.example.app:id/login" class="android.widget.Button" clickable="true" bounds="[100,800][300,880]"/>
    </node>
  </node>
</hierarchy>`

func TestParseUITree(t *testing.T) {
	tree, err := parseUITree(uiTreeFixture)
	if err != nil {
		t.Fatal(err)
	}
	root := tree.Node
	if root.Class != "android.widget.FrameLayout" || root.ResourceID != "com.tinnove.aiassistant:id/root_view" {
		t.Fatalf("root = %+v", root)
	}
	if root.Bounds != "[932,180][1984,1228]" {
		t.Fatalf("bounds = %q", root.Bounds)
	}
	if len(root.Nodes) != 1 || len(root.Nodes[0].Nodes) != 1 {
		t.Fatalf("unexpected nesting: %+v", root)
	}
	btn := root.Nodes[0].Nodes[0]
	if btn.Text != "登录" || !btn.Clickable || btn.Class != "android.widget.Button" {
		t.Fatalf("button = %+v", btn)
	}
	if tree.Rotation != "0" {
		t.Fatalf("rotation = %q", tree.Rotation)
	}
}

func TestParseUITreeInvalid(t *testing.T) {
	if _, err := parseUITree("not xml at all"); err == nil {
		t.Fatal("expected error for invalid xml")
	}
	if _, err := parseUITree("<?xml version='1.0'?><other/>"); err == nil {
		t.Fatal("expected error for missing hierarchy root") // xml: 期望 hierarchy 元素
	}
}

func TestCountDescendants(t *testing.T) {
	tree, _ := parseUITree(uiTreeFixture)
	// root -> container -> button：root 后代 = 2
	if got := countDescendants(&tree.Node); got != 2 {
		t.Fatalf("got %d, want 2", got)
	}
	if got := countDescendants(&tree.Node.Nodes[0].Nodes[0]); got != 0 {
		t.Fatalf("leaf got %d", got)
	}
}
