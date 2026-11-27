// Package airun 把一份 AI 任务定义与一次运行的输入构造成 runner.AIRunner
// （对标 actionrun 之于动作）。输入合并、保留运行参数、模板展开、守则读取、env 合并、
// pi 初始化与 skill 零拷贝解析全部收敛在这里——手动运行与 workflow 的 ai step 共用
// 同一份构造逻辑，两条路径行为保持一致。
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
	// SkillDirs 把任务绑定的 skill ids 解析为源目录（零拷贝：--skill 直读源目录，
	// 见 skills.go）。声明了 skills 且为 nil 时 Build 报错（仅测试场景会是 nil）。
	SkillDirs func(ids []string) ([]string, error)
	// AgentConfig 每次运行现读用户级 auth.json（apphome.AuthPath()，键名沿用
	// AI_*）：Agent 三键的正源，非空值覆盖 Options.Global 同名键（config.yaml 退居
	// 回退）。nil 时跳过该层（仅测试场景）；读失败（文件损坏等）Build 早失败。
	AgentConfig func() (map[string]string, error)
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

// secretConfigKeys 是只从模板 vars 层剔除的 config 键（密钥防泄漏，设计 §4）：
// 密钥不进提示词与运行日志，模板里写 ${AI_AUTH_KEY} 保留字面量（Expand 未命中
// 记 warning）。子进程 env 不黑名单——pi 侧由 models.json 的 ${AI_AUTH_KEY} 插值
// 在请求时解析；父进程自身 env 无此键，Expand 的 env 兑底层不会命中。
var secretConfigKeys = map[string]bool{cfgKeyAuthKey: true}

// Build 把任务定义与本次输入构造成 AIRunner。
//
// 顺序：auth.json 合并（用户级 Agent 三键覆盖 config.yaml）→ 校验并合并输入 →
// 展开 prompt/system/cwd/env 模板 → 校验 cwd → 读取守则 →
// pi 初始化（可执行解析、三键校验、hermetic 目录与 models.json，pi_setup.go）→
// 绑定了 skills 时解析源目录（失败即返回 error，本次运行失败）。
// 输入里出现未声明的参数名、缺少必填参数、提示词展开后为空，都在这里报错——
// 早于任何进程启动。
func Build(ctx context.Context, lt ai.LoadedTask, deps Deps, opts Options) (*runner.AIRunner, error) {
	t := lt.Task

	// auth 合并层（ADR-0008 修订：Agent 三键迁往用户级 auth.json）：auth 非空值
	// 覆盖 config.yaml 同名键，其余键原样保留；之后的 vars / resolveInputs /
	// setupPI / envInputs 一律消费合并后的 config 层。读失败早失败——密钥文件
	// 损坏时静默回落旧值比显式报错更危险。
	global, err := mergedGlobal(opts.Global, deps.AgentConfig)
	if err != nil {
		return nil, err
	}

	inputs, fromDefault, err := resolveInputs(t.Params, opts.Params, global)
	if err != nil {
		return nil, err
	}
	// 模板查找源的第一层：生效 config 层（auth.json 覆盖后的 config.yaml）在底层，
	// 本次输入覆盖同名。（后两层「内置变量 → 环境变量」由 runner.Expand 内部按序兑底。）
	// 密钥键不进 vars（见 secretConfigKeys）；子进程 env 不受影响（envInputs 不滤）。
	vars := make(map[string]any, len(global)+len(inputs))
	for k, v := range global {
		if secretConfigKeys[k] {
			continue
		}
		vars[k] = v
	}
	for k, v := range inputs {
		if secretConfigKeys[k] {
			continue
		}
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

	// pi 侧初始化（pi_setup.go）：可执行解析、三键校验、hermetic 目录与 models.json。
	// 生效 config 层（auth 合并后）缺键在这里早失败——hermetic 设计下没有它们 pi
	// 必然无模型可用，早失败优于流内报错。
	piBin, model, agentDir, sessionDir, err := setupPI(deps.BaseDir, global)
	if err != nil {
		return nil, err
	}

	cfg := runner.AIConfig{
		PiBin:        piBin,
		Model:        model,
		Rules:        LoadRules(deps.BaseDir),
		SystemPrompt: runner.Expand(ctx, systemTmpl, vars, deps.Builtins),
		Prompt:       prompt,
		Resume:       resume,
		Cwd:          cwd,
		Timeout:      lt.Timeout,
		Env:          runner.ExpandMap(ctx, runner.MergeEnv(t.Env, opts.ExtraEnv), vars, deps.Builtins),
		Inputs:       envInputs(global, inputs),
		AgentDir:     agentDir,
		SessionDir:   sessionDir,
	}

	// config.yaml 残留 AI_CLI：pi 是唯一运行器，忽略并警告（BuildWarnings）。
	if strings.TrimSpace(opts.Global[cfgKeyLegacyCLI]) != "" {
		cfg.BuildWarnings = append(cfg.BuildWarnings,
			"[config] "+cfgKeyLegacyCLI+" 已忽略（pi 为唯一运行器）")
	}
	// config.yaml 残留 Agent 三键：仍生效（auth.json 非空键覆盖，无则直接回退），
	// 但正源已是用户级 auth.json，一条警告提示迁移，避免两处长期并存。
	if residual := agentKeysIn(opts.Global); len(residual) > 0 {
		cfg.BuildWarnings = append(cfg.BuildWarnings,
			"[config] "+strings.Join(residual, " / ")+" 残留于 config.yaml（仅作回退生效）：请迁移至用户级 auth.json（Settings → Agent）")
	}

	if len(t.Skills) > 0 {
		if deps.SkillDirs == nil {
			return nil, fmt.Errorf("任务绑定了 skills 但 SkillDirs 未注入")
		}
		dirs, err := deps.SkillDirs(t.Skills)
		if err != nil {
			return nil, err
		}
		cfg.SkillDirs = dirs
		cfg.SkillReport = []string{fmt.Sprintf("[skill] 绑定 %d 个 skill（零拷贝直传）：%s",
			len(t.Skills), strings.Join(t.Skills, ", "))}
	}
	return &runner.AIRunner{Cfg: cfg}, nil
}

// mergedGlobal 合出本次运行生效的 config 层：auth.json（用户级 Agent 配置，
// Deps.AgentConfig 现读）非空值覆盖 config.yaml 同名键，其余 config.yaml 键原样
// 保留。AgentConfig 为 nil（仅测试场景）或返回空 map 时退化为 config.yaml 本身，
// 行为与迁移前一致。auth 值为空白视作未配置——Settings 里清空一格不至于废掉
// 整个 config.yaml 回退层。
func mergedGlobal(global map[string]string, agentCfg func() (map[string]string, error)) (map[string]string, error) {
	if agentCfg == nil {
		return global, nil
	}
	auth, err := agentCfg()
	if err != nil {
		return nil, fmt.Errorf("读取 Agent 配置（auth.json）失败: %w", err)
	}
	if len(auth) == 0 {
		return global, nil
	}
	merged := make(map[string]string, len(global)+len(auth))
	for k, v := range global {
		merged[k] = v
	}
	for k, v := range auth {
		if strings.TrimSpace(v) != "" {
			merged[k] = v
		}
	}
	return merged, nil
}

// agentKeysIn 列出 global 里非空的 Agent 三键——config.yaml 残留检测：
// auth.json 成为正源后残留值仍生效（auth 覆盖或直接回退），但属过渡态，
// Build 以一条 BuildWarning 提示收口（对齐 AI_CLI 残留警告模式）。
func agentKeysIn(global map[string]string) []string {
	var keys []string
	for _, k := range []string{cfgKeyBaseURL, cfgKeyAuthKey, cfgKeyModel} {
		if strings.TrimSpace(global[k]) != "" {
			keys = append(keys, k)
		}
	}
	return keys
}

// resolveInputs 合出已声明参数的终值输入，优先级：本次传入 > 定义默认值 >
// 生效 config 层（auth.json 覆盖后的 config.yaml）同名值。
// 键出现即算传入（空值也保留，不回落默认值）；保留运行参数不参与，它们不是输入。
// 第二个返回值是「取自定义默认值」的键集合，这些值还需在查找源齐备后展开。
// 传入未声明的参数名直接报错——比拼写错误静默落空更早被发现。
func resolveInputs(specs []registry.ParamSpec, params map[string]any, global map[string]string) (inputs map[string]any, fromDefault map[string]bool, err error) {
	inputs = make(map[string]any, len(params))
	for name, v := range params {
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
		} else if g, ok := global[spec.ID]; ok {
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

// envInputs 合出进入子进程 env 的变量源：生效 config 层（auth 合并后）+ 已声明的输入。
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
