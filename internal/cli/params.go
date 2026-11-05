package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"

	"workflow-tool/internal/registry"
)

// parseParamsFlag 解析 --params：JSON 字符串、@file、或 @-（stdin）。空输入返回空 map。
func parseParamsFlag(raw string) (map[string]any, *cliError) {
	if raw == "" {
		return map[string]any{}, nil
	}
	var (
		data []byte
		err  error
	)
	switch {
	case raw == "@-":
		data, err = io.ReadAll(os.Stdin)
	case strings.HasPrefix(raw, "@"):
		data, err = os.ReadFile(raw[1:])
	default:
		data = []byte(raw)
	}
	if err != nil {
		return nil, &cliError{"bad_params", fmt.Sprintf("读取 params 失败: %v", err)}
	}
	if strings.TrimSpace(string(data)) == "" {
		return map[string]any{}, nil
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, &cliError{"bad_params", fmt.Sprintf("params 不是合法 JSON 对象: %v", err)}
	}
	return m, nil
}

// coerceParams 对照 ParamSpec 校验并归一传入参数：
// bool 要求 JSON 布尔，select 值须 ∈ options，其余为字符串；缺失的必填参数报错，
// 缺失的可选参数用 Default 兜底。未在 spec 声明的 key 原样透传（作为额外变量源）。
func coerceParams(specs []registry.ParamSpec, in map[string]any) (map[string]any, *cliError) {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	for _, s := range specs {
		v, present := in[s.ID]
		if !present {
			if s.Required && s.Default == "" {
				return nil, &cliError{"validation", fmt.Sprintf("缺少必填参数 %q", s.ID)}
			}
			if s.Default != "" {
				out[s.ID] = s.Default
			}
			continue
		}
		switch s.Type {
		case "bool":
			b, ok := v.(bool)
			if !ok {
				return nil, &cliError{"validation", fmt.Sprintf("参数 %q 需要布尔值（JSON true/false）", s.ID)}
			}
			out[s.ID] = b
		case "select":
			sv, ok := v.(string)
			if !ok {
				return nil, &cliError{"validation", fmt.Sprintf("参数 %q 需要字符串", s.ID)}
			}
			if !slices.Contains(s.Options, sv) {
				return nil, &cliError{"validation", fmt.Sprintf("参数 %q 的值 %q 不在 options %v 内", s.ID, sv, s.Options)}
			}
			out[s.ID] = sv
		default: // text|path|file|textarea
			sv, ok := v.(string)
			if !ok {
				return nil, &cliError{"validation", fmt.Sprintf("参数 %q 需要字符串", s.ID)}
			}
			out[s.ID] = sv
		}
	}
	return out, nil
}
