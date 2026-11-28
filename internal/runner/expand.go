package runner

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"

	"workflow-tool/internal/builtinvars"
)

// maxVarChain 是 config 值嵌套展开的最大链深：config 值之间可互相引用（如
// OUTPUT_DIR: ${DOCS}/docs → DOCS: ${USER}/Documents），链超此深度视作环引用或
// 过度嵌套，值保留原样并记 warning（环/超深不报错——错误配置不该卡死运行）。
const maxVarChain = 8

// Expand 把 s 里的 ${VAR} 按优先级替换：vars（params/merged） → builtins（内置变量）
// → 环境变量；都未命中则保留 ${VAR} 原样并记一条 warning。
// vars 的值支持任意类型（按 fmt.Sprint 转字符串）。builtins 为 nil 时跳过该层查找。
//
// 单遍替换：命中值的原文直接插入，其中的 ${VAR} 不再继续展开——用户输入
// （动作参数值、树点击的 $literal、AI 任务的输入）是**数据**不是模板，
// 「值里写了什么就替换成什么」。config.yaml 的值是模板（可互相引用），
// 由 ResolveGlobal 在合并前先解析成终值，交给 Expand 的查找源已无嵌套。
//
// 只识别带花括号的 ${VAR}，不碰裸 $VAR / $1 / $@ —— 后者是 shell/awk 的位置参数与
// 变量，必须原样交给解释器（os.Expand 会把 awk '{print $2}' 误改成 '{print ${2}}'）。
//
// 所有 Runner 实现都应通过它用 params 做变量替换（Phase 3 通用契约）。
func Expand(ctx context.Context, s string, vars map[string]any, builtins *builtinvars.Registry) string {
	resolve := func(name string) string {
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
	}
	return expandWith(s, resolve)
}

// ResolveGlobal 把全局配置（config.yaml 快照）解析成终值：值之间可互相引用
//（如 USER: /Users/v → DOCS: ${USER}/Documents → OUTPUT_DIR: ${DOCS}/docs），
// 按同一份 map 递归展开，内置变量与环境变量兜底（与 Expand 的优先级一致，
// 只是查找源只有 config 层）。未命中、环引用与超过 maxVarChain 层的引用链
// 保留原样并记 warning。
//
// 为什么单独解析而不是让 Expand 递归：按「值来源」分层——config 层是模板、
// 用户输入是数据。Expand 收到的查找源是两层合并后的扁平 map，无法区分某个
// 值是 config 定义还是用户敲的输入；在 Expand 里递归会让数据被传递展开
//（airun 的 TestBuildInputsAreNotPreExpanded、api 的
// TestPrepareActionParamsPreservesOnlyLiteralKeys 锁定该语义不可破坏）。
// 调用方（api.mergeGlobalAndParams / cli env.merge / airun.Build）先经本函数
// 把 config 层解到终值，再与用户参数合并交给单遍 Expand，即得终端值。
func ResolveGlobal(ctx context.Context, global map[string]string, builtins *builtinvars.Registry) map[string]string {
	out := make(map[string]string, len(global))
	for k, v := range global {
		out[k] = resolveGlobalValue(ctx, v, global, builtins, nil)
	}
	return out
}

// resolveGlobalValue 展开 config 值 s；chain 是本次解析已经过的变量名，
// 重名即环引用。config 层的引用链在这里闭环（不进入 Expand 的查找源）。
func resolveGlobalValue(ctx context.Context, s string, global map[string]string, builtins *builtinvars.Registry, chain []string) string {
	resolve := func(name string) string {
		v, ok := global[name]
		if !ok {
			if bv, ok := builtins.Resolve(ctx, name); ok {
				return bv
			}
			if ev, ok := os.LookupEnv(name); ok {
				return ev
			}
			log.Printf("warning: config 值引用的 ${%s} 未定义（config/内置变量/env 都无），保留原样", name)
			return "${" + name + "}"
		}
		// 命中 config 键：值仍含 ${VAR} 时带链递归展开（引用链）。
		if !strings.Contains(v, "${") {
			return v
		}
		for _, n := range chain {
			if n == name {
				log.Printf("warning: config 变量 ${%s} 引用成环，值保留原样", name)
				return v
			}
		}
		if len(chain) >= maxVarChain {
			log.Printf("warning: config 变量 ${%s} 嵌套超过 %d 层，值保留原样", name, maxVarChain)
			return v
		}
		next := make([]string, len(chain)+1)
		copy(next, chain)
		next[len(chain)] = name
		return resolveGlobalValue(ctx, v, global, builtins, next)
	}
	return expandWith(s, resolve)
}

// expandWith 用 resolve 解析 s 里的 ${VAR}：单遍扫描，resolve 的返回值原样插入、
// 不重扫（嵌套语义由 resolve 自己决定——Expand 的 resolve 不递归，config 层的递归）。
func expandWith(s string, resolve func(name string) string) string {
	var b strings.Builder
	for i := 0; i < len(s); {
		if s[i] == '$' && i+1 < len(s) && s[i+1] == '{' {
			if end := strings.IndexByte(s[i+2:], '}'); end >= 0 {
				b.WriteString(resolve(s[i+2 : i+2+end]))
				i += 2 + end + 1
				continue
			}
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
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
