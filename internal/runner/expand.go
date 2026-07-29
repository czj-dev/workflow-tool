package runner

import (
	"fmt"
	"log"
	"os"
	"strings"
)

// Expand 把 s 里的 ${VAR} 按 vars 取值，未命中再查环境变量；
// 都没有则保留原样 ${VAR} 并记一条 warning。
// vars 的值支持任意类型（按 fmt.Sprint 转字符串）。
//
// 所有 Runner 实现都应通过它用 params 做变量替换（Phase 3 通用契约）。
func Expand(s string, vars map[string]any) string {
	return os.Expand(s, func(name string) string {
		if v, ok := vars[name]; ok {
			return fmt.Sprint(v)
		}
		if v, ok := os.LookupEnv(name); ok {
			return v
		}
		log.Printf("warning: 未定义的变量 ${%s}（params 与 env 都无），保留原样", name)
		return "${" + name + "}"
	})
}

// ExpandMap 对 map 的每个 value 做 Expand（用于 env 块）。
func ExpandMap(m map[string]string, vars map[string]any) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		// 仅当含 ${} 时才替换，避免无谓日志
		if strings.Contains(v, "${") {
			out[k] = Expand(v, vars)
		} else {
			out[k] = v
		}
	}
	return out
}
