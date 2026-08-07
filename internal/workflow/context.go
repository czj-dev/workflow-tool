package workflow

// StepOutput 是单个 step 的执行结果快照，用于后续 step 通过 steps.<id>.outputs.<key> 引用。
type StepOutput struct {
	Outputs map[string]string
}

// StepContext 累积 workflow 执行中的所有可查询变量。
// Steps 键为 step.id 或索引兜底字符串（如 "0"/"1"）。
type StepContext struct {
	Steps  map[string]StepOutput
	Env    map[string]string // workflow.env 合并 step.env 后的展开值
	Params map[string]any    // 表单参数（含全局 config 合并结果，params 侧命名空间）
	Config map[string]string // config.yaml 原样（保留通道，暂供 expr 查询）
}

// Flatten 展平为 expr.Eval 的 env map：顶层 key 为 steps/env/params/config，
// steps 下再嵌套 <id>.outputs.<key>。所有值转成 any 以便 expr 反射访问。
func (c *StepContext) Flatten() map[string]any {
	stepsMap := make(map[string]any, len(c.Steps))
	for id, so := range c.Steps {
		outs := make(map[string]any, len(so.Outputs))
		for k, v := range so.Outputs {
			outs[k] = v
		}
		stepsMap[id] = map[string]any{"outputs": outs}
	}
	envMap := make(map[string]any, len(c.Env))
	for k, v := range c.Env {
		envMap[k] = v
	}
	configMap := make(map[string]any, len(c.Config))
	for k, v := range c.Config {
		configMap[k] = v
	}
	paramsMap := make(map[string]any, len(c.Params))
	for k, v := range c.Params {
		paramsMap[k] = v
	}
	return map[string]any{
		"steps":  stepsMap,
		"env":    envMap,
		"params": paramsMap,
		"config": configMap,
	}
}
