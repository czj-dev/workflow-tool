package cli

import (
	"path/filepath"

	"workflow-tool/internal/actionrun"
	"workflow-tool/internal/adb/binary"
	"workflow-tool/internal/adb/device"
	"workflow-tool/internal/builtinvars"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/workflow"
)

// env 是一次 CLI 调用的执行环境：加载好的 registry/workflow + 共享执行依赖。
// 对标 api.Service 的组装，但不含任何 Wails 依赖。
type env struct {
	baseDir  string
	reg      *registry.Registry
	wfReg    *workflow.WorkflowRegistry
	global   map[string]string
	builtins *builtinvars.Registry
	dev      *device.Service
	deps     actionrun.Deps
}

// loadEnv 以 baseDir 为基准加载 actions/workflows/config.yaml 并组装执行依赖。
func loadEnv(baseDir string) *env {
	reg := registry.Load(filepath.Join(baseDir, "actions"), baseDir)
	wfReg := workflow.Load(filepath.Join(baseDir, "workflows"))
	global, _ := registry.LoadGlobal(filepath.Join(baseDir, "config.yaml"))
	if global == nil {
		global = map[string]string{}
	}

	bin := binary.NewService()
	// binPaths 复刻 api.binPaths：config 覆盖 → PATH → 常见路径。
	binPaths := func() binary.Paths {
		return bin.Paths(global["ADB_PATH"], global["FASTBOOT_PATH"], global["SCRCPY_PATH"])
	}
	dev := device.NewService(binPaths)
	builtins := builtinvars.New(dev)

	deps := actionrun.Deps{
		BaseDir:   baseDir,
		ADBPaths:  binPaths,
		ADBDevice: dev,
		Builtins:  builtins,
		BashPath:  func() string { return global["BASH_PATH"] },
		// LLM 动作在 CLI v1 被禁跑，不会走到 buildLLM，故无需 SkillRouter。
		SkillRouter: nil,
	}
	return &env{baseDir: baseDir, reg: reg, wfReg: wfReg, global: global, builtins: builtins, dev: dev, deps: deps}
}

// merge 合并全局配置与参数（参数覆盖同名全局），委托 actionrun.MergeParams 单一真相源。
func (e *env) merge(params map[string]any) map[string]any {
	return actionrun.MergeParams(e.global, params)
}

// target 是 id 解析结果：命中的是 action 还是 workflow。
type target struct {
	kind string // "action" | "workflow"
	la   registry.LoadedAction
	lw   workflow.LoadedWorkflow
}

// resolve 按 id + 可选 kind 定位目标；撞名无 kind → ambiguous_id，均未命中 → unknown_id。
func (e *env) resolve(id, kind string) (target, *cliError) {
	la, aok := e.reg.Actions[id]
	lw, wok := e.wfReg.Workflows[id]
	switch kind {
	case "action":
		if !aok {
			return target{}, &cliError{"unknown_id", "未知 action " + id}
		}
		return target{kind: "action", la: la}, nil
	case "workflow":
		if !wok {
			return target{}, &cliError{"unknown_id", "未知 workflow " + id}
		}
		return target{kind: "workflow", lw: lw}, nil
	case "":
		switch {
		case aok && wok:
			return target{}, &cliError{"ambiguous_id", "id " + id + " 同时是 action 和 workflow，请加 --kind action|workflow"}
		case aok:
			return target{kind: "action", la: la}, nil
		case wok:
			return target{kind: "workflow", lw: lw}, nil
		default:
			return target{}, &cliError{"unknown_id", "未知 id " + id}
		}
	default:
		return target{}, &cliError{"bad_params", "--kind 只能是 action 或 workflow，got " + kind}
	}
}
