// Package airun 把一份 AI 任务定义与一次运行的输入构造成 runner.AIRunner
// （对标 actionrun 之于动作）。输入合并、保留运行参数、模板展开、守则读取、env 合并、
// skill 路由与同步全部收敛在这里——手动运行与 workflow 的 ai step 共用同一份构造逻辑，
// 两条路径行为保持一致。
//
// 设计规格：docs/superpowers/specs/2026-11-24-ai-system-and-schedules-design.md
package airun

import (
	"context"
	"fmt"
	"os"
	"strings"

	"workflow-tool/internal/ai"
	"workflow-tool/internal/builtinvars"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
)

// Deps 是跨任务共享的执行依赖，由调用方构造一次、全程复用。
type Deps struct {
	// BaseDir 是应用目录（可执行文件同级）：cwd 的兜底值与守则文件 ai-rules.md 的所在。
	BaseDir string
	// Builtins 是内置变量注册表，nil 时跳过该层查找。
	Builtins *builtinvars.Registry
	// SkillRouter 维护 skill 同步路径映射与足迹账本。声明了 skills 且 router 为 nil
	// 时 Build 报错（仅测试场景会是 nil）。
	SkillRouter *SkillRouter
}

// Options 是一次构造的可变输入。
type Options struct {
	// Params 是本次运行的输入，原样传入、不做预展开：已声明参数的值 + 保留运行参数
	// prompt/system/resume。用户在输入框里写 ${X} 就原样进入提示词模板。
	Params map[string]any
	// Global 是 config.yaml 的快照：同名输入覆盖它，二者一起构成模板查找源与子进程 env。
	Global map[string]string
	// ExtraEnv 是 workflow/step 注入的 env（可为空），覆盖任务定义里的同名 env。
	ExtraEnv map[string]string
}

// Build 把任务定义与本次输入构造成 AIRunner。
//
// 顺序：校验并合并输入 → 展开 prompt/system/cwd/env 模板 → 校验 cwd → 读取守则 →
// 绑定了 skills 时路由并同步（失败即返回 error，本次运行失败）。
// 输入里出现未声明的参数名、缺少必填参数、提示词展开后为空，都在这里报错——
// 早于任何进程启动。
func Build(ctx context.Context, lt ai.LoadedTask, deps Deps, opts Options) (*runner.AIRunner, error) {
	t := lt.Task

	inputs, fromDefault, err := resolveInputs(t.Params, opts)
	if err != nil {
		return nil, err
	}
	// 模板查找源的第一层：config.yaml 在底层，本次输入覆盖同名。
	// （后两层「内置变量 → 环境变量」由 runner.Expand 内部按序兜底。）
	vars := make(map[string]any, len(opts.Global)+len(inputs))
	for k, v := range opts.Global {
		vars[k] = v
	}
	for k, v := range inputs {
		vars[k] = v
	}
	// 定义里的默认值本身也是模板（与动作的 withActionDefaults 一致），此刻才具备完整查找源。
	// 按声明顺序展开而不遍历 map：靠后的默认值引用靠前的默认值时拿到的是已展开的值，
	// 结果不随 map 遍历顺序漂移。
	for _, spec := range t.Params {
		if !fromDefault[spec.ID] {
			continue
		}
		inputs[spec.ID] = runner.Expand(ctx, inputs[spec.ID].(string), vars, deps.Builtins)
		vars[spec.ID] = inputs[spec.ID]
	}
	for _, spec := range t.Params {
		if spec.Required && strings.TrimSpace(valueText(inputs[spec.ID])) == "" {
			return nil, fmt.Errorf("缺少必填参数 %q", spec.ID)
		}
	}

	// 保留运行参数：键出现即整体替换定义里的模板（传空串也算替换），未出现才用定义文本。
	// 替换进来的值同样是模板，照常展开。
	promptTmpl, systemTmpl := t.PromptText(), t.System
	if v, ok := opts.Params[ai.ParamPrompt]; ok {
		promptTmpl = valueText(v)
	}
	if v, ok := opts.Params[ai.ParamSystem]; ok {
		systemTmpl = valueText(v)
	}
	resume := ""
	if v, ok := opts.Params[ai.ParamResume]; ok {
		resume = strings.TrimSpace(valueText(v))
	}

	prompt := runner.Expand(ctx, promptTmpl, vars, deps.Builtins)
	if strings.TrimSpace(prompt) == "" {
		return nil, fmt.Errorf("提示词为空（展开后无内容）：请在输入里给出 prompt，或在任务定义里补上 prompt")
	}

	cwd := runner.Expand(ctx, t.Cwd, vars, deps.Builtins)
	if strings.TrimSpace(cwd) == "" {
		cwd = deps.BaseDir // 显式兜底，不依赖子进程「继承父进程 cwd」的隐式语义
	}
	if fi, err := os.Stat(cwd); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("工作目录不存在或不是目录: %s", cwd)
	}

	cfg := runner.AIConfig{
		CLI:          strings.TrimSpace(opts.Global["AI_CLI"]), // 空则由 AIRunner 取缺省
		Rules:        LoadRules(deps.BaseDir),
		SystemPrompt: runner.Expand(ctx, systemTmpl, vars, deps.Builtins),
		Prompt:       prompt,
		Resume:       resume,
		Cwd:          cwd,
		Timeout:      lt.Timeout,
		Env:          runner.ExpandMap(ctx, runner.MergeEnv(t.Env, opts.ExtraEnv), vars, deps.Builtins),
		Inputs:       envInputs(opts.Global, inputs),
	}

	if len(t.Skills) > 0 {
		if deps.SkillRouter == nil {
			return nil, fmt.Errorf("任务绑定了 skills 但 SkillRouter 未注入")
		}
		items, routeReport, err := deps.SkillRouter.Route(t.Skills, cwd, cfg.CLI)
		if err != nil {
			return nil, err
		}
		syncReport, err := SyncSkills(items)
		if err != nil {
			return nil, err
		}
		if err := deps.SkillRouter.Record(items); err != nil {
			syncReport.Warnings = append(syncReport.Warnings,
				fmt.Sprintf("[skill-sync] 足迹账本写入失败（不影响本次同步）: %v", err))
		}
		cfg.SkillSyncReport = syncReport.Lines()
		cfg.SkillSyncWarnings = append(routeReport.Warnings, syncReport.Warnings...)
	}
	return &runner.AIRunner{Cfg: cfg}, nil
}

// resolveInputs 合出已声明参数的终值输入，优先级：本次传入 > 定义默认值 > config.yaml 同名值。
// 键出现即算传入（空值也保留，不回落默认值）；保留运行参数不参与，它们不是输入。
// 第二个返回值是「取自定义默认值」的键集合，这些值还需在查找源齐备后展开。
// 传入未声明的参数名直接报错——比拼写错误静默落空更早被发现。
func resolveInputs(specs []registry.ParamSpec, opts Options) (inputs map[string]any, fromDefault map[string]bool, err error) {
	inputs = make(map[string]any, len(opts.Params))
	for name, v := range opts.Params {
		if ai.IsReservedRunParam(name) {
			continue
		}
		inputs[name] = v
	}
	declared := make(map[string]bool, len(specs))
	for _, spec := range specs {
		declared[spec.ID] = true
		if _, ok := inputs[spec.ID]; ok {
			continue
		}
		if spec.Default != "" {
			inputs[spec.ID] = spec.Default
			if fromDefault == nil {
				fromDefault = map[string]bool{}
			}
			fromDefault[spec.ID] = true
		} else if g, ok := opts.Global[spec.ID]; ok {
			inputs[spec.ID] = g
		}
	}
	for name := range inputs {
		if !declared[name] {
			return nil, nil, fmt.Errorf("未知参数 %q", name)
		}
	}
	return inputs, fromDefault, nil
}

// envInputs 合出进入子进程 env 的变量源：config.yaml + 已声明的输入。
// 保留运行参数不在其中——大段提示词不该出现在子进程环境里。
func envInputs(global map[string]string, inputs map[string]any) map[string]any {
	out := make(map[string]any, len(global)+len(inputs))
	for k, v := range global {
		out[k] = v
	}
	for k, v := range inputs {
		out[k] = v
	}
	return out
}

// valueText 把任意类型的输入值转成文本（nil 视为空串）。
func valueText(v any) string {
	switch s := v.(type) {
	case nil:
		return ""
	case string:
		return s
	default:
		return fmt.Sprint(v)
	}
}
