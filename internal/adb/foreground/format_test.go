package foreground

import (
	"strings"
	"testing"
)

func TestDisplayWidth(t *testing.T) {
	if displayWidth("abc") != 3 {
		t.Fatal("ascii")
	}
	if displayWidth("组件") != 4 { // 中文每字 2 列（等宽终端惯例）
		t.Fatal("cjk")
	}
}

func TestFormatActivity(t *testing.T) {
	a := ForegroundActivity{
		Component: "com.tinnove.launcher/.WallpaperActivity",
		Package:   "com.tinnove.launcher",
		ShortName: "WallpaperActivity",
		TaskID:    "271",
	}
	lines := formatActivity(a)
	if len(lines) != 5 {
		t.Fatalf("lines = %q", lines)
	}
	if !strings.HasPrefix(lines[0], "── 前台 Activity ") || !strings.HasSuffix(lines[0], "─") {
		t.Fatalf("title = %q", lines[0])
	}
	// 中文 key 与英文 key 均对齐到同一 value 起始列（显示宽度 6）
	if !strings.HasPrefix(lines[1], "  组件  com.tinnove.launcher") {
		t.Fatalf("component line = %q", lines[1])
	}
	if !strings.HasPrefix(lines[4], "  Task  #271") {
		t.Fatalf("task line = %q", lines[4])
	}
}

func TestFormatWindows(t *testing.T) {
	ws := []WindowDisplay{
		{ID: "8", Focus: []focusKV{
			{Key: "mCurrentFocus", Value: "Window{72a7495 u0 com.tinnove.wecarnavi}"},
			{Key: "mFocusedApp", Value: "null"},
		}},
		{ID: "0", Focus: []focusKV{
			{Key: "mCurrentFocus", Value: "Window{635c825 u0 com.tinnove.aiassistant}"},
			{Key: "mFocusedApp", Value: "ActivityRecord{c49d49a u0 com.baidu.che.codriver/.ui.DebugActivity t304}"},
			{Key: "mTopFullscreenOpaqueWindowState", Value: "Window{d801b8f u0 com.baidu.che.codriver/...}"},
		}},
	}
	lines := formatWindows(ws)
	joined := strings.Join(lines, "\n")
	for _, want := range []string{
		"── 焦点窗口 ",
		"[Display 8]",
		// key pad 到显示宽度 27：mCurrentFocus(13)+14 空格、mFocusedApp(11)+16、
		// mTopFullscreenOpaqueWindow(26)+1
		"mCurrentFocus              Window{72a7495 u0 com.tinnove.wecarnavi}",
		"mFocusedApp                null",
		"[Display 0]",
		// 长键名映射为短展示名（mTopFullscreenOpaqueWindowState → mTopFullscreenOpaqueWindow）
		"mTopFullscreenOpaqueWindow Window{d801b8f u0 com.baidu.che.codriver/...}",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in:\n%s", want, joined)
		}
	}
}

func TestFormatTreeNoLimit(t *testing.T) {
	tree, err := parseUITree(uiTreeFixture)
	if err != nil {
		t.Fatal(err)
	}
	lines := formatTree(tree, 0)
	joined := strings.Join(lines, "\n")
	// 标题含总节点数（root + container + button = 3 节点）
	if !strings.Contains(lines[0], "共 3 节点") {
		t.Fatalf("title = %q", lines[0])
	}
	for _, want := range []string{
		// 根：prefix="  "、无 connector
		"  android.widget.FrameLayout",
		// 根的 bounds 第二行（prefix + 6 空格）
		"        [932,180][1984,1228]",
		// container：prefix="  " + "└─ "
		"  └─ android.widget.FrameLayout",
		// button：prefix="     "（"  "+"   "）+ "└─ "，text 带 %q，id 全量
		`     └─ android.widget.Button "登录" id=com.example.app:id/login`,
		// button 属性行：prefix + 6 空格 + [clickable] + bounds
		"           [clickable] [100,800][300,880]",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in:\n%s", want, joined)
		}
	}
}

func TestFormatTreeDepthLimit(t *testing.T) {
	tree, _ := parseUITree(uiTreeFixture)
	lines := formatTree(tree, 1) // 显示到层 1（root+container），button（层 2）折叠
	joined := strings.Join(lines, "\n")
	if strings.Contains(joined, "android.widget.Button") {
		t.Fatalf("button should be folded:\n%s", joined)
	}
	// 折叠行出现在 container 的 children 位置：prefix="     " + "└─ …"，N=1
	if !strings.Contains(joined, "     └─ … (+1 子节点)") {
		t.Fatalf("fold marker missing:\n%s", joined)
	}
}

func TestFormatTreeTruncatesText(t *testing.T) {
	long := strings.Repeat("很长的文本", 20) // 120 显示列，应截到 40 + "…"
	tree := &UITree{Node: UINode{Class: "android.widget.TextView", Text: long}}
	lines := formatTree(tree, 0)
	if len(lines) != 2 { // 标题行 + 无 bounds 的单节点行
		t.Fatalf("lines = %q", lines)
	}
	if w := displayWidth(lines[0]); w > 80 {
		t.Fatalf("text not truncated, width=%d: %q", w, lines[0])
	}
	if !strings.HasSuffix(lines[1], `…"`) {
		t.Fatalf("truncation marker missing: %q", lines[1])
	}
}
