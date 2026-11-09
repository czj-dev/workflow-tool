package api

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"workflow-tool/internal/adb/logcat"
	"workflow-tool/internal/registry"
)

// TestActionsDirectoryValidates 确保仓库根的 actions/ 下所有 YAML 能通过 registry.Load
// （解析 + Validate 三选一互斥 + param type 校验）。新增 command.adb action 后尤其重要。
func TestActionsDirectoryValidates(t *testing.T) {
	// repo root = ../.. 相对于 internal/api；baseDir 传 repo 根，
	// 与真实运行时布局（exe 目录下 actions/ 与 skills/ 同级）一致，
	// 使 command.llm.skills 的引用校验能扫到仓库根 skills/
	dir := filepath.Join("..", "..", "actions")
	reg := registry.Load(dir, filepath.Join("..", ".."))
	if len(reg.Errors) > 0 {
		for _, e := range reg.Errors {
			t.Errorf("action load error in %s: %s", e.File, e.Error)
		}
	}
	if len(reg.Actions) == 0 {
		t.Fatal("no actions loaded from actions/")
	}
	// 至少覆盖四个域的 command.adb action
	want := []string{"adb-install", "adb-logcat", "adb-scrcpy",
		"adb-logcat-stream", "adb-list-files", "adb-push", "adb-screenshot"}
	for _, id := range want {
		la, ok := reg.Actions[id]
		if !ok {
			t.Errorf("action %q not loaded", id)
			continue
		}
		if la.Def.Command.Adb.Operation == "" {
			t.Errorf("action %q has no command.adb.operation", id)
		}
	}
	t.Logf("loaded %d actions, all validate OK", len(reg.Actions))
}

func TestLogcatScenarioPresets(t *testing.T) {
	reg := registry.Load(filepath.Join("..", "..", "actions"), filepath.Join("..", ".."))
	if len(reg.Errors) > 0 {
		t.Fatalf("action load errors: %v", reg.Errors)
	}
	action, ok := reg.Actions["adb-logcat-stream"]
	if !ok {
		t.Fatal("adb-logcat-stream not loaded")
	}

	cases := []struct {
		name string
		tags []string
	}{
		{"VTS / TopQuery", []string{"DVR_TopQueryInterceptor", "DVR_TopQueryUtil", "DVR_VtsManager", "DVR_VtsInterveneMatchImpl"}},
		{"导航多轮", []string{"DVR_NaviMultiRoundRule", "DVR_NavigationFlowDeviceModule", "DVR_ProtocolConverterManager", "DVR_TinnoveIpc"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var values map[string]string
			for _, preset := range action.Def.Presets {
				if preset.Name == tc.name {
					values = preset.Values
					break
				}
			}
			if values == nil {
				t.Fatalf("missing preset %q", tc.name)
			}
			if values["LEVEL"] != "V" || values["PACKAGE"] != "" {
				t.Fatalf("unexpected level/package: %v", values)
			}
			for _, key := range []string{"FILTER", "INCLUDE", "EXCLUDE"} {
				if value, ok := values[key]; !ok || value != "" {
					t.Errorf("%s must explicitly clear global config, got %q (present: %t)", key, value, ok)
				}
			}
			var tags []string
			if err := json.Unmarshal([]byte(values["TAG"]), &tags); err != nil {
				t.Fatalf("invalid TAG JSON: %v", err)
			}
			if strings.Join(tags, " ") != strings.Join(tc.tags, " ") {
				t.Fatalf("unexpected tags: %q", values["TAG"])
			}
			rule, err := logcat.RuleFromParamsExt(values["LEVEL"], values["TAG"], values["INCLUDE"], values["EXCLUDE"], values["PACKAGE"], values["FILTER"])
			if err != nil {
				t.Fatal(err)
			}
			compiled, err := logcat.CompileRule(rule)
			if err != nil {
				t.Fatal(err)
			}
			for _, tag := range tc.tags {
				if !compiled.Allow(&logcat.Entry{Level: "D", Tag: tag}) {
					t.Errorf("does not match %s", tag)
				}
			}
			if compiled.Allow(&logcat.Entry{Level: "D", Tag: "UnrelatedTag", Message: tc.tags[0]}) {
				t.Error("target tag in message matched an unrelated tag")
			}
		})
	}
}
