package foreground

import (
	"fmt"
	"strconv"
	"strings"

	"workflow-tool/internal/adb"
)

// sectionWidth 是段落标题分隔线总显示宽度。
const sectionWidth = 50

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

// shortClass 取 View class 短名：android.widget.TextView → TextView（无点原样）。
// 无障碍树的 class 恒为全限定名（几乎都是 android.widget.* 前缀），短名足够
// 区分且省列宽；作 kind（类型徽标）与匿名节点标签兜底。
func shortClass(class string) string {
	if i := strings.LastIndex(class, "."); i >= 0 {
		return class[i+1:]
	}
	return class
}

// uiTreeNode 把 UINode 转为树协议节点（mockup v2.4 定稿）。字段映射：
//   - kind   = class 短名（前端原样渲染为类型徽标，无 kind→文案映射）
//   - label  = 身份：文本 > resource-id > class 短名兜底（与 kind 相同时前端不重复显示）
//   - detail = 剩余属性单行拼接 `id=… · clickable · [bounds]`
//     （id 仅在 label 取了文本时出现，避免与 label 重复）
func uiTreeNode(n *UINode) adb.TreeNode {
	short := shortClass(n.Class)
	tn := adb.TreeNode{Kind: short, Label: short}
	var parts []string
	switch {
	case n.Text != "":
		tn.Label = strconv.Quote(truncateDisplay(n.Text, 40))
		if n.ResourceID != "" {
			parts = append(parts, "id="+n.ResourceID)
		}
	case n.ResourceID != "":
		tn.Label = n.ResourceID
	}
	if n.Clickable {
		parts = append(parts, "clickable")
	}
	if n.Bounds != "" {
		parts = append(parts, n.Bounds)
	}
	tn.Detail = strings.Join(parts, " · ")
	if len(n.Nodes) > 0 {
		tn.Children = make([]adb.TreeNode, 0, len(n.Nodes))
		for i := range n.Nodes {
			tn.Children = append(tn.Children, uiTreeNode(&n.Nodes[i]))
		}
	}
	return tn
}

// emitUITree 发射 View 树段：小节标题文本行 + 一帧树（"tree" 流，前端原地
// 渲染可交互树块——替代原 formatTree 缩进文本树，深度折叠由前端接管）。
// 硬护栏：总节点数超 adb.MaxTreeNodes 时深度优先截断，警告进树块 title 与 … 节点。
func emitUITree(op *adb.OpContext, t *UITree) {
	root := uiTreeNode(&t.Node)
	total := adb.CountTreeNodes([]adb.TreeNode{root})
	title := fmt.Sprintf("uiautomator · 共 %d 节点", total)
	nodes := []adb.TreeNode{root}
	if total > adb.MaxTreeNodes {
		nodes, _ = adb.TruncateNodes(nodes, adb.MaxTreeNodes)
		title += fmt.Sprintf(" · 超上限已截断 %d", total-adb.MaxTreeNodes)
	}
	op.EmitStdout(sectionTitle("View 树"))
	op.EmitTree(adb.TreeFrame{Title: title, Nodes: nodes})
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
