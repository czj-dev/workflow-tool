package api

import (
	"fmt"
	"strings"

	"workflow-tool/internal/registry"
	"workflow-tool/internal/workflow"
)

// TreeClickResult 是树叶点击映射出的普通 action 运行请求。
type TreeClickResult struct {
	Action string            `json:"action"`
	Params map[string]string `json:"params"`
}

func (s *Service) treeClick(sourceID string) (*registry.TreeClick, error) {
	reg := s.actionRegistry()
	la, ok := reg.Actions[sourceID]
	if !ok || la.Def.HMI == nil || la.Def.HMI.Tree == nil || la.Def.HMI.Tree.Click == nil {
		return nil, fmt.Errorf("动作 %q 未配置树叶点击", sourceID)
	}
	click := la.Def.HMI.Tree.Click
	if _, ok := reg.Actions[click.Action]; !ok {
		return nil, fmt.Errorf("目标动作 %q 不存在", click.Action)
	}
	return click, nil
}

func substituteClickParams(click *registry.TreeClick, ctx *workflow.StepContext) (TreeClickResult, error) {
	mapped := make(map[string]string, len(click.Params))
	for key, expression := range click.Params {
		value, err := workflow.Substitute(expression, ctx)
		if err != nil {
			return TreeClickResult{}, fmt.Errorf("参数 %s: %w", key, err)
		}
		mapped[key] = value
	}
	return TreeClickResult{Action: click.Action, Params: mapped}, nil
}

// ResolveTreeClick 只使用源 action 的声明，节点和本轮参数由对应树帧提供。
func (s *Service) ResolveTreeClick(sourceID string, node map[string]any, params map[string]any) (TreeClickResult, error) {
	click, err := s.treeClick(sourceID)
	if err != nil {
		return TreeClickResult{}, err
	}
	// 单击 = 单元素多选：Nodes.paths 同步填本节点路径，声明了 multi 的动作
	// 统一用 ${{ nodes.paths }} 一种表达式，单击与批量按钮的 click.params 不分叉。
	path, _ := node["path"].(string)
	ctx := &workflow.StepContext{
		Node:   node,
		Params: params,
		Nodes:  map[string]any{"paths": path},
	}
	return substituteClickParams(click, ctx)
}

// ResolveTreeClickMulti 把树多选（叶子集合）映射为一次目标 action 运行：
// 仅对声明了 hmi.tree.click.multi 的源动作可用，选中路径以换行 join 暴露为
// ${{ nodes.paths }}（目标脚本自行按行切分，如 spm-download 的多片段输入）。
func (s *Service) ResolveTreeClickMulti(sourceID string, nodes []map[string]any, params map[string]any) (TreeClickResult, error) {
	click, err := s.treeClick(sourceID)
	if err != nil {
		return TreeClickResult{}, err
	}
	if !click.Multi {
		return TreeClickResult{}, fmt.Errorf("动作 %q 未声明 hmi.tree.click.multi", sourceID)
	}
	if len(nodes) == 0 {
		return TreeClickResult{}, fmt.Errorf("未选中任何节点")
	}
	paths := make([]string, 0, len(nodes))
	for i, node := range nodes {
		path, _ := node["path"].(string)
		if path == "" {
			return TreeClickResult{}, fmt.Errorf("第 %d 个选中节点缺少 path 字段", i+1)
		}
		paths = append(paths, path)
	}
	ctx := &workflow.StepContext{
		Params: params,
		Nodes:  map[string]any{"paths": strings.Join(paths, "\n")},
	}
	return substituteClickParams(click, ctx)
}
