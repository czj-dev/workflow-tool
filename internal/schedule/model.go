package schedule

import (
	"fmt"

	"workflow-tool/internal/target"
)

// TargetKind 是调度所指目标的种类，三选一（ADR-0005：AI 任务是第三种调度目标）。
// 种类与运行记录共用同一套词汇（internal/target），两边不各自定义字符串常量。
type TargetKind = target.Kind

const (
	TargetAction   = target.Action
	TargetWorkflow = target.Workflow
	TargetAI       = target.AI
)

// Definition 是一条调度：何时运行（Cron）及其指向的唯一目标。
// 目标三选一：Action / Workflow / AI 各对应 schedules.yaml 里的同名键，恰好写一个。
type Definition struct {
	ID       string         `yaml:"id"`
	Name     string         `yaml:"name"`
	Enabled  bool           `yaml:"enabled"`
	Cron     string         `yaml:"cron"`
	Action   string         `yaml:"action,omitempty"`
	Workflow string         `yaml:"workflow,omitempty"`
	AI       string         `yaml:"ai,omitempty"`
	Params   map[string]any `yaml:"params,omitempty"`
	// CatchUp 为 true 时，应用恢复后为最近一个错过的调度时刻补跑一次；默认关闭。
	CatchUp bool `yaml:"catch_up,omitempty"`
}

// Target 返回目标种类与 id；没有目标或多于一个目标都是错误。
func (d Definition) Target() (TargetKind, string, error) {
	switch {
	case d.Action != "" && d.Workflow == "" && d.AI == "":
		return TargetAction, d.Action, nil
	case d.Workflow != "" && d.Action == "" && d.AI == "":
		return TargetWorkflow, d.Workflow, nil
	case d.AI != "" && d.Action == "" && d.Workflow == "":
		return TargetAI, d.AI, nil
	}
	return "", "", fmt.Errorf("specify exactly one of action, workflow or ai")
}
