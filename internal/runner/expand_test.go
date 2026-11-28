package runner

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"workflow-tool/internal/builtinvars"
)

func TestExpandParamsPriority(t *testing.T) {
	os.Setenv("V", "fromenv")
	defer os.Unsetenv("V")

	// params 优先于 env
	got := Expand(context.Background(), "v=${V}", map[string]any{"V": "fromparam"}, nil)
	if got != "v=fromparam" {
		t.Fatalf("params 应优先，got %q", got)
	}
	// 无 params 时回退 env
	got = Expand(context.Background(), "v=${V}", map[string]any{}, nil)
	if got != "v=fromenv" {
		t.Fatalf("应回退 env，got %q", got)
	}
}

func TestExpandUndefinedKept(t *testing.T) {
	os.Unsetenv("NOPE_X")
	// params 与 env 都无：保留原样
	got := Expand(context.Background(), "x=${NOPE_X}", map[string]any{}, nil)
	if got != "x=${NOPE_X}" {
		t.Fatalf("未定义应保留原样，got %q", got)
	}
}

func TestExpandNonStringVar(t *testing.T) {
	// bool/数字等 any 值转字符串
	got := Expand(context.Background(), "b=${B}", map[string]any{"B": true}, nil)
	if got != "b=true" {
		t.Fatalf("bool 应转字符串，got %q", got)
	}
}

// 裸 $VAR / $1 / $@ 不是 ${VAR}，必须原样保留交给 shell/awk，
// 否则 awk '{print $2}' 会被误展开成 '{print ${2}}' 触发语法错误。
func TestExpandLeavesBarePositionals(t *testing.T) {
	cases := []string{
		`awk '{print $2}'`,
		`echo $1 $@ $HOME`,
		`grep -E 'link/ether' | awk '{print $2}'`,
	}
	for _, in := range cases {
		if got := Expand(context.Background(), in, map[string]any{}, nil); got != in {
			t.Fatalf("裸 $ 应原样保留\n in : %q\n got: %q", in, got)
		}
	}
}

// 未闭合的 ${ 原样保留，不吞后续内容。
func TestExpandUnterminatedBrace(t *testing.T) {
	in := "a ${ b"
	if got := Expand(context.Background(), in, map[string]any{}, nil); got != in {
		t.Fatalf("未闭合 ${ 应原样保留，got %q", got)
	}
}

// ExpandParams 应把字符串值里的 ${VAR} 按同 map 的原始值展开。
// workflow action step params 常含 { PACKAGE: "${PACKAGE_REF}" } 这类引用。
func TestExpandParamsMapExpandsStringRefs(t *testing.T) {
	in := map[string]any{
		"PACKAGE":     "${PACKAGE_REF}",
		"PACKAGE_REF": "com.baidu.che.codriver",
	}
	out := ExpandParams(context.Background(), in, nil)
	if out["PACKAGE"] != "com.baidu.che.codriver" {
		t.Fatalf("${PACKAGE_REF} 应被展开为包名，got %v", out["PACKAGE"])
	}
}

// ExpandParams 不应改动非字符串值（如 bool），保留原类型。
func TestExpandParamsMapKeepsNonStringValues(t *testing.T) {
	in := map[string]any{"ALLOW_TEST": true, "APK_PATH": "${X}", "X": "a.apk"}
	out := ExpandParams(context.Background(), in, nil)
	if b, ok := out["ALLOW_TEST"].(bool); !ok || !b {
		t.Fatalf("bool 值应保持原类型与值，got %v", out["ALLOW_TEST"])
	}
	if out["APK_PATH"] != "a.apk" {
		t.Fatalf("字符串值应被展开，got %v", out["APK_PATH"])
	}
}

// 空/nil map 直接返回，不分配。
func TestExpandParamsMapNilEmpty(t *testing.T) {
	if got := ExpandParams(context.Background(), nil, nil); got != nil {
		t.Fatalf("nil 应原样返回，got %v", got)
	}
	if got := ExpandParams(context.Background(), map[string]any{}, nil); len(got) != 0 {
		t.Fatalf("空 map 应返回空，got %v", got)
	}
}

type stubDev struct{ serial string }

func (s *stubDev) ResolveActive(ctx context.Context) (string, error) {
	return s.serial, nil
}

func TestExpandBuiltinFallsBackAfterParamsMiss(t *testing.T) {
	os.Unsetenv("ADB_SERIAL")
	builtins := builtinvars.New(&stubDev{serial: "DEVICE_X"})
	got := Expand(context.Background(), "s=${ADB_SERIAL}", map[string]any{}, builtins)
	if got != "s=DEVICE_X" {
		t.Fatalf("params 未命中应查 builtins，got %q", got)
	}
}

func TestExpandParamsOverridesBuiltin(t *testing.T) {
	builtins := builtinvars.New(&stubDev{serial: "DEVICE_X"})
	got := Expand(context.Background(), "s=${ADB_SERIAL}", map[string]any{"ADB_SERIAL": "PINNED"}, builtins)
	if got != "s=PINNED" {
		t.Fatalf("params 应优先于 builtins，got %q", got)
	}
}

func TestExpandBuiltinBeforeEnv(t *testing.T) {
	os.Setenv("CURRENT_DATE", "envvalue")
	defer os.Unsetenv("CURRENT_DATE")
	builtins := builtinvars.New(nil)
	got := Expand(context.Background(), "d=${CURRENT_DATE}", map[string]any{}, builtins)
	if got == "d=envvalue" {
		t.Fatal("builtins 应优先于环境变量")
	}
	if len(got) != len("d=")+8 {
		t.Fatalf("CURRENT_DATE 应是 8 位日期，got %q", got)
	}
}

func TestExpandNilBuiltinsFallsBackToEnv(t *testing.T) {
	os.Setenv("V2", "fromenv2")
	defer os.Unsetenv("V2")
	got := Expand(context.Background(), "v=${V2}", map[string]any{}, nil)
	if got != "v=fromenv2" {
		t.Fatalf("builtins=nil 应跳过、回退 env，got %q", got)
	}
}

// ——— Expand 的单遍数据语义 ———

// Expand 对命中值只替换一层、不传递展开：用户输入（动作参数值、$literal、AI 输入）
// 是数据。嵌套引用由 ResolveGlobal 在 config 层预先解析（见下），不应改回在 Expand
// 里递归——airun 的 TestBuildInputsAreNotPreExpanded 与 api 的
// TestPrepareActionParamsPreservesOnlyLiteralKeys 锁定同一语义。
func TestExpandSinglePassKeepsNestedReferenceLiteral(t *testing.T) {
	vars := map[string]any{"A": "${B}", "B": "x"}
	if got := Expand(context.Background(), "${A}", vars, nil); got != "${B}" {
		t.Fatalf("Expand 应单遍替换，嵌套引用保留字面，got %q", got)
	}
}

// ——— ResolveGlobal：config 层的嵌套展开（config 值之间可互相引用） ———

// 复现 adb-screenshot 的 bug：config OUTPUT_DIR: ${DOCS}/docs → DOCS: ${USER}/Documents，
// 动作默认值 ${OUTPUT_DIR}/${CURRENT_TIME}.png 经单遍 Expand 命中字面值后 ${DOCS}
// 不再解析，终端值带着 ${DOCS} 交给 os.WriteFile 报错。config 层先解到终值即可。
func TestResolveGlobalChains(t *testing.T) {
	global := map[string]string{
		"USER":       "/Users/v",
		"DOCS":       "${USER}/Documents",
		"OUTPUT_DIR": "${DOCS}/docs",
	}
	got := ResolveGlobal(context.Background(), global, nil)
	if got["OUTPUT_DIR"] != "/Users/v/Documents/docs" {
		t.Fatalf("引用链应解到终值，got %q", got["OUTPUT_DIR"])
	}
	// 展开后的终值对单遍 Expand 即为终端值（用户路径的全链路行为）。
	merged := map[string]any{"OUTPUT_DIR": got["OUTPUT_DIR"]}
	if out := Expand(context.Background(), "${OUTPUT_DIR}/1795856301067.png", merged, nil); out != "/Users/v/Documents/docs/1795856301067.png" {
		t.Fatalf("合并后单遍展开应得终端值，got %q", out)
	}
}

// 链上可兑底内置变量与环境变量（优先级同 Expand，查找源只有 config 层）。
func TestResolveGlobalFallsBackToBuiltinsAndEnv(t *testing.T) {
	os.Setenv("CHAIN_HOME", "/Users/h")
	defer os.Unsetenv("CHAIN_HOME")
	global := map[string]string{
		"OUT":      "${HOME_DIR}/${CURRENT_DATE}",
		"HOME_DIR": "${CHAIN_HOME}/logs",
	}
	got := ResolveGlobal(context.Background(), global, builtinvars.New(nil))
	if len(got["OUT"]) != len("/Users/h/logs/")+8 {
		t.Fatalf("链内应兑底内置变量与 env，got %q", got["OUT"])
	}
}

// 链上的未定义变量保留 ${VAR} 原样（与顶层语义一致，另记 warning）。
func TestResolveGlobalKeepsUndefinedLeaf(t *testing.T) {
	global := map[string]string{"OUT": "${MISSING_X}/logs"}
	got := ResolveGlobal(context.Background(), global, nil)
	if got["OUT"] != "${MISSING_X}/logs" {
		t.Fatalf("链内未定义应保留原样，got %q", got["OUT"])
	}
}

// 自引成环：终止并保留符号引用。
// 外层解析 "${A}" → A 的值 "${A}/x" 入链 [A] → 内层再遇 A 触发环保护返回原值 "${A}/x"，
// 内层拼上剩余 "/x" 得 "${A}/x/x"，外层再拼 "/x" → 终值 "${A}/x/x/x"
//（确定值，重点是能终止且保留符号引用，运行期单遍 Expand 亦稳定）。
func TestResolveGlobalSelfReferenceTerminates(t *testing.T) {
	got := ResolveGlobal(context.Background(), map[string]string{"A": "${A}/x"}, nil)
	if got["A"] != "${A}/x/x/x" {
		t.Fatalf("自引应终止并保留符号引用，got %q", got["A"])
	}
}

// 互引成环（A→B→A）：终止且两键各自回到自身符号引用（A 得 "${A}"、B 得 "${B}"），
// 确定值、不展开成终值。重点是能终止、不 panic。
func TestResolveGlobalMutualCycleTerminates(t *testing.T) {
	got := ResolveGlobal(context.Background(), map[string]string{"A": "${B}", "B": "${A}"}, nil)
	if got["A"] != "${A}" || got["B"] != "${B}" {
		t.Fatalf("互引应终止且回到自身符号引用，got A=%q B=%q", got["A"], got["B"])
	}
	if !strings.Contains(got["A"], "${") {
		t.Fatalf("终值应保留符号引用，got %q", got["A"])
	}
}

// 链深上限：链上最多 8 个 config 键参与递归——A1→A2→…→A8→A9(叶子) 正常解到
// 叶子；链满 8 键后再遇含引用的键（A10: ${A11}）收口保留原样（叶子值是明文，
// 直接返回不走链深检查，故 A10 恰好是收口点）。
func TestResolveGlobalDepthCap(t *testing.T) {
	global := map[string]string{"A9": "leaf"}
	for i := 8; i >= 1; i-- {
		global[fmt.Sprintf("A%d", i)] = fmt.Sprintf("${A%d}", i+1)
	}
	if got := ResolveGlobal(context.Background(), global, nil); got["A1"] != "leaf" {
		t.Fatalf("8 键链应解到叶子，got %q", got["A1"])
	}
	// A9 再引用 A10，A10 的值仍含引用：解到 A10 时链上已有 8 键，保留 ${A11}。
	global["A9"] = "${A10}"
	global["A10"] = "${A11}"
	global["A11"] = "end"
	if got := ResolveGlobal(context.Background(), global, nil); got["A1"] != "${A11}" {
		t.Fatalf("超深链应在链满处收口保留原样，got %q", got["A1"])
	}
}
