package workflow

import (
	"reflect"
	"sort"
	"testing"
)

func sortedStrings(s []string) []string {
	out := append([]string{}, s...)
	sort.Strings(out)
	return out
}

func TestReferencedStepIDs_SingleRef(t *testing.T) {
	got := referencedStepIDs(`steps.build.outputs.exit_code == '0'`)
	want := []string{"build"}
	if !reflect.DeepEqual(sortedStrings(got), want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestReferencedStepIDs_MultipleRefs(t *testing.T) {
	got := referencedStepIDs(`steps.a.outputs.success == 'true' && steps.b.outputs.exit_code == '0'`)
	want := []string{"a", "b"}
	if !reflect.DeepEqual(sortedStrings(got), want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestReferencedStepIDs_NoStepsRef(t *testing.T) {
	got := referencedStepIDs(`env.LOG_LEVEL == 'debug' && params.MODE == 'fast'`)
	if len(got) != 0 {
		t.Fatalf("got %v want empty", got)
	}
}

func TestReferencedStepIDs_EmptyExpr(t *testing.T) {
	got := referencedStepIDs("")
	if len(got) != 0 {
		t.Fatalf("got %v want empty", got)
	}
}

func TestReferencedStepIDs_SyntaxError_ReturnsNil(t *testing.T) {
	got := referencedStepIDs(`steps.build.outputs.`) // 语法不完整
	if len(got) != 0 {
		t.Fatalf("语法错误应返回空，got %v", got)
	}
}

func TestReferencedStepIDs_StringLiteralNotMatched(t *testing.T) {
	// 字符串常量里恰好包含 "steps.x.outputs" 文本，不应被误识别为引用
	got := referencedStepIDs(`env.MSG == 'steps.x.outputs'`)
	if len(got) != 0 {
		t.Fatalf("字符串常量不应被识别为引用，got %v", got)
	}
}
