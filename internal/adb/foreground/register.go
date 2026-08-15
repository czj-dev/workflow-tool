package foreground

import (
	"strconv"
	"strings"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

func init() {
	adb.RegisterOperation("foreground-info", handleForegroundInfo)
}

// paramBoolDefaultTrue 取 bool param，未传时默认 true（三个段开关的默认勾选语义；
// op.ParamBool 缺失返回 false，不适用）。
func paramBoolDefaultTrue(op *adb.OpContext, key string) bool {
	v, ok := op.Params[key]
	if !ok || v == nil {
		return true
	}
	switch t := v.(type) {
	case bool:
		return t
	case string:
		b, _ := strconv.ParseBool(strings.TrimSpace(t))
		return b
	}
	return true
}

// parseMaxDepth 解析 TREE_MAX_DEPTH：空=不限(0)；非正整数视为不限并 warning。
func parseMaxDepth(op *adb.OpContext) int {
	s := op.ParamStr("TREE_MAX_DEPTH")
	if s == "" {
		return 0
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		op.EmitStdout("warning: TREE_MAX_DEPTH=" + s + " 不是正整数，视为不限")
		return 0
	}
	return n
}

// handleForegroundInfo 编排三段：按勾选采集 → 解析 → 格式化 emit。
// 段级失败只 emit warning 继续其余段；全部勾选段失败才非 0。
func handleForegroundInfo(op *adb.OpContext) adb.OpResult {
	wantActivity := paramBoolDefaultTrue(op, "ACTIVITY")
	wantWindows := paramBoolDefaultTrue(op, "WINDOWS")
	wantTree := paramBoolDefaultTrue(op, "VIEW_TREE")
	maxDepth := parseMaxDepth(op)

	sections, failed := 0, 0
	first := true
	emitSection := func(lines []string) {
		if !first {
			op.EmitStdout("")
		}
		first = false
		for _, l := range lines {
			op.EmitStdout(l)
		}
	}
	fail := func(msg string) {
		failed++
		if !first {
			op.EmitStdout("")
		}
		first = false
		op.EmitStdout("warning: " + msg)
	}

	if wantActivity {
		sections++
		if dump, err := collectActivity(op); err != nil {
			fail("获取前台 Activity 失败: " + err.Error())
		} else if a, ok := parseTopActivity(dump); ok {
			emitSection(formatActivity(a))
		} else {
			fail("未解析到 topResumedActivity（无前台 Activity 或格式不符）")
		}
	}
	if wantWindows {
		sections++
		if dump, err := collectWindows(op); err != nil {
			fail("获取焦点窗口失败: " + err.Error())
		} else if ws := parseWindowDisplays(dump); len(ws) > 0 {
			emitSection(formatWindows(ws))
		} else {
			fail("未解析到焦点窗口字段（格式不符）")
		}
	}
	if wantTree {
		sections++
		if xmlData, err := collectUITree(op); err != nil {
			fail("获取 View 树失败: " + err.Error())
		} else if tree, err := parseUITree(xmlData); err != nil {
			fail("解析 uiautomator XML 失败: " + err.Error())
		} else {
			emitSection(formatTree(tree, maxDepth))
		}
	}

	if sections > 0 && failed == sections {
		msg := "所有勾选段均失败"
		opErr := adbcore.NewOperationError("foreground-info", msg, "", false)
		op.EmitStderr(msg)
		return adb.OpResult{ExitCode: 1, Err: opErr, Stderr: msg}
	}
	return adb.OpResult{ExitCode: 0}
}
