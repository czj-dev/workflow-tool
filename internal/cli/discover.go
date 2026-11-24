package cli

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"

	"workflow-tool/internal/ai"
	"workflow-tool/internal/apphome"
	"workflow-tool/internal/registry"
)

// listItem 是 list 输出的单元素。
type listItem struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Kind  string `json:"kind"` // "action" | "workflow" | "ai"
}

// cmdList 输出全部 action + workflow + AI 任务的一次性 JSON 数组。
func cmdList(args []string) int {
	fs := flag.NewFlagSet("list", flag.ContinueOnError)
	baseDir := fs.String("base-dir", "", "actions/ai/workflows/config.yaml 所在目录")
	if err := fs.Parse(args); err != nil {
		return exitCLIError
	}
	return encodePretty(listItems(loadEnv(apphome.ResolveBaseDir(*baseDir))))
}

// listItems 汇总 action、workflow 与 AI 任务，按 id 排序。
func listItems(e *env) []listItem {
	items := make([]listItem, 0, len(e.reg.Actions)+len(e.wfReg.Workflows)+len(e.aiReg.Tasks))
	for _, la := range e.reg.Actions {
		items = append(items, listItem{ID: la.Def.ID, Title: la.Def.Title, Kind: "action"})
	}
	for _, lw := range e.wfReg.Workflows {
		items = append(items, listItem{ID: lw.Def.ID, Title: lw.Def.Title, Kind: "workflow"})
	}
	for _, lt := range e.aiReg.Tasks {
		items = append(items, listItem{ID: lt.Task.ID, Title: lt.Task.Title, Kind: "ai"})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items
}

// describeResult 是 describe 输出：params 直接复用 registry.ParamSpec（已带 json tag）。
type describeResult struct {
	ID      string               `json:"id"`
	Kind    string               `json:"kind"`
	Params  []registry.ParamSpec `json:"params"`
	Presets []registry.Preset    `json:"presets,omitempty"`
}

// describeAiResult 是 AI 任务的 describe 输出：参数契约之外多出 Prompt/System（定义里的
// 模板原文）与无需声明即接受的保留运行参数。prompt 为空串表示提示词必须由调用方给入，
// 故该键总是输出。
type describeAiResult struct {
	ID                string               `json:"id"`
	Kind              string               `json:"kind"`
	Params            []registry.ParamSpec `json:"params"`
	Presets           []registry.Preset    `json:"presets,omitempty"`
	Prompt            string               `json:"prompt"`
	System            string               `json:"system,omitempty"`
	ReservedRunParams []string             `json:"reservedRunParams"`
}

// cmdDescribe 输出单个 id 的参数契约（一次性 JSON 对象）。id 必须是 args[0]。
func cmdDescribe(args []string) int {
	if len(args) < 1 || args[0] == "" || args[0][0] == '-' {
		fmt.Fprintln(os.Stderr, "用法: workflow-tool describe <id> [--kind action|workflow|ai] [--base-dir ..]")
		return exitCLIError
	}
	id := args[0]
	fs := flag.NewFlagSet("describe", flag.ContinueOnError)
	baseDir := fs.String("base-dir", "", "")
	kind := fs.String("kind", "", "action|workflow|ai（撞名消歧）")
	if err := fs.Parse(args[1:]); err != nil {
		return exitCLIError
	}

	e := loadEnv(apphome.ResolveBaseDir(*baseDir))
	tgt, cerr := e.resolve(id, *kind)
	if cerr != nil {
		return fail(false, nil, cerr)
	}
	return encodePretty(describeOf(id, tgt))
}

// describeOf 把解析结果转成 describe 输出对象。
func describeOf(id string, tgt target) any {
	switch tgt.kind {
	case "action":
		return describeResult{ID: id, Kind: "action", Params: tgt.la.Def.Params, Presets: tgt.la.Def.Presets}
	case "ai":
		return describeAiResult{
			ID: id, Kind: "ai", Params: tgt.lt.Task.Params, Presets: tgt.lt.Task.Presets,
			Prompt:            tgt.lt.Task.PromptText(),
			System:            tgt.lt.Task.System,
			ReservedRunParams: ai.ReservedRunParams(),
		}
	default:
		return describeResult{ID: id, Kind: "workflow", Params: tgt.lw.Def.Params}
	}
}

// encodePretty 把查询结果以缩进 JSON 打到 stdout（一次性，非 NDJSON）。
func encodePretty(v any) int {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return exitCLIError
	}
	return 0
}
