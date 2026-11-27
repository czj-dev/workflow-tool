package workflow

import (
	"strings"
	"testing"
)

// TestValidateStepKindsExclusive 锁定 step 的四选一：action、run、sleep、ai 必须且只能
// 出现一个。
func TestValidateStepKindsExclusive(t *testing.T) {
	base := func(s Step) *WorkflowDef {
		return &WorkflowDef{ID: "wf", Title: "W", Steps: []Step{s}}
	}
	for name, s := range map[string]Step{
		"action": {Action: "a"},
		"run":    {Run: "echo"},
		"sleep":  {Sleep: 1},
		"ai":     {AI: "demo-ask"},
	} {
		if err := Validate(base(s)); err != nil {
			t.Errorf("%s: 单一形态应合法，got %v", name, err)
		}
	}
	for name, s := range map[string]Step{
		"none":       {},
		"action+ai":  {Action: "a", AI: "demo-ask"},
		"run+ai":     {Run: "echo", AI: "demo-ask"},
		"sleep+ai":   {Sleep: 1, AI: "demo-ask"},
		"action+run": {Action: "a", Run: "echo"},
	} {
		err := Validate(base(s))
		if err == nil {
			t.Errorf("%s: 应报错", name)
			continue
		}
		want := "四者互斥"
		if name == "none" {
			want = "必须指定 action、run、sleep 或 ai 之一"
		}
		if !strings.Contains(err.Error(), want) {
			t.Errorf("%s: got %q want %q", name, err, want)
		}
	}
}

// TestValidateStepAIIDFormat 锁定 ai 引用的任务 id 格式（与 action id 同一约束）。
func TestValidateStepAIIDFormat(t *testing.T) {
	def := &WorkflowDef{ID: "wf", Title: "W", Steps: []Step{{AI: "Bad_ID"}}}
	err := Validate(def)
	if err == nil || !strings.Contains(err.Error(), "steps[0].ai") || !strings.Contains(err.Error(), "Bad_ID") {
		t.Fatalf("非法任务 id 应报错，got %v", err)
	}
}

// TestParseWorkflowAIStep 校验 `ai: <任务 id>` 解析进 Step.AI，其余字段不受影响。
func TestParseWorkflowAIStep(t *testing.T) {
	def, err := ParseWorkflow([]byte(`id: wf
title: W
steps:
  - id: analyze
    name: 分析缺陷
    ai: ai-bug-analyze
    params:
      BUG_URL: ${{ params.BUG_URL }}
      prompt: |
        只分析崩溃线程
`))
	if err != nil {
		t.Fatalf("ParseWorkflow: %v", err)
	}
	if err := Validate(def); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	s := def.Steps[0]
	if s.AI != "ai-bug-analyze" || s.Action != "" || s.Run != "" || s.Name != "分析缺陷" {
		t.Fatalf("解析结果不符: %+v", s)
	}
	if s.Params["prompt"] != "只分析崩溃线程\n" {
		t.Fatalf("prompt = %q", s.Params["prompt"])
	}
}
