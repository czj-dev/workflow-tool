package foreground

import (
	"fmt"
	"strconv"
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

// truncateDisplay 按显示宽度截断（返回串显示宽度 ≤ width+省略号），超出时以 "…" 结尾。
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
