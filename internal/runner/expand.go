package runner

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"

	"workflow-tool/internal/builtinvars"
)

// Expand 把 s 里的 ${VAR} 按优先级替换：vars（params/merged） → builtins（内置变量）
// → 环境变量；都未命中则保留 ${VAR} 原样并记一条 warning。
// vars 的值支持任意类型（按 fmt.Sprint 转字符串）。builtins 为 nil 时跳过该层查找。
//
// 所有 Runner 实现都应通过它用 params 做变量替换（Phase 3 通用契约）。
func Expand(ctx context.Context, s string, vars map[string]any, builtins *builtinvars.Registry) string {
	return os.Expand(s, func(name string) string {
		if v, ok := vars[name]; ok {
			return fmt.Sprint(v)
		}
		if v, ok := builtins.Resolve(ctx, name); ok {
			return v
		}
		if v, ok := os.LookupEnv(name); ok {
			return v
		}
		log.Printf("warning: 未定义的变量 ${%s}（params/内置变量/env 都无），保留原样", name)
		return "${" + name + "}"
	})
}

// ExpandMap 对 map 的每个 value 做 Expand（用于 env 块）。
func ExpandMap(ctx context.Context, m map[string]string, vars map[string]any, builtins *builtinvars.Registry) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		// 仅当含 ${} 时才替换，避免无谓日志
		if strings.Contains(v, "${") {
			out[k] = Expand(ctx, v, vars, builtins)
		} else {
			out[k] = v
		}
	}
	return out
}

// ExpandParams 对 params 中每个字符串值做 ${VAR} 展开（用原始 params 作为查表来源），
// 非字符串值（bool 等）原样保留。由 api 层在调用 runner.Run 之前统一调用，
// 使所有 runner 拿到的 params 都是终值——runner 不再各自重复展开。
//
// 这是 ${VAR} 展开的唯一入口：workflow 的 action step params 常含 ${PACKAGE} 这类引用，
// Substitute 只处理 ${{ }} 表达式，剩余 ${VAR} 在此统一了结。
func ExpandParams(ctx context.Context, params map[string]any, builtins *builtinvars.Registry) map[string]any {
	if len(params) == 0 {
		return params
	}
	out := make(map[string]any, len(params))
	for k, v := range params {
		if s, ok := v.(string); ok {
			out[k] = Expand(ctx, s, params, builtins)
		} else {
			out[k] = v
		}
	}
	return out
}
