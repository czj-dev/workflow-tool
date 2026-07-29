package runner

import (
	"os"
	"testing"
)

func TestExpandParamsPriority(t *testing.T) {
	os.Setenv("V", "fromenv")
	defer os.Unsetenv("V")

	// params 优先于 env
	got := Expand("v=${V}", map[string]any{"V": "fromparam"})
	if got != "v=fromparam" {
		t.Fatalf("params 应优先，got %q", got)
	}
	// 无 params 时回退 env
	got = Expand("v=${V}", map[string]any{})
	if got != "v=fromenv" {
		t.Fatalf("应回退 env，got %q", got)
	}
}

func TestExpandUndefinedKept(t *testing.T) {
	os.Unsetenv("NOPE_X")
	// params 与 env 都无：保留原样
	got := Expand("x=${NOPE_X}", map[string]any{})
	if got != "x=${NOPE_X}" {
		t.Fatalf("未定义应保留原样，got %q", got)
	}
}

func TestExpandNonStringVar(t *testing.T) {
	// bool/数字等 any 值转字符串
	got := Expand("b=${B}", map[string]any{"B": true})
	if got != "b=true" {
		t.Fatalf("bool 应转字符串，got %q", got)
	}
}
