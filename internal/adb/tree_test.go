package adb

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

// chain 构造 n 节点单链：root → n1 → n2 → …（每层 1 子）。
func chain(n int) []TreeNode {
	root := TreeNode{Label: "root"}
	cur := &root
	for i := 1; i < n; i++ {
		cur.Children = []TreeNode{{Label: "n" + strconv.Itoa(i)}}
		cur = &cur.Children[0]
	}
	return []TreeNode{root}
}

func TestCountTreeNodes(t *testing.T) {
	if got := CountTreeNodes(nil); got != 0 {
		t.Fatalf("nil = %d", got)
	}
	nodes := []TreeNode{
		{Label: "a", Children: []TreeNode{{Label: "a1"}, {Label: "a2", Children: []TreeNode{{Label: "a2x"}}}}},
		{Label: "b"},
	}
	if got := CountTreeNodes(nodes); got != 5 {
		t.Fatalf("got %d, want 5", got)
	}
}

func TestTruncateNodesNoCut(t *testing.T) {
	nodes := chain(3)
	out, cut := TruncateNodes(nodes, 10)
	if cut {
		t.Fatal("should not cut")
	}
	if CountTreeNodes(out) != 3 {
		t.Fatalf("count = %d", CountTreeNodes(out))
	}
	// 总数 ≤max 时原样返回（同一切片，不做拷贝）
	if &out[0] != &nodes[0] {
		t.Fatal("should return as-is")
	}
}

func TestTruncateNodes(t *testing.T) {
	// 5 节点链 max=3：保留 3 个 + … 警告节点 = 4；警告在预算耗尽的子级位置
	out, cut := TruncateNodes(chain(5), 3)
	if !cut {
		t.Fatal("should cut")
	}
	if got := CountTreeNodes(out); got != 4 {
		t.Fatalf("count = %d, want 4 (3 kept + warning)", got)
	}
	warn := &out[0]
	for len(warn.Children) > 0 {
		warn = &warn.Children[0]
	}
	if warn.Label != "…" {
		t.Fatalf("deepest = %+v, want warning node", *warn)
	}
	if !strings.Contains(warn.Detail, "+2 截断") || !strings.Contains(warn.Detail, "3") {
		t.Fatalf("warning detail = %q", warn.Detail)
	}
	// 截断不破坏已保留节点的结构（root→n1→n2 完整，警告挂在 n2 下）
	if len(out[0].Children) != 1 || len(out[0].Children[0].Children) != 1 {
		t.Fatalf("kept structure broken: %+v", out[0])
	}
}

func TestEmitTree(t *testing.T) {
	var streams, lines []string
	op := &OpContext{Emit: func(stream, line string) {
		streams = append(streams, stream)
		lines = append(lines, line)
	}}
	op.EmitTree(TreeFrame{Title: "t", Nodes: []TreeNode{{Label: "a", Kind: "dir"}}})
	if len(streams) != 1 || streams[0] != "tree" {
		t.Fatalf("streams = %v", streams)
	}
	var f TreeFrame
	if err := json.Unmarshal([]byte(lines[0]), &f); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if f.Title != "t" || len(f.Nodes) != 1 || f.Nodes[0].Kind != "dir" {
		t.Fatalf("frame = %+v", f)
	}
	// omitempty：可选字段为空时不进 JSON
	op2 := &OpContext{Emit: func(stream, line string) { lines = append(lines, line) }}
	op2.EmitTree(TreeFrame{Nodes: []TreeNode{{Label: "x"}}})
	if strings.Contains(lines[len(lines)-1], "kind") ||
		strings.Contains(lines[len(lines)-1], "detail") ||
		strings.Contains(lines[len(lines)-1], "children") {
		t.Fatalf("omitempty leaked: %s", lines[len(lines)-1])
	}
}
