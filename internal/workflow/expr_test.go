package workflow

import "testing"

func TestEvalCondition_StepOutput(t *testing.T) {
	ctx := &StepContext{
		Steps: map[string]StepOutput{
			"build": {Outputs: map[string]string{"exit_code": "0", "success": "true"}},
		},
	}
	got, err := EvalCondition(`steps.build.outputs.exit_code == '0'`, ctx)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !got {
		t.Fatal("want true")
	}
}

func TestEvalCondition_BooleanOps(t *testing.T) {
	ctx := &StepContext{
		Steps: map[string]StepOutput{
			"a": {Outputs: map[string]string{"success": "true"}},
			"b": {Outputs: map[string]string{"success": "false"}},
		},
	}
	cases := []struct {
		expr string
		want bool
	}{
		{`steps.a.outputs.success == 'true' && steps.b.outputs.success == 'false'`, true},
		{`steps.a.outputs.success == 'true' || steps.b.outputs.success == 'true'`, true},
		{`!(steps.b.outputs.success == 'true')`, true},
		{`steps.a.outputs.success != steps.b.outputs.success`, true},
	}
	for _, c := range cases {
		got, err := EvalCondition(c.expr, ctx)
		if err != nil {
			t.Fatalf("%q: err %v", c.expr, err)
		}
		if got != c.want {
			t.Fatalf("%q: got %v want %v", c.expr, got, c.want)
		}
	}
}

func TestEvalCondition_EnvAndParams(t *testing.T) {
	ctx := &StepContext{
		Env:    map[string]string{"LOG_LEVEL": "debug"},
		Params: map[string]any{"MODE": "fast"},
	}
	got, err := EvalCondition(`env.LOG_LEVEL == 'debug' && params.MODE == 'fast'`, ctx)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !got {
		t.Fatal("want true")
	}
}

func TestSubstitute_ExpressionInShell(t *testing.T) {
	ctx := &StepContext{
		Steps: map[string]StepOutput{
			"a": {Outputs: map[string]string{"session_id": "sess-xyz"}},
		},
	}
	out, err := Substitute(`claude --resume ${{ steps.a.outputs.session_id }} "hi"`, ctx)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := `claude --resume sess-xyz "hi"`
	if out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
}

func TestSubstitute_NoExpression(t *testing.T) {
	ctx := &StepContext{}
	out, err := Substitute("echo hello", ctx)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if out != "echo hello" {
		t.Fatalf("got %q, want echo hello", out)
	}
}
