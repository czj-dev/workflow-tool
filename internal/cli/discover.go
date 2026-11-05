package cli

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"

	"workflow-tool/internal/apphome"
	"workflow-tool/internal/registry"
)

// listItem 是 list 输出的单元素。
type listItem struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Kind  string `json:"kind"`
}

// cmdList 输出全部 action + workflow 的一次性 JSON 数组。
func cmdList(args []string) int {
	fs := flag.NewFlagSet("list", flag.ContinueOnError)
	baseDir := fs.String("base-dir", "", "actions/workflows/config.yaml 所在目录")
	if err := fs.Parse(args); err != nil {
		return exitCLIError
	}
	e := loadEnv(apphome.ResolveBaseDir(*baseDir))

	items := make([]listItem, 0, len(e.reg.Actions)+len(e.wfReg.Workflows))
	for _, la := range e.reg.Actions {
		items = append(items, listItem{ID: la.Def.ID, Title: la.Def.Title, Kind: "action"})
	}
	for _, lw := range e.wfReg.Workflows {
		items = append(items, listItem{ID: lw.Def.ID, Title: lw.Def.Title, Kind: "workflow"})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })

	return encodePretty(items)
}

// describeResult 是 describe 输出：params 直接复用 registry.ParamSpec（已带 json tag）。
type describeResult struct {
	ID      string               `json:"id"`
	Kind    string               `json:"kind"`
	Params  []registry.ParamSpec `json:"params"`
	Presets []registry.Preset    `json:"presets,omitempty"`
}

// cmdDescribe 输出单个 id 的参数契约（一次性 JSON 对象）。id 必须是 args[0]。
func cmdDescribe(args []string) int {
	if len(args) < 1 || args[0] == "" || args[0][0] == '-' {
		fmt.Fprintln(os.Stderr, "用法: workflow-tool describe <id> [--kind action|workflow] [--base-dir ..]")
		return exitCLIError
	}
	id := args[0]
	fs := flag.NewFlagSet("describe", flag.ContinueOnError)
	baseDir := fs.String("base-dir", "", "")
	kind := fs.String("kind", "", "action|workflow（撞名消歧）")
	if err := fs.Parse(args[1:]); err != nil {
		return exitCLIError
	}

	e := loadEnv(apphome.ResolveBaseDir(*baseDir))
	tgt, cerr := e.resolve(id, *kind)
	if cerr != nil {
		return fail(false, nil, cerr)
	}

	var res describeResult
	if tgt.kind == "action" {
		res = describeResult{ID: id, Kind: "action", Params: tgt.la.Def.Params, Presets: tgt.la.Def.Presets}
	} else {
		res = describeResult{ID: id, Kind: "workflow", Params: tgt.lw.Def.Params}
	}
	return encodePretty(res)
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
