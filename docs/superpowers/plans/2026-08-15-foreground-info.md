# 前台信息 foreground-info Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 adb 域 `foreground-info` operation：一次运行输出前台 Activity、焦点窗口（多 display 分组）、View 树（uiautomator）三段格式化纯文本报告。

**Architecture:** 新建 `internal/adb/foreground/` 域包，`init()` 自注册 operation（与 package/logcat/file/scrcpy/input 同模式）。解析/排版全部纯函数（parse.go/format.go），采集与编排隔离（collect.go/register.go）。输出走现有 stdout 通道，零前端改动。

**Tech Stack:** Go 标准库（regexp / encoding/xml / strconv），`workflow-tool/internal/adb`（OpContext/RegisterOperation）、`workflow-tool/internal/adbcore`（RunCommand/NewOperationError）。

**Spec:** [docs/superpowers/specs/2026-08-15-foreground-info-design.md](../specs/2026-08-15-foreground-info-design.md)

## Global Constraints

- 解析目标格式以**真机实测**为准（Android 14 车机 DP8678GRP，serial `07ab9620cb257222_ANDROID`，本机 adb `C:\Users\ASUS\AppData\Local\Android\Sdk\platform-tools\adb.exe`）；不做 Android <10 兼容
- 三段彼此独立：某段失败只 emit 一行 `warning: ...`（走 stdout），其余段照常；**全部勾选段都失败才返回非 0**
- 未勾选的段不发命令、不输出
- `TREE_MAX_DEPTH` 空=不限；非正整数视为不限并附 warning
- action id 保留 `adb-foreground-activity`（兼容 workflow 引用）
- 所有注释、warning 文案用中文（项目惯例，见 internal/adb/input/input.go）
- 测试命令均须 `cd /c/Users/ASUS/Documents/workflow-tool` 后执行（Git Bash）

---

### Task 1: 前台 Activity 解析（parse.go）

**Files:**
- Create: `internal/adb/foreground/parse.go`
- Test: `internal/adb/foreground/parse_test.go`

**Interfaces:**
- Consumes: 无
- Produces: `type ForegroundActivity struct { Component, Package, ShortName, TaskID string }`；`func parseTopActivity(dump string) (ForegroundActivity, bool)`；`func splitComponent(comp string) (pkg, short string)`

- [ ] **Step 1: Write the failing test**

创建 `internal/adb/foreground/parse_test.go`：

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/adb/foreground -run TestParseTopActivity -v`
Expected: FAIL（`parseTopActivity` 未定义，编译错误）

- [ ] **Step 3: Write minimal implementation**

创建 `internal/adb/foreground/parse.go`：

```go
// Package foreground 是 adb 前台信息域：foreground-info operation 一次输出
// 前台 Activity、焦点窗口（多 display 分组）与 View 树（uiautomator 无障碍树）
// 的格式化报告。解析/排版均为纯函数，采集与编排见 collect.go / register.go。
package foreground

import (
	"regexp"
	"strings"
)

// ForegroundActivity 是 dumpsys activity activities 解析出的前台 Activity。
type ForegroundActivity struct {
	Component string // 完整组件串，如 com.tinnove.launcher/.WallpaperActivity
	Package   string
	ShortName string
	TaskID    string // 归属 task，如 "271"
}

// topResumedRe 匹配 Android 10+ 的 topResumedActivity 行（实测 Android 14 车机）：
// `    topResumedActivity=ActivityRecord{868ec37 u0 com.tinnove.launcher/.WallpaperActivity t271}`
// 兼容多用户 u\d+；旧字段 ResumedActivity: 与之并存，只认 topResumedActivity。
var topResumedRe = regexp.MustCompile(`topResumedActivity=ActivityRecord\{[^ ]+ u\d+ (\S+) t(\d+)\}`)

// parseTopActivity 从 dumpsys activity activities 全文解析前台 Activity，多命中取首个。
func parseTopActivity(dump string) (ForegroundActivity, bool) {
	m := topResumedRe.FindStringSubmatch(dump)
	if m == nil {
		return ForegroundActivity{}, false
	}
	pkg, short := splitComponent(m[1])
	return ForegroundActivity{Component: m[1], Package: pkg, ShortName: short, TaskID: m[2]}, true
}

// splitComponent 拆组件串：`pkg/.Short` 取 '/' 两侧（short 去前导 '.'，保留内部 '.'）；
// 无 '/' 的全名（com.foo.BarActivity）取最后一个 '.' 两侧。
func splitComponent(comp string) (pkg, short string) {
	if i := strings.LastIndex(comp, "/"); i >= 0 {
		return comp[:i], strings.TrimPrefix(comp[i+1:], ".")
	}
	if i := strings.LastIndex(comp, "."); i >= 0 {
		return comp[:i], comp[i+1:]
	}
	return comp, comp
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/adb/foreground -v`
Expected: PASS（3 个测试）

- [ ] **Step 5: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add internal/adb/foreground/ && git commit -m "feat(foreground): 前台 Activity 解析——topResumedActivity 纯函数"
```

---

### Task 2: 焦点窗口解析（按 display 分组）

**Files:**
- Modify: `internal/adb/foreground/parse.go`
- Test: `internal/adb/foreground/parse_test.go`

**Interfaces:**
- Consumes: 无
- Produces: `type focusKV struct { Key, Value string }`；`type WindowDisplay struct { ID string; Focus []focusKV }`；`func parseWindowDisplays(dump string) []WindowDisplay`

- [ ] **Step 1: Write the failing test**

追加到 `parse_test.go`：

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/adb/foreground -run TestParseWindowDisplays -v`
Expected: FAIL（`parseWindowDisplays` 未定义，编译错误）

- [ ] **Step 3: Write minimal implementation**

追加到 `parse.go`：

```go
// focusKV 是一行焦点键值对。
type focusKV struct {
	Key   string
	Value string
}

// WindowDisplay 是单个 display 的焦点窗口摘要。
type WindowDisplay struct {
	ID    string // display id，如 "8"；无块头 fallback 块为 ""
	Focus []focusKV
}

// 块头两种形态：真机 Android 14 车机 `Display: mDisplayId=8 (organized)`；
// 部分 ROM 为 `Display 8`。都认，避免对 OEM 格式押注单一形态。
var windowDisplayHeaderRes = []*regexp.Regexp{
	regexp.MustCompile(`^\s*Display: mDisplayId=(\d+)`),
	regexp.MustCompile(`^\s*Display (\d+)`),
}

// windowFocusKeys 是要提取的焦点键（按 dumpsys 输出顺序自然出现）。
var windowFocusKeys = []string{"mCurrentFocus", "mFocusedApp", "mInputMethodTarget", "mTopFullscreenOpaqueWindowState"}

// parseWindowDisplays 解析 dumpsys window displays：按块头分组，块内提取焦点键值行。
// 无块头而直接出现焦点行时归入单个隐式块（ID ""）。
func parseWindowDisplays(dump string) []WindowDisplay {
	var out []WindowDisplay
	cur := -1
	for _, raw := range strings.Split(dump, "\n") {
		matched := false
		for _, re := range windowDisplayHeaderRes {
			if m := re.FindStringSubmatch(raw); m != nil {
				out = append(out, WindowDisplay{ID: m[1]})
				cur = len(out) - 1
				matched = true
				break
			}
		}
		if matched {
			continue
		}
		line := strings.TrimSpace(raw)
		for _, key := range windowFocusKeys {
			v, ok := strings.CutPrefix(line, key+"=")
			if !ok {
				continue
			}
			if cur < 0 { // 无块头 fallback：隐式单块
				out = append(out, WindowDisplay{})
				cur = 0
			}
			out[cur].Focus = append(out[cur].Focus, focusKV{Key: key, Value: strings.TrimSpace(v)})
			break
		}
	}
	return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/adb/foreground -v`
Expected: PASS（6 个测试）

- [ ] **Step 5: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add internal/adb/foreground/ && git commit -m "feat(foreground): 焦点窗口解析——按 display 分组+无块头 fallback"
```

---

### Task 3: uiautomator XML 树解析

**Files:**
- Modify: `internal/adb/foreground/parse.go`
- Test: `internal/adb/foreground/parse_test.go`

**Interfaces:**
- Consumes: 无
- Produces: `type UINode struct { Class, Text, ResourceID, Bounds string; Clickable bool; Nodes []UINode }`；`type UITree struct { Rotation string; Node UINode }`；`func parseUITree(data string) (*UITree, error)`；`func countDescendants(n *UINode) int`

- [ ] **Step 1: Write the failing test**

追加到 `parse_test.go`：

```go
import (
	"encoding/xml"
	"testing"
)

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
```

注意：`TestParseUITreeInvalid` 第二个断言依赖 `encoding/xml` 对 `xml:"hierarchy"` 根元素的强校验——若实现未用 `XMLName xml.Name \`xml:"hierarchy"\`` 则该行为不成立。实现必须带上该字段。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/adb/foreground -run TestParseUITree -v`
Expected: FAIL（`parseUITree` 未定义，编译错误）

- [ ] **Step 3: Write minimal implementation**

追加到 `parse.go`（import 块加 `"encoding/xml"`）：

```go
// UINode 是 uiautomator dump 的一个节点（无障碍树，非字面 View 树——
// 用于定位可交互控件）。
type UINode struct {
	Class      string   `xml:"class,attr"`
	Text       string   `xml:"text,attr"`
	ResourceID string   `xml:"resource-id,attr"`
	Clickable  bool     `xml:"clickable,attr"`
	Bounds     string   `xml:"bounds,attr"`
	Nodes      []UINode `xml:"node"`
}

// UITree 是 uiautomator dump XML 的根。XMLName 强校验根元素是 hierarchy，
// 非 hierarchy 输出（错误信息）会 Unmarshal 失败。
type UITree struct {
	XMLName  xml.Name `xml:"hierarchy"`
	Rotation string   `xml:"rotation,attr"`
	Node     UINode   `xml:"node"`
}

// parseUITree 解析 uiautomator dump 的 XML。
func parseUITree(data string) (*UITree, error) {
	var t UITree
	if err := xml.Unmarshal([]byte(data), &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// countDescendants 统计节点全部后代数（不含自身），深度截断折叠计数用。
func countDescendants(n *UINode) int {
	c := 0
	for i := range n.Nodes {
		c += 1 + countDescendants(&n.Nodes[i])
	}
	return c
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/adb/foreground -v`
Expected: PASS（9 个测试）

- [ ] **Step 5: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add internal/adb/foreground/ && git commit -m "feat(foreground): uiautomator XML 树解析+后代计数"
```

---

### Task 4: 三段格式化排版（format.go）

**Files:**
- Create: `internal/adb/foreground/format.go`
- Test: `internal/adb/foreground/format_test.go`

**Interfaces:**
- Consumes: `ForegroundActivity` / `WindowDisplay` / `focusKV` / `UITree` / `UINode` / `countDescendants`（Task 1-3）
- Produces: `func formatActivity(a ForegroundActivity) []string`；`func formatWindows(ws []WindowDisplay) []string`；`func formatTree(t *UITree, maxDepth int) []string`（maxDepth ≤ 0 = 不限）；`func displayWidth(s string) int`

- [ ] **Step 1: Write the failing test**

创建 `internal/adb/foreground/format_test.go`（排版契约速览：树节点为**两行风格**——第一行 `class "text" id=...`，第二行几何属性 `[clickable] bounds`（前缀 + 6 空格，clickable 仅 true 时带标记，bounds 为空则无第二行）；深度语义：maxDepth = 允许显示的最大层号（根=0），children 层号超出即整棵折叠）：

```go
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
		// key pad 到显示宽度 27：mCurrentFocus(12)+15 空格、mFocusedApp(11)+16、
		// mTopFullscreenOpaqueWindow(25)+2
		"mCurrentFocus               Window{72a7495 u0 com.tinnove.wecarnavi}",
		"mFocusedApp                 null",
		"[Display 0]",
		// 长键名映射为短展示名（mTopFullscreenOpaqueWindowState → mTopFullscreenOpaqueWindow）
		"mTopFullscreenOpaqueWindow  Window{d801b8f u0 com.baidu.che.codriver/...}",
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
	if len(lines) != 1 { // 无 bounds → 单行
		t.Fatalf("lines = %q", lines)
	}
	if w := displayWidth(lines[0]); w > 80 {
		t.Fatalf("text not truncated, width=%d: %q", w, lines[0])
	}
	if !strings.HasSuffix(lines[0], "…\"") {
		t.Fatalf("truncation marker missing: %q", lines[0])
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/adb/foreground -run "TestFormat|TestDisplayWidth" -v`
Expected: FAIL（`formatActivity` 等未定义，编译错误）

- [ ] **Step 3: Write minimal implementation**

创建 `internal/adb/foreground/format.go`：

```go
package foreground

import (
	"fmt"
	"strings"
)

// sectionWidth 是段落标题分隔线总显示宽度。
const sectionWidth = 50

// attrIndent 是树节点属性行相对节点前缀的缩进（6 空格）。
const attrIndent = "      "

// displayWidth 按等宽终端惯例估算显示宽度：CJK 等宽字符算 2 列，其余 1 列。
func displayWidth(s string) int {
	w := 0
	for _, r := range s {
		if r >= 0x1100 && (r <= 0x115f || // Hangul Jamo
			r >= 0x2e80 && r <= 0xa4cf || // CJK 部首~Yi
			r >= 0xac00 && r <= 0xd7a3 || // Hangul 音节
			r >= 0xf900 && r <= 0xfaff || // CJK 兼容表意
			r >= 0xfe30 && r <= 0xfe4f || // CJK 兼容形式
			r >= 0xff00 && r <= 0xff60 || // 全角形式
			r >= 0xffe0 && r <= 0xffe6 ||
			r >= 0x20000 && r <= 0x3fffd) { // CJK 扩展
			w += 2
		} else {
			w++
		}
	}
	return w
}

// padDisplay 右侧补空格到目标显示宽度。
func padDisplay(s string, width int) string {
	if d := width - displayWidth(s); d > 0 {
		return s + strings.Repeat(" ", d)
	}
	return s
}

// sectionTitle 生成 `── name ──────` 分隔线（总宽 sectionWidth）。
func sectionTitle(name string) string {
	head := "── " + name + " "
	return head + strings.Repeat("─", max(2, sectionWidth-displayWidth(head)))
}

// formatActivity 输出前台 Activity 段。
func formatActivity(a ForegroundActivity) []string {
	kv := func(key, value string) string {
		return "  " + padDisplay(key, 6) + value
	}
	return []string{
		sectionTitle("前台 Activity"),
		kv("组件", a.Component),
		kv("短名", a.ShortName),
		kv("包名", a.Package),
		kv("Task", "#"+a.TaskID),
	}
}

// windowKeyShort 把超长 dumpsys 键名映射为短展示名（排版友好）。
var windowKeyShort = map[string]string{
	"mTopFullscreenOpaqueWindowState": "mTopFullscreenOpaqueWindow",
}

// formatWindows 输出焦点窗口段：每 display 一个 [Display N] 小节。
// ID 为空的 fallback 块标题为 [default]。
func formatWindows(ws []WindowDisplay) []string {
	lines := []string{sectionTitle("焦点窗口")}
	for _, w := range ws {
		title := w.ID
		if title == "" {
			title = "default"
		}
		lines = append(lines, "  [Display "+title+"]")
		for _, f := range w.Focus {
			key := windowKeyShort[f.Key]
			if key == "" {
				key = f.Key
			}
			lines = append(lines, "    "+padDisplay(key, 27)+f.Value)
		}
	}
	return lines
}

// formatTree 输出 View 树段。maxDepth ≤ 0 表示不限；>0 为允许显示的最大层号
// （根=0），children 层号超出时该子树整棵折叠为 `└─ … (+N 子节点)`。
func formatTree(t *UITree, maxDepth int) []string {
	total := countDescendants(&t.Node) + 1
	lines := []string{sectionTitle(fmt.Sprintf("View 树 · uiautomator · 共 %d 节点", total))}
	renderNode(&lines, &t.Node, "  ", "", 0, maxDepth)
	return lines
}

// renderNode 递归渲染一个节点及其子树（两行风格：语义行 + 几何属性行）。
//   prefix     本节点行前缀（已含所有祖先缩进）
//   connector  本节点树形连接线（"" 为根，"├─ "/"└─ "）
//   depth      根为 0
func renderNode(lines *[]string, n *UINode, prefix, connector string, depth, maxDepth int) {
	var b strings.Builder
	b.WriteString(prefix + connector + n.Class)
	if n.Text != "" {
		b.WriteString(" " + strconv.Quote(truncateDisplay(n.Text, 40)))
	}
	if n.ResourceID != "" {
		b.WriteString(" id=" + n.ResourceID)
	}
	*lines = append(*lines, b.String())
	if n.Bounds != "" {
		attr := n.Bounds
		if n.Clickable {
			attr = "[clickable] " + attr
		}
		*lines = append(*lines, prefix+attrIndent+attr)
	}
	// 深度截断：children 所在层（depth+1）超出 maxDepth 时整棵折叠。
	// 截断显示宽度恰为 40 时补 "…"：truncateDisplay 不负责加省略号，
	// 在此按「被截过」判断。
	if maxDepth > 0 && depth+1 > maxDepth && len(n.Nodes) > 0 {
		foldPrefix := childPrefix(prefix, connector)
		*lines = append(*lines, foldPrefix+"└─ … (+"+fmt.Sprint(countDescendants(n))+" 子节点)")
		return
	}
	for i := range n.Nodes {
		child := &n.Nodes[i]
		conn := "├─ "
		if i == len(n.Nodes)-1 {
			conn = "└─ "
		}
		renderNode(lines, child, childPrefix(prefix, connector), conn, depth+1, maxDepth)
	}
}

// childPrefix 由本节点的连接线推子节点前缀：根保持 prefix 不变；
// "└─ "（末位）后续空白缩进；"├─ " 竖线延续。
func childPrefix(prefix, connector string) string {
	switch connector {
	case "":
		return prefix
	case "└─ ":
		return prefix + "   "
	default:
		return prefix + "│  "
	}
}

// truncateDisplay 按显示宽度截断（返回串显示宽度 ≤ width），超出时以 "…" 结尾。
func truncateDisplay(s string, width int) string {
	w := 0
	for i, r := range s {
		rw := displayWidth(string(r))
		if w+rw > width {
			return s[:i] + "…"
		}
		w += rw
	}
	return s
}
```

（`strconv.Quote` 需在 import 块补 `"strconv"`。`truncateDisplay` 已内建省略号，`renderNode` 直接使用。）

树形缩进对照（与测试断言一致）：根 prefix=`"  "` → 根行 `  android...`、属性行 `        [bounds]`（2+6 空格）；container 行 `  └─ android...`、其子前缀 = `"  "+"   "`=5 空格 → button 行 `     └─ android.widget.Button "登录" ...`、属性行 `           [clickable] ...`（5+6 空格）；折叠行 = childPrefix+`└─ … (+N 子节点)`。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/adb/foreground -v`
Expected: PASS（15 个测试）

- [ ] **Step 5: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add internal/adb/foreground/ && git commit -m "feat(foreground): 三段格式化排版——标题/对齐/树形缩进/深度折叠"
```

---

### Task 5: 命令采集与 handler 编排

**Files:**
- Create: `internal/adb/foreground/collect.go`
- Create: `internal/adb/foreground/register.go`

**Interfaces:**
- Consumes: `adb.OpContext`（`Adb()`/`ParamStr`/`Params`/`Ctx`/`EmitStdout`）、`adbcore.RunCommand`/`adbcore.NewOperationError`、Task 1-4 的解析与排版函数
- Produces: operation `foreground-info` 注册（init 自登记）；`func collectActivity(op *adb.OpContext) (string, error)`、`func collectWindows(op *adb.OpContext) (string, error)`、`func collectUITree(op *adb.OpContext) (string, error)`

**说明**：handler 编排依赖真机，不做离线单测（spec 约定靠真机验证，见 Task 9）；本任务以 `go vet` + 编译通过 + 既有测试不回归为门槛。

- [ ] **Step 1: Write collect.go**

创建 `internal/adb/foreground/collect.go`：

```go
package foreground

import (
	"strings"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// runOrFail 执行一次 adb ExecRequest，非零退出时返回带上下文的 error
// （handler 对段级失败只发 warning、继续其余段，故这里返回 error 而非 OpResult）。
func runOrFail(op *adb.OpContext, req adbcore.ExecRequest) (*adbcore.ExecResult, error) {
	res, err := adbcore.RunCommand(op.Ctx, req)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, adbcore.NewOperationError("foreground-info", "adb command failed", strings.TrimSpace(res.Stderr), false)
	}
	return res, nil
}

// collectActivity 采集 dumpsys activity activities 全文（前台 Activity 解析输入）。
func collectActivity(op *adb.OpContext) (string, error) {
	res, err := runOrFail(op, op.Adb("shell", "dumpsys", "activity", "activities"))
	if err != nil {
		return "", err
	}
	return res.Stdout, nil
}

// collectWindows 采集 dumpsys window displays 全文（焦点窗口解析输入）。
func collectWindows(op *adb.OpContext) (string, error) {
	res, err := runOrFail(op, op.Adb("shell", "dumpsys", "window", "displays"))
	if err != nil {
		return "", err
	}
	return res.Stdout, nil
}

// uiDumpPath 是 uiautomator dump 的设备端中转文件。走文件中转而非
// exec-out /dev/tty：后者在部分 ROM 上不落盘、行为不稳（实测文件中转可靠）。
const uiDumpPath = "/sdcard/window_dump.xml"

// collectUITree 执行 uiautomator dump 并 cat 拉回 XML。
// 注意：dump 失败（如无障碍服务占用）时 exit code 可能为 0、错误信息走 stdout，
// 故必须校验 cat 结果含 <hierarchy 才算成功。
func collectUITree(op *adb.OpContext) (string, error) {
	if _, err := runOrFail(op, op.Adb("shell", "uiautomator", "dump", uiDumpPath)); err != nil {
		return "", err
	}
	res, err := runOrFail(op, op.Adb("shell", "cat", uiDumpPath))
	if err != nil {
		return "", err
	}
	if !strings.Contains(res.Stdout, "<hierarchy") {
		return "", adbcore.NewOperationError("foreground-info", "uiautomator dump produced no hierarchy xml", strings.TrimSpace(res.Stdout), true)
	}
	return res.Stdout, nil
}
```

- [ ] **Step 2: Write register.go**

创建 `internal/adb/foreground/register.go`：

```go
package foreground

import (
	"strconv"
	"strings"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

func init() {
	adb.RegisterOperation("foreground-info", handleForegroundInfo)
}

// paramBoolDefaultTrue 取 bool param，未传时默认 true（三个段开关的默认勾选语义；
// op.ParamBool 缺失返回 false，不适用）。
func paramBoolDefaultTrue(op *adb.OpContext, key string) bool {
	v, ok := op.Params[key]
	if !ok || v == nil {
		return true
	}
	switch t := v.(type) {
	case bool:
		return t
	case string:
		b, _ := strconv.ParseBool(strings.TrimSpace(t))
		return b
	}
	return true
}

// parseMaxDepth 解析 TREE_MAX_DEPTH：空=不限(0)；非正整数视为不限并 warning。
func parseMaxDepth(op *adb.OpContext) int {
	s := op.ParamStr("TREE_MAX_DEPTH")
	if s == "" {
		return 0
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		op.EmitStdout("warning: TREE_MAX_DEPTH=" + s + " 不是正整数，视为不限")
		return 0
	}
	return n
}

// handleForegroundInfo 编排三段：按勾选采集 → 解析 → 格式化 emit。
// 段级失败只 emit warning 继续其余段；全部勾选段失败才非 0。
func handleForegroundInfo(op *adb.OpContext) adb.OpResult {
	wantActivity := paramBoolDefaultTrue(op, "ACTIVITY")
	wantWindows := paramBoolDefaultTrue(op, "WINDOWS")
	wantTree := paramBoolDefaultTrue(op, "VIEW_TREE")
	maxDepth := parseMaxDepth(op)

	sections, failed := 0, 0
	first := true
	emitSection := func(lines []string) {
		if !first {
			op.EmitStdout("")
		}
		first = false
		for _, l := range lines {
			op.EmitStdout(l)
		}
	}
	fail := func(msg string) {
		failed++
		if !first {
			op.EmitStdout("")
		}
		first = false
		op.EmitStdout("warning: " + msg)
	}

	if wantActivity {
		sections++
		if dump, err := collectActivity(op); err != nil {
			fail("获取前台 Activity 失败: " + err.Error())
		} else if a, ok := parseTopActivity(dump); ok {
			emitSection(formatActivity(a))
		} else {
			fail("未解析到 topResumedActivity（无前台 Activity 或格式不符）")
		}
	}
	if wantWindows {
		sections++
		if dump, err := collectWindows(op); err != nil {
			fail("获取焦点窗口失败: " + err.Error())
		} else if ws := parseWindowDisplays(dump); len(ws) > 0 {
			emitSection(formatWindows(ws))
		} else {
			fail("未解析到焦点窗口字段（格式不符）")
		}
	}
	if wantTree {
		sections++
		if xmlData, err := collectUITree(op); err != nil {
			fail("获取 View 树失败: " + err.Error())
		} else if tree, err := parseUITree(xmlData); err != nil {
			fail("解析 uiautomator XML 失败: " + err.Error())
		} else {
			emitSection(formatTree(tree, maxDepth))
		}
	}

	if sections > 0 && failed == sections {
		msg := "所有勾选段均失败"
		opErr := adbcore.NewOperationError("foreground-info", msg, "", false)
		op.EmitStderr(msg)
		return adb.OpResult{ExitCode: 1, Err: opErr, Stderr: msg}
	}
	return adb.OpResult{ExitCode: 0}
}
```

- [ ] **Step 3: 编译 + 既有测试不回归**

Run: `cd /c/Users/ASUS/Documents/workflow-tool && go vet ./internal/adb/... && go test ./internal/adb/foreground -v`
Expected: vet 无输出；15 个测试 PASS

- [ ] **Step 4: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add internal/adb/foreground/ && git commit -m "feat(foreground): foreground-info handler——三段编排+段级容错"
```

---

### Task 6: 注册登记（main.go + registration_test.go）

**Files:**
- Modify: `main.go:19-23`（blank import 块）
- Modify: `internal/adb/registration_test.go`

**Interfaces:**
- Consumes: Task 5 的 init 自登记
- Produces: `foreground-info` 进入运行时路由表（29 个 operation）

**说明**：registration_test.go 的 blank import 会让 foreground 包 init 执行，故测试无法先行失败（TDD 红-绿不适用于纯登记改动）；本任务以「两文件同改 + 测试确认 29」为门槛。

- [ ] **Step 1: 改 main.go blank import**

在 `main.go` 的 blank import 块中按字母序插入（`file` 之后、`input` 之前），其余行不动：

```go
	_ "workflow-tool/internal/adb/foreground"
```

- [ ] **Step 2: 更新 registration_test.go**

三处改动：

```go
// 1) blank import 清单加一行（字母序，file 之后）：
	_ "workflow-tool/internal/adb/foreground"

// 2) 数量断言 28 → 29：
	if len(ops) < 29 {
		t.Fatalf("expected at least 29 registered operations, got %d: %v", len(ops), ops)
	}

// 3) want 列表 input 组之前加一组：
		// foreground (1)
		"foreground-info",
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/adb -v`
Expected: PASS（`TestOperationsRegistered` ok，29 个 operation）

- [ ] **Step 4: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add main.go internal/adb/registration_test.go && git commit -m "feat(foreground): 登记 foreground-info——main blank import+注册测试 29"
```

---

### Task 7: action YAML 替换

**Files:**
- Modify: `actions/adb-foreground-activity.yaml`（整体重写）

**Interfaces:**
- Consumes: Task 5 的 `foreground-info` operation、params 契约（ACTIVITY/WINDOWS/VIEW_TREE/TREE_MAX_DEPTH）
- Produces: UI 可见的「前台信息」动作（id 不变，workflow 引用兼容）

- [ ] **Step 1: 重写 YAML**

用以下内容整体替换 `actions/adb-foreground-activity.yaml`：

```yaml
id: adb-foreground-activity
title: 前台信息
icon: hi:test
description: 一键查看前台 Activity、焦点窗口（多 display 分组）与 View 树（uiautomator 无障碍树），格式化报告
params:
  - id: ACTIVITY
    label: 前台 Activity
    type: bool
    default: "true"
  - id: WINDOWS
    label: 焦点窗口
    type: bool
    default: "true"
  - id: VIEW_TREE
    label: View 树
    type: bool
    default: "true"
  - id: TREE_MAX_DEPTH
    label: 树深度上限（空=不限）
    type: text
presets:
  - name: 全部
    description: Activity + 焦点窗口 + View 树
    values: { ACTIVITY: true, WINDOWS: true, VIEW_TREE: true }
  - name: 仅 View 树
    description: uiautomator 无障碍树
    values: { ACTIVITY: false, WINDOWS: false, VIEW_TREE: true }
command:
  adb:
    operation: foreground-info
  timeout: 30s
```

- [ ] **Step 2: 验证 registry 加载不报错**

Run: `cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/registry -v`
Expected: PASS（YAML 校验逻辑无对应单测时至少包测试不回归；四选一互斥校验通过）

- [ ] **Step 3: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add actions/adb-foreground-activity.yaml && git commit -m "feat(foreground): 前台信息动作——shell 换 foreground-info 域形态+双 preset"
```

---

### Task 8: 文档同步（docs/action.md + CLAUDE.md）

**Files:**
- Modify: `docs/action.md`（operation 契约表 + 域概述句）
- Modify: `CLAUDE.md`（架构节 adb 子包树 + operation 数量两处）

**Interfaces:**
- Consumes: Task 1-7 的最终契约
- Produces: 面向使用者的完整字段参考（项目规定：schema 变动必须同步文档）

- [ ] **Step 1: docs/action.md 域概述句更新**

「adb 域形态」章节首段（约 203 行）：

`分发到原生 Go 封装的 adb 域服务（包管理 / logcat / 文件传输 / scrcpy）`
→
`分发到原生 Go 封装的 adb 域服务（包管理 / logcat / 文件传输 / scrcpy / 输入 / 前台信息）`

- [ ] **Step 2: docs/action.md 契约表新增小节**

在「**输入（1）**」小节表格之后、「scrcpy 选项表」之前插入：

```markdown
**前台信息（1）**

| operation | params | 说明 |
|---|---|---|
| `foreground-info` | `ACTIVITY`(bool,默认 true)、`WINDOWS`(bool,默认 true)、`VIEW_TREE`(bool,默认 true)、`TREE_MAX_DEPTH`(text,空=不限) | 一次输出三段格式化报告：前台 Activity（`topResumedActivity`）、焦点窗口（`dumpsys window displays` 按 display 分组的 `mCurrentFocus`/`mFocusedApp` 等摘要）、View 树（`uiautomator dump` 无障碍树，缩进树形，`TREE_MAX_DEPTH` 超出层折叠为 `… (+N 子节点)`）。段级失败仅 warning 不影响其余段，全失败才非 0；仅支持 Android 10+ 字段格式 |
```

- [ ] **Step 3: CLAUDE.md 两处更新**

架构节 adb 域结构树，`├── input/` 行后插入（保持树形注释风格）：

```
  ├── foreground/   前台信息 1 operation（foreground-info：前台 Activity/焦点窗口/View 树格式化报告）
```

架构节 adb 域说明句：`（28 个 operation：包管理/logcat/文件传输/scrcpy/文本输入）` → `（29 个 operation：包管理/logcat/文件传输/scrcpy/文本输入/前台信息）`

- [ ] **Step 4: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add docs/action.md CLAUDE.md && git commit -m "docs: 前台信息 operation 契约与架构同步"
```

---

### Task 9: 全量构建 + 真机实际验证

**Files:**
- Modify: `internal/adb/foreground/parse_test.go`（追加 live 测试）

**Interfaces:**
- Consumes: Task 1-8 全部产出；真机（serial `07ab9620cb257222_ANDROID`，adb `C:\Users\ASUS\AppData\Local\Android\Sdk\platform-tools\adb.exe`）
- Produces: 端到端验证通过的可发布状态

- [ ] **Step 1: 追加 live 测试（默认 skip）**

追加到 `parse_test.go`：

```go
import (
	"context"
	"os"
	"testing"
	"time"

	"workflow-tool/internal/adbcore"
)

// TestLiveForegroundParse 真机验证（默认 skip）：设 FOREGROUND_LIVE_SERIAL（可选
// FOREGROUND_LIVE_ADB 覆盖 adb 路径）后运行，直接跑三条真实命令并走完整
// 解析+排版链路。OpContext 未导出字段无法在域包外构造，故绕过 handler、
// 直测纯函数链（handler 编排由 exe 手动验证覆盖）。
func TestLiveForegroundParse(t *testing.T) {
	serial := os.Getenv("FOREGROUND_LIVE_SERIAL")
	if serial == "" {
		t.Skip("set FOREGROUND_LIVE_SERIAL to run live verification")
	}
	adbBin := os.Getenv("FOREGROUND_LIVE_ADB")
	if adbBin == "" {
		adbBin = `C:\Users\ASUS\AppData\Local\Android\Sdk\platform-tools\adb.exe`
	}
	run := func(args ...string) string {
		t.Helper()
		full := append([]string{"-s", serial}, args...)
		res, err := adbcore.RunCommand(context.Background(), adbcore.ExecRequest{
			Command: adbBin, Args: full, Timeout: 30 * time.Second,
		})
		if err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		if res.ExitCode != 0 {
			t.Fatalf("%v: exit %d: %s", args, res.ExitCode, res.Stderr)
		}
		return res.Stdout
	}

	if a, ok := parseTopActivity(run("shell", "dumpsys", "activity", "activities")); ok {
		for _, l := range formatActivity(a) {
			t.Log(l)
		}
	} else {
		t.Error("live: no topResumedActivity parsed")
	}

	if ws := parseWindowDisplays(run("shell", "dumpsys", "window", "displays")); len(ws) > 0 {
		for _, l := range formatWindows(ws) {
			t.Log(l)
		}
	} else {
		t.Error("live: no window displays parsed")
	}

	if _, err := run("shell", "uiautomator", "dump", uiDumpPath); err != nil {
		t.Fatalf("uiautomator dump: %v", err)
	}
	xmlData := run("shell", "cat", uiDumpPath)
	if tree, err := parseUITree(xmlData); err != nil {
		t.Errorf("live: parse xml: %v", err)
	} else {
		for _, l := range formatTree(tree, 3) {
			t.Log(l)
		}
		_ = formatTree(tree, 0) // 不限深度版同时跑一遍（确认全量渲染不 panic）
	}
}
```

- [ ] **Step 2: 真机跑 live 测试**

先确认设备在线：`"/c/Users/ASUS/AppData/Local/Android/Sdk/platform-tools/adb.exe" devices -l`

Run: `cd /c/Users/ASUS/Documents/workflow-tool && FOREGROUND_LIVE_SERIAL=07ab9620cb257222_ANDROID go test ./internal/adb/foreground -run TestLiveForegroundParse -v`
Expected: PASS，`t.Log` 输出三段格式化报告（多 display 分组正确、树深度 3 折叠生效）。若设备断开，重连后重跑。

- [ ] **Step 3: 全量单测 + 构建**

Run: `cd /c/Users/ASUS/Documents/workflow-tool && go test ./internal/... && bash deploy/build.sh`
Expected: 全部 PASS；构建产出 `workflow-tool.exe`（脚本自动 taskkill 释放占用）。注意 build.sh 内部按 前端→bindings→后端 顺序编排，无须手工分步。

- [ ] **Step 4: exe 手动端到端验证**

启动 `workflow-tool.exe`（与 actions/ 等同级），侧边栏选设备 → 运行「前台信息」动作 → 确认 OutputConsole 三段排版输出、preset「仅 View 树」直跑只出树段。此项需用户配合确认。

- [ ] **Step 5: Commit**

```bash
cd /c/Users/ASUS/Documents/workflow-tool && git add internal/adb/foreground/parse_test.go && git commit -m "test(foreground): 真机 live 验证——默认 skip 环境变量驱动"
```
