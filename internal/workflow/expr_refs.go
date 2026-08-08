package workflow

import (
	"github.com/expr-lang/expr/ast"
	"github.com/expr-lang/expr/parser"
)

// referencedStepIDs 解析 exprStr 的 AST，提取所有形如
// steps.<id>.outputs.<key> 的成员访问链中的 <id>。
// 解析失败（语法错误）时返回 nil——语法校验交给 EvalCondition 在运行时兜底，
// 此函数只负责"能解析时提取引用"，不重复做语法校验。
func referencedStepIDs(exprStr string) []string {
	if exprStr == "" {
		return nil
	}
	tree, err := parser.Parse(exprStr)
	if err != nil {
		return nil
	}
	var ids []string
	ast.Walk(&tree.Node, &stepRefVisitor{ids: &ids})
	return ids
}

// stepRefVisitor 在 AST 中查找 steps.<id>.outputs 形状的 MemberNode 链，
// 命中时把 <id> 追加进 ids。
type stepRefVisitor struct {
	ids *[]string
}

func (v *stepRefVisitor) Visit(node *ast.Node) {
	outer, ok := (*node).(*ast.MemberNode) // steps.<id>.outputs
	if !ok {
		return
	}
	outputsProp, ok := outer.Property.(*ast.StringNode)
	if !ok || outputsProp.Value != "outputs" {
		return
	}
	inner, ok := outer.Node.(*ast.MemberNode) // steps.<id>
	if !ok {
		return
	}
	idProp, ok := inner.Property.(*ast.StringNode)
	if !ok {
		return
	}
	base, ok := inner.Node.(*ast.IdentifierNode) // steps
	if !ok || base.Value != "steps" {
		return
	}
	*v.ids = append(*v.ids, idProp.Value)
}
