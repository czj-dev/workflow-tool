package cli

import (
	"context"
	"path/filepath"
	"time"

	"workflow-tool/internal/actionrun"
	"workflow-tool/internal/adb/binary"
	"workflow-tool/internal/adb/device"
	"workflow-tool/internal/ai"
	"workflow-tool/internal/airun"
	"workflow-tool/internal/apphome"
	"workflow-tool/internal/builtinvars"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
	"workflow-tool/internal/runstore"
	"workflow-tool/internal/targetlock"
	"workflow-tool/internal/workflow"
)

// env 是一次 CLI 调用的执行环境：加载好的 registry/workflow/AI 任务 + 共享执行依赖。
// 对标 api.Service 的组装，但不含任何 Wails 依赖。
type env struct {
	baseDir  string
	reg      *registry.Registry
	wfReg    *workflow.WorkflowRegistry
	aiReg    *ai.Registry
	global   map[string]string
	builtins *builtinvars.Registry
	dev      *device.Service
	deps     actionrun.Deps
	aiDeps   airun.Deps
	// locks 是落盘的目标锁：CLI 运行与执行器运行同应用内的运行互斥。
	locks *targetlock.Locks
	// allowAI 为 true 时放行 AI 任务与含 AI 步骤的 workflow（--allow-ai，见 run.go）。
	allowAI bool
	// heartbeatEvery / stopPollEvery 是执行器回写心跳、轮询停止标记的间隔（见 executor.go）。
	// 测试缩短它们。
	heartbeatEvery time.Duration
	stopPollEvery  time.Duration
}

// loadEnv 以 baseDir 为基准加载 actions/ai/workflows/config.yaml 并组装执行依赖。
// 对标 api.Service 的组装，但不含任何 Wails 依赖。
func loadEnv(baseDir string) *env {
	reg := registry.Load(filepath.Join(baseDir, "actions"), baseDir)
	wfReg := workflow.Load(filepath.Join(baseDir, "workflows"))
	aiReg := ai.Load(filepath.Join(baseDir, "ai"), reg.Skills)
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
	}
	aiDeps := airun.Deps{BaseDir: baseDir, Builtins: builtins,
		SkillDirs: airun.SkillDirResolver(func() map[string]registry.SkillMeta { return reg.Skills }),
		// 每次运行现读用户级 auth.json（apphome.AuthPath()）：与 api 路径同一合并
		// 语义，GUI 与 shell 跑同一份 Agent 配置。
		AgentConfig: func() (map[string]string, error) { return registry.LoadAuth(apphome.AuthPath()) }}
	return &env{baseDir: baseDir, reg: reg, wfReg: wfReg, aiReg: aiReg, global: global, builtins: builtins,
		dev: dev, deps: deps, aiDeps: aiDeps, locks: targetlock.New(baseDir),
		heartbeatEvery: runstore.HeartbeatInterval, stopPollEvery: time.Second}
}

// merge 合并全局配置与参数（参数覆盖同名全局）：global 先经 runner.ResolveGlobal
// 解到终值（config 层嵌套引用在此闭环，与 api.mergeGlobalAndParams 同语义），
// 再委托 actionrun.MergeParams 单一真相源。用户参数保持数据语义不参与解析。
func (e *env) merge(ctx context.Context, params map[string]any) map[string]any {
	return actionrun.MergeParams(runner.ResolveGlobal(ctx, e.global, e.builtins), params)
}

// target 是 id 解析结果：命中的是 action、workflow 还是 AI 任务。
type target struct {
	kind string // "action" | "workflow" | "ai"
	la   registry.LoadedAction
	lw   workflow.LoadedWorkflow
	lt   ai.LoadedTask // 定义在 lt.Task（具名字段，非内嵌）
}

// resolve 按 id + 可选 kind 定位目标；撞名无 kind → ambiguous_id，均未命中 → unknown_id。
func (e *env) resolve(id, kind string) (target, *cliError) {
	la, aok := e.reg.Actions[id]
	lw, wok := e.wfReg.Workflows[id]
	lt, tok := e.aiReg.Get(id)
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
	case "ai":
		if !tok {
			return target{}, &cliError{"unknown_id", "未知 AI 任务 " + id}
		}
		return target{kind: "ai", lt: lt}, nil
	case "":
		hits := 0
		for _, ok := range []bool{aok, wok, tok} {
			if ok {
				hits++
			}
		}
		switch {
		case hits > 1:
			return target{}, &cliError{"ambiguous_id", "id " + id + " 同时是 action、workflow、AI 任务中的多个，请加 --kind action|workflow|ai"}
		case aok:
			return target{kind: "action", la: la}, nil
		case wok:
			return target{kind: "workflow", lw: lw}, nil
		case tok:
			return target{kind: "ai", lt: lt}, nil
		default:
			return target{}, &cliError{"unknown_id", "未知 id " + id}
		}
	default:
		return target{}, &cliError{"bad_params", "--kind 只能是 action、workflow 或 ai，got " + kind}
	}
}
