package adb

import (
	"encoding/json"
	"fmt"
)

// 本文件定义树帧协议的 Go 侧类型与发射器。树帧是输出流的第三种内容形态
// （与文本行 / progress 单行并列）：一帧 = 一棵完整树，前端输出控制台在
// 流内位置原地渲染可交互树块（折叠/搜索/叶子复制，schema 见 docs/action.md
// 输出协议）。script 动作经 stdout 的 `##[tree {...}]` 协议行进入同一通道
// （runner.parseTreeLine）；adb Go 域直接构造本类型并 EmitTree，免文本协议转义。

// TreeNode 是树协议节点：仅 Label 必填。Kind 是类型徽标，前端原样渲染、
// 无 kind→文案/颜色映射（文件树 dir/file，View 树=class 短名）；Detail 是
// 弱化补充（大小/属性/截断说明）；Path 是叶子点击复制用的完整路径（空则
// 前端回退根到叶 label 面包屑）；Children 为空即叶子。
type TreeNode struct {
	Label    string     `json:"label"`
	Kind     string     `json:"kind,omitempty"`
	Detail   string     `json:"detail,omitempty"`
	Path     string     `json:"path,omitempty"`
	Children []TreeNode `json:"children,omitempty"`
}

// TreeFrame 是一帧树的顶层：Title 进树块头部（可选），Nodes 为根节点列表（通常 1 个）。
type TreeFrame struct {
	Title string     `json:"title,omitempty"`
	Nodes []TreeNode `json:"nodes"`
}

// MaxTreeNodes 是单帧节点数硬护栏：极端 dump（车机全屏无障碍树可达数万节点）
// 会撑爆事件载荷与前端渲染。限量本是数据源义务（如 spm 的 MAX_ENTRIES），
// 此常量只是最后一道保险，超出按 TruncateNodes 截断。
const MaxTreeNodes = 5000

// CountTreeNodes 统计节点总数（含后代）。
func CountTreeNodes(nodes []TreeNode) int {
	c := 0
	for _, n := range nodes {
		c += 1 + CountTreeNodes(n.Children)
	}
	return c
}

// TruncateNodes 深度优先截断到 ≤max 个节点：预算耗尽处追加一个 `…` 警告节点
// （Detail 注明丢弃数与上限），其后兄弟与后代全部丢弃。总数 ≤max 时原样返回。
func TruncateNodes(nodes []TreeNode, max int) ([]TreeNode, bool) {
	total := CountTreeNodes(nodes)
	if total <= max {
		return nodes, false
	}
	if max < 1 {
		max = 1
	}
	used := 0
	var cut func(list []TreeNode) []TreeNode
	cut = func(list []TreeNode) []TreeNode {
		out := make([]TreeNode, 0, len(list))
		for _, n := range list {
			if used == max {
				out = append(out, TreeNode{
					Label:  "…",
					Detail: fmt.Sprintf("+%d 截断（超出单帧 %d 节点上限）", total-used, max),
				})
				return out
			}
			used++
			if len(n.Children) > 0 {
				n.Children = cut(n.Children)
			}
			out = append(out, n)
		}
		return out
	}
	return cut(nodes), true
}

// EmitTree 序列化树帧并以 "tree" 流发射（line=树 JSON 原文，前端 JSON.parse 后
// 内联渲染树块；解析失败由前端降级为错误节点行）。序列化失败（字段全为基本类型，
// 理论不可达）降级为 stderr 行，不静默丢帧。
func (op *OpContext) EmitTree(frame TreeFrame) {
	b, err := json.Marshal(frame)
	if err != nil {
		op.EmitStderr("emit tree frame failed: " + err.Error())
		return
	}
	if op.Emit != nil {
		op.Emit("tree", string(b))
	}
}
