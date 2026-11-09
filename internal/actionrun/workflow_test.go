package actionrun

import (
	"context"
	"testing"
	"time"

	"workflow-tool/internal/registry"
	"workflow-tool/internal/workflow"
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

func TestWorkflowActionEmptyDefaultUsesEnvironment(t *testing.T) {
	t.Setenv("FOO", "from-environment")
	reg := &registry.Registry{Actions: map[string]registry.LoadedAction{
		"example": {
			Def: registry.ActionDef{
				Params:  []registry.ParamSpec{{ID: "FOO"}},
				Command: registry.Command{Run: "printf '%s\\n' \"${FOO}\""},
			},
			Timeout: time.Second,
		},
	}}
	actionRun, _ := WorkflowCallbacks(reg, Deps{}, nil)
	result := actionRun(workflow.ActionRequest{
		Ctx: context.Background(), ActionID: "example", Emit: func(string, string) {},
	})
	if result.Err != nil || result.ExitCode != 0 || result.Stdout != "from-environment\n" {
		t.Fatalf("empty default should not shadow environment: %+v", result)
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
