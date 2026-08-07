package workflow

import (
	"fmt"
	"regexp"

	"github.com/expr-lang/expr"
)

// EvalCondition 求值 workflow step 的 if 表达式，返回布尔结果。
// 空表达式视为 true（步骤无条件执行）。
func EvalCondition(exprStr string, ctx *StepContext) (bool, error) {
	if exprStr == "" {
		return true, nil
	}
	out, err := expr.Eval(exprStr, ctx.Flatten())
	if err != nil {
		return false, fmt.Errorf("if 表达式求值失败 %q: %w", exprStr, err)
	}
	b, ok := out.(bool)
	if !ok {
		return false, fmt.Errorf("if 表达式必须返回 bool，实际 %T: %v", out, out)
	}
	return b, nil
}

// exprPattern 匹配 ${{ ... }} 表达式片段（非贪婪）。
var exprPattern = regexp.MustCompile(`\$\{\{\s*(.+?)\s*\}\}`)

// Substitute 用 expr 引擎对 text 中所有 ${{ expr }} 片段求值并替换成字符串值。
// 用于 shell 命令预处理，剩余 ${VAR} 由 runner.Expand 处理。
// 任一片段求值失败即返回整体错误。
func Substitute(text string, ctx *StepContext) (string, error) {
	env := ctx.Flatten()
	var firstErr error
	out := exprPattern.ReplaceAllStringFunc(text, func(match string) string {
		if firstErr != nil {
			return match
		}
		sub := exprPattern.FindStringSubmatch(match)
		if len(sub) < 2 {
			return match
		}
		result, err := expr.Eval(sub[1], env)
		if err != nil {
			firstErr = fmt.Errorf("${{ %s }} 求值失败: %w", sub[1], err)
			return match
		}
		return fmt.Sprint(result)
	})
	if firstErr != nil {
		return "", firstErr
	}
	return out, nil
}
