package schedule

import "fmt"

type TargetKind string

const (
	TargetAction   TargetKind = "action"
	TargetWorkflow TargetKind = "workflow"
)

type Definition struct {
	ID       string         `yaml:"id"`
	Name     string         `yaml:"name"`
	Enabled  bool           `yaml:"enabled"`
	Cron     string         `yaml:"cron"`
	Action   string         `yaml:"action,omitempty"`
	Workflow string         `yaml:"workflow,omitempty"`
	Params   map[string]any `yaml:"params,omitempty"`
}

func (d Definition) Target() (TargetKind, string, error) {
	if (d.Action == "") == (d.Workflow == "") {
		return "", "", fmt.Errorf("schedule %q: specify exactly one of action or workflow", d.ID)
	}
	if d.Action != "" {
		return TargetAction, d.Action, nil
	}
	return TargetWorkflow, d.Workflow, nil
}
