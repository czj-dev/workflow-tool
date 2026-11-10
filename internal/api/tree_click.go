package api

import (
	"fmt"

	"workflow-tool/internal/workflow"
)

// TreeClickResult 是树叶点击映射出的普通 action 运行请求。
type TreeClickResult struct {
	Action string            `json:"action"`
	Params map[string]string `json:"params"`
}

// ResolveTreeClick 只使用源 action 的声明，节点和本轮参数由对应树帧提供。
func (s *Service) ResolveTreeClick(sourceID string, node map[string]any, params map[string]any) (TreeClickResult, error) {
	la, ok := s.reg.Actions[sourceID]
	if !ok || la.Def.HMI == nil || la.Def.HMI.Tree == nil || la.Def.HMI.Tree.Click == nil {
		return TreeClickResult{}, fmt.Errorf("动作 %q 未配置树叶点击", sourceID)
	}
	click := la.Def.HMI.Tree.Click
	if _, ok := s.reg.Actions[click.Action]; !ok {
		return TreeClickResult{}, fmt.Errorf("目标动作 %q 不存在", click.Action)
	}
	ctx := &workflow.StepContext{Node: node, Params: params}
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
