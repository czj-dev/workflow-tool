// Package actionrun 把 registry.LoadedAction 构造成 runner.Runner。
// command 四选一形态分发（shell/script、adb.operation、llm.prompt）、env 分层
// （action 定义 + workflow/step 注入）、capture_output 合并（step 覆盖 > action
// 定义）、LLM 参数拼装全部收敛在这里——api 的直接执行路径与 workflow 的 action
// step 路径共用同一份构造逻辑，两条路径行为保持一致。
package actionrun

import (
	"context"
	"fmt"
	"strings"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adb/binary"
	"workflow-tool/internal/builtinvars"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
)

// DeviceResolver 是 ADB 形态需要的设备解析能力（*device.Service 实现）。
// 与 adb 包内部的 deviceResolver 同形，这里单独定义，避免对外暴露未导出类型。
type DeviceResolver interface {
	ResolveActive(ctx context.Context) (string, error)
	IsReady(ctx context.Context, serial string) bool
}

// Deps 是跨动作共享的执行依赖，由 api.Service 构造一次、全程复用。
type Deps struct {
	BaseDir   string                 // exe 目录，解析相对 script 路径
	ADBPaths  func() binary.Paths    // 二进制路径解析（config 覆盖 → PATH → 常见路径），唯一实现是 api.binPaths
	ADBDevice DeviceResolver         // 设备解析（serial 校验与回退）
	Builtins  *builtinvars.Registry  // 内置变量注册表（CURRENT_DATE/CURRENT_TIME/ADB_SERIAL）
}

// Options 是一次构造的可变输入：直接运行与 workflow step 运行的差异全部在这里。
type Options struct {
	// Params 是终值参数（${VAR} 已展开）。LLM 形态按 command.llm 声明的 param id
	// 从中取 system/prompt/resume 与 LLM_CLI。
	Params map[string]any
	// ExtraEnv 是 workflow/step 注入的 env（已展开），覆盖 action 定义的同名 env。
	// 直接运行为 nil。
	ExtraEnv map[string]string
	// CaptureOverride 覆盖 action 的 capture_output（step 显式设置时）；
	// nil 表示用 action 定义。
	CaptureOverride *bool
	// ADBControl 传递给 adb 形态 runner 的运行期控制通道（logcat-stream 过滤更新，
	// api 直跑路径注入）；nil = 无（workflow step 路径与普通动作）。非 adb 形态忽略。
	ADBControl chan any
}

// Build 按 LoadedAction 的 command 形态构造对应 Runner。
// registry.Validate 已保证四选一互斥，default 分支即 shell/script 形态。
func Build(ctx context.Context, la registry.LoadedAction, deps Deps, opts Options) runner.Runner {
	capture := la.Def.Command.CaptureOutput
	if opts.CaptureOverride != nil {
		capture = opts.CaptureOverride
	}
	switch {
	case la.Def.Command.Adb.Operation != "":
		return &adb.ADBRunner{
			Operation:    la.Def.Command.Adb.Operation,
			Timeout:      la.Timeout,
			Dev:          deps.ADBDevice,
			ResolvePaths: deps.ADBPaths,
			Control:      opts.ADBControl,
			Builtins:     deps.Builtins,
		}
	case la.Def.Command.LLM.Prompt != "":
		return buildLLM(ctx, la, opts, deps.Builtins)
	default:
		return &runner.ShellRunner{Cfg: runner.ShellConfig{
			Shell:         la.Def.Command.Shell,
			Script:        la.Def.Command.Script,
			Cwd:           la.Cwd, // raw，由 ShellRunner 用 params 替换
			Timeout:       la.Timeout,
			Env:           mergeEnv(la.Def.Command.Env, opts.ExtraEnv),
			BaseDir:       deps.BaseDir,
			CaptureOutput: capture,
			Builtins:      deps.Builtins,
		}}
	}
}

// buildLLM 按 command.llm 声明的 param id 从 params 取终值构造 LLMRunner。
// CLI 名空时由 LLMRunner 内部取默认（ducc）。
func buildLLM(ctx context.Context, la registry.LoadedAction, opts Options, builtins *builtinvars.Registry) runner.Runner {
	cmd := la.Def.Command.LLM
	return &runner.LLMRunner{Cfg: runner.LLMConfig{
		CLI:          strOf(opts.Params, "LLM_CLI"),
		SystemPrompt: strOf(opts.Params, cmd.System),
		Prompt:       strOf(opts.Params, cmd.Prompt),
		Resume:       strings.TrimSpace(strOf(opts.Params, cmd.Resume)),
		// LLMRunner 不做 ${VAR} 替换，Cwd 在这里展开成终值（与 Shell 形态传 raw 不同）。
		Cwd:      runner.Expand(ctx, la.Cwd, opts.Params, builtins),
		Timeout:  la.Timeout,
		Env:      mergeEnv(la.Def.Command.Env, opts.ExtraEnv),
		Builtins: builtins,
	}}
}

// mergeEnv 合并 action 定义 env 与注入 env（注入覆盖同名）。
func mergeEnv(actionEnv, extraEnv map[string]string) map[string]string {
	if len(extraEnv) == 0 {
		return actionEnv
	}
	out := make(map[string]string, len(actionEnv)+len(extraEnv))
	for k, v := range actionEnv {
		out[k] = v
	}
	for k, v := range extraEnv {
		out[k] = v
	}
	return out
}

// strOf 从 params map 安全取 string 值（key 空或缺失返回 ""）。
func strOf(params map[string]any, key string) string {
	if key == "" {
		return ""
	}
	v, ok := params[key]
	if !ok || v == nil {
		return ""
	}
	return fmt.Sprint(v)
}
