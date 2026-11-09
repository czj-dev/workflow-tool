package actionrun

import (
	"context"
	"testing"

	"workflow-tool/internal/registry"
)

// buildActionRunParams 原为 api.Service 的方法，WorkflowCallbacks 统一后迁到本包包级函数，
// 测试随之迁入。展开变量源必须是 merged，自引用才能拿到真实值（见函数注释）。

// TestBuildActionRunParamsExpandsSelfRef 校验 step.params 里 { PACKAGE: "${PACKAGE}" }
// 能正确展开为 merged 的真实值，而不是自引用后原样保留。
// 复现 adb-clean-reinstall 第一步 force-stop 收到空包名（am force-stop 无参数）的 bug。
func TestBuildActionRunParamsExpandsSelfRef(t *testing.T) {
	merged := map[string]any{"PACKAGE": "com.baidu.che.codriver", "ADB_SERIAL": "S1"}
	stepParams := map[string]any{"PACKAGE": "${PACKAGE}"}
	runParams, _ := buildActionRunParams(context.Background(), Deps{}, merged, nil, stepParams)
	if runParams["PACKAGE"] != "com.baidu.che.codriver" {
		t.Fatalf("${PACKAGE} 应展开为真实包名，got %v", runParams["PACKAGE"])
	}
}

// step.params 的 ${VAR} 可引用 merged 中任意变量（如 ADB_SERIAL）。
func TestBuildActionRunParamsExpandsOtherVars(t *testing.T) {
	merged := map[string]any{"PACKAGE": "com.baidu.che.codriver", "OUTPUT_DIR": "/tmp/out"}
	stepParams := map[string]any{"OUTPUT_PATH": "${OUTPUT_DIR}", "PACKAGE": "${PACKAGE}"}
	runParams, _ := buildActionRunParams(context.Background(), Deps{}, merged, nil, stepParams)
	if runParams["OUTPUT_PATH"] != "/tmp/out" {
		t.Fatalf("${OUTPUT_DIR} 应展开，got %v", runParams["OUTPUT_PATH"])
	}
	if runParams["PACKAGE"] != "com.baidu.che.codriver" {
		t.Fatalf("${PACKAGE} 应展开，got %v", runParams["PACKAGE"])
	}
}

// env 的 ${VAR} 也用 merged 展开，结果供 ShellRunner 使用。
func TestBuildActionRunParamsExpandsEnv(t *testing.T) {
	merged := map[string]any{"ROOT": "/data"}
	env := map[string]string{"DATA": "${ROOT}/files"}
	_, expandedEnv := buildActionRunParams(context.Background(), Deps{}, merged, env, nil)
	if expandedEnv["DATA"] != "/data/files" {
		t.Fatalf("env 的 ${ROOT} 应展开，got %v", expandedEnv["DATA"])
	}
}

func TestBuildActionRunParamsExpandsWorkflowBaseParams(t *testing.T) {
	merged := map[string]any{"LOGS_DIR": "/logs", "OUT_DIR": "${LOGS_DIR}"}
	got, _ := buildActionRunParams(context.Background(), Deps{}, merged, nil, nil)
	if got["OUT_DIR"] != "/logs" {
		t.Fatalf("workflow 基础参数未展开: %#v", got)
	}
	if merged["OUT_DIR"] != "${LOGS_DIR}" {
		t.Fatal("不得修改传入的基础参数")
	}
}

func TestActionDefaultsFillMissingWorkflowParams(t *testing.T) {
	params := map[string]any{"ZIP_NAME": "logs.zip", "MODEL": "518", "INNER_PATH": "", "LOGS_DIR": "/logs"}
	specs := []registry.ParamSpec{
		{ID: "MODEL", Default: "5181"},
		{ID: "OUT_DIR", Default: "${LOGS_DIR}"},
		{ID: "INNER_PATH"},
		{ID: "MISSING_OPTIONAL"},
	}
	got := withActionDefaults(context.Background(), Deps{}, params, specs)
	if got["MODEL"] != "518" || got["OUT_DIR"] != "/logs" || got["INNER_PATH"] != "" {
		t.Fatalf("默认值与显式输入未正确合并: %#v", got)
	}
	if _, ok := params["OUT_DIR"]; ok {
		t.Fatal("不得修改传入的参数")
	}
	if _, ok := got["MISSING_OPTIONAL"]; ok {
		t.Fatal("没有默认值的可选参数不能覆盖子进程原有环境变量")
	}
}

// 非字符串 step.param（如 bool）保持原类型。
func TestBuildActionRunParamsKeepsNonString(t *testing.T) {
	merged := map[string]any{"PACKAGE": "p"}
	stepParams := map[string]any{"PACKAGE": "${PACKAGE}", "ALLOW_TEST": true}
	runParams, _ := buildActionRunParams(context.Background(), Deps{}, merged, nil, stepParams)
	if b, ok := runParams["ALLOW_TEST"].(bool); !ok || !b {
		t.Fatalf("bool 应保持原类型，got %v", runParams["ALLOW_TEST"])
	}
}
