package workflow

import (
	"strings"
	"testing"
)

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

// TestEvalCondition_EvalError 覆盖 expr.Eval 失败分支。
// 注意：expr 对未定义变量返回 nil 而非 error，故必须用语法错误触发。
func TestEvalCondition_EvalError(t *testing.T) {
	ctx := &StepContext{}
	got, err := EvalCondition("1 +", ctx)
	if err == nil {
		t.Fatal("want eval error, got nil")
	}
	if got {
		t.Fatalf("want false on error, got %v", got)
	}
	if !strings.Contains(err.Error(), "if 表达式求值失败") {
		t.Fatalf("want 求值失败 error, got %v", err)
	}
	if !strings.Contains(err.Error(), `"1 +"`) {
		t.Fatalf("error should quote the offending expression, got %v", err)
	}
}

// TestEvalCondition_NonBoolResult 覆盖求值成功但返回值非 bool 的分支。
func TestEvalCondition_NonBoolResult(t *testing.T) {
	ctx := &StepContext{}
	got, err := EvalCondition("1 + 1", ctx)
	if err == nil {
		t.Fatal("want type error, got nil")
	}
	if got {
		t.Fatalf("want false on error, got %v", got)
	}
	if !strings.Contains(err.Error(), "if 表达式必须返回 bool") {
		t.Fatalf("want bool 类型错误, got %v", err)
	}
	// %T: %v 应报出实际类型与值
	if !strings.Contains(err.Error(), "int") || !strings.Contains(err.Error(), "2") {
		t.Fatalf("error should report actual type int and value 2, got %v", err)
	}
}

// TestSubstitute_EvalErrorReturnsEmpty 覆盖 firstErr 短路分支：
// 任一片段求值失败即返回 ("", err)，不返回部分替换结果。
func TestSubstitute_EvalErrorReturnsEmpty(t *testing.T) {
	ctx := &StepContext{
		Steps: map[string]StepOutput{
			"a": {Outputs: map[string]string{"v": "ok"}},
		},
	}
	out, err := Substitute(`echo ${{ steps.a.outputs.v }} ${{ 1 + }}`, ctx)
	if err == nil {
		t.Fatal("want substitute error, got nil")
	}
	if out != "" {
		t.Fatalf("want empty string on error (no partial substitution), got %q", out)
	}
	if !strings.Contains(err.Error(), "求值失败") {
		t.Fatalf("want 求值失败 error, got %v", err)
	}
	if !strings.Contains(err.Error(), "1 +") {
		t.Fatalf("error should name the failing fragment, got %v", err)
	}
}
