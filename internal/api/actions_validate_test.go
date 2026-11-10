package api

import (
	"encoding/json"
	"os"
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

func TestAddPresetValidatesBeforeWriting(t *testing.T) {
	cases := []struct {
		name, kind, value string
		valid             bool
	}{
		{"list invalid", "list", `[1]`, false},
		{"arguments dynamic", "arguments", "${ARGS}", false},
		{"arguments missing values", "arguments", `[{"flag":"x"}]`, false},
		{"list empty array", "list", "[]", true},
		{"arguments valid", "arguments", `[{"flag":"--es","values":["中😀"]}]`, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			actionsDir := filepath.Join(dir, "actions")
			if err := os.Mkdir(actionsDir, 0755); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(actionsDir, "a.yaml")
			original := "id: a\ntitle: A\ncommand:\n  run: echo\nparams:\n  - id: MY_PARAM\n    type: " + tc.kind + "\n"
			if err := os.WriteFile(path, []byte(original), 0644); err != nil {
				t.Fatal(err)
			}
			svc := New(registry.Load(actionsDir, dir), nil, dir,
				filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
			result, err := svc.AddPreset("a", "my-preset", "", map[string]string{"MY_PARAM": tc.value})
			data, readErr := os.ReadFile(path)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if !tc.valid {
				if err == nil || !strings.Contains(err.Error(), "MY_PARAM") || !strings.Contains(err.Error(), "my-preset") {
					t.Fatalf("expected contextual error, got %v", err)
				}
				if string(data) != original {
					t.Fatalf("invalid preset changed file: %s", data)
				}
				return
			}
			if err != nil || len(result.Actions) != 1 || len(result.Actions[0].Presets) != 1 ||
				result.Actions[0].Presets[0].Values["MY_PARAM"] != tc.value {
				t.Fatalf("valid preset was not persisted and reloaded: %v, %+v", err, result)
			}
		})
	}
}

func TestAddPresetRejectsInvalidOnDiskActionWithoutWriting(t *testing.T) {
	dir := t.TempDir()
	actionsDir := filepath.Join(dir, "actions")
	if err := os.Mkdir(actionsDir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(actionsDir, "a.yaml")
	if err := os.WriteFile(path, []byte("id: a\ntitle: A\ncommand:\n  run: echo\n"), 0644); err != nil {
		t.Fatal(err)
	}
	svc := New(registry.Load(actionsDir, dir), nil, dir,
		filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
	invalid := "id: a\ntitle: A\ncommand:\n  run: echo\n  script: bad.sh\n"
	if err := os.WriteFile(path, []byte(invalid), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AddPreset("a", "new", "", nil); err == nil || !strings.Contains(err.Error(), "互斥") {
		t.Fatalf("expected full action validation, got %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != invalid {
		t.Fatalf("invalid on-disk action must not change: %v, %s", err, data)
	}
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
