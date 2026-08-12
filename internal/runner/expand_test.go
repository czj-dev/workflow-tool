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

// ExpandParams 应把字符串值里的 ${VAR} 按同 map 的原始值展开。
// workflow action step params 常含 { PACKAGE: "${PACKAGE_REF}" } 这类引用。
func TestExpandParamsMapExpandsStringRefs(t *testing.T) {
	in := map[string]any{
		"PACKAGE":     "${PACKAGE_REF}",
		"PACKAGE_REF": "com.baidu.che.codriver",
	}
	out := ExpandParams(in)
	if out["PACKAGE"] != "com.baidu.che.codriver" {
		t.Fatalf("${PACKAGE_REF} 应被展开为包名，got %v", out["PACKAGE"])
	}
}

// ExpandParams 不应改动非字符串值（如 bool），保留原类型。
func TestExpandParamsMapKeepsNonStringValues(t *testing.T) {
	in := map[string]any{"ALLOW_TEST": true, "APK_PATH": "${X}", "X": "a.apk"}
	out := ExpandParams(in)
	if b, ok := out["ALLOW_TEST"].(bool); !ok || !b {
		t.Fatalf("bool 值应保持原类型与值，got %v", out["ALLOW_TEST"])
	}
	if out["APK_PATH"] != "a.apk" {
		t.Fatalf("字符串值应被展开，got %v", out["APK_PATH"])
	}
}

// 空/nil map 直接返回，不分配。
func TestExpandParamsMapNilEmpty(t *testing.T) {
	if got := ExpandParams(nil); got != nil {
		t.Fatalf("nil 应原样返回，got %v", got)
	}
	if got := ExpandParams(map[string]any{}); len(got) != 0 {
		t.Fatalf("空 map 应返回空，got %v", got)
	}
}
