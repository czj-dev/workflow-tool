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

func TestShortClass(t *testing.T) {
	if shortClass("android.widget.TextView") != "TextView" {
		t.Fatal("qualified class")
	}
	if shortClass("Button") != "Button" {
		t.Fatal("plain class")
	}
}

func TestUITreeNodeConversion(t *testing.T) {
	tree, err := parseUITree(uiTreeFixture)
	if err != nil {
		t.Fatal(err)
	}
	root := uiTreeNode(&tree.Node)
	// 根：无文本 → label=resource-id 身份；kind=class 短名；不可点 → detail 仅 bounds
	if root.Kind != "FrameLayout" || root.Label != "com.tinnove.aiassistant:id/root_view" {
		t.Fatalf("root = %+v", root)
	}
	if root.Detail != "[932,180][1984,1228]" {
		t.Fatalf("root detail = %q", root.Detail)
	}
	c := root.Children[0]
	if c.Kind != "FrameLayout" || c.Label != "com.tinnove.aiassistant:id/ai_cui_card_container" {
		t.Fatalf("container = %+v", c)
	}
	// 按钮：文本身份（%q 包裹）；id/clickable/bounds 依序进 detail
	btn := c.Children[0]
	if btn.Kind != "Button" || btn.Label != `"登录"` {
		t.Fatalf("button = %+v", btn)
	}
	if btn.Detail != "id=com.example.app:id/login · clickable · [100,800][300,880]" {
		t.Fatalf("button detail = %q", btn.Detail)
	}
	if len(btn.Children) != 0 {
		t.Fatalf("button should be leaf: %+v", btn.Children)
	}
}

func TestUITreeNodeAnonymousFallback(t *testing.T) {
	// 无文本无 id：label 兜底 class 短名（与 kind 相同，前端不重复显示标签）
	n := uiTreeNode(&UINode{Class: "android.widget.LinearLayout", Bounds: "[0,0][1920,96]"})
	if n.Kind != "LinearLayout" || n.Label != "LinearLayout" {
		t.Fatalf("n = %+v", n)
	}
	if n.Detail != "[0,0][1920,96]" {
		t.Fatalf("detail = %q", n.Detail)
	}
}

func TestUITreeNodeTruncatesText(t *testing.T) {
	long := strings.Repeat("很长的文本", 20) // 120 显示列，应截到 40 + "…"
	n := uiTreeNode(&UINode{Class: "android.widget.TextView", Text: long})
	if !strings.HasSuffix(n.Label, `…"`) {
		t.Fatalf("truncation marker missing: %q", n.Label)
	}
}
