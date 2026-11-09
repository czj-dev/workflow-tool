package registry_test

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"workflow-tool/internal/actionrun"
	"workflow-tool/internal/builtinvars"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
	"workflow-tool/internal/workflow"
)

func loadShellAction(t *testing.T, id string) registry.ActionDef {
	t.Helper()
	root := filepath.Join("..", "..")
	reg := registry.Load(filepath.Join(root, "actions"), root)
	if action, ok := reg.Actions[id]; ok {
		return action.Def
	}
	t.Fatalf("action %s not loaded: %v", id, reg.Errors)
	return registry.ActionDef{}
}

func defaultParams(def registry.ActionDef) map[string]any {
	params := make(map[string]any, len(def.Params))
	for _, field := range def.Params {
		params[field.ID] = field.Default
	}
	return params
}

func fakeADB(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("jq"); err != nil {
		t.Skipf("jq not installed: %v", err)
	}
	dir := t.TempDir()
	capture := filepath.Join(dir, "args")
	t.Setenv("CAPTURE", capture)
	t.Setenv("ADB_CALL", filepath.Join(dir, "adb-call"))
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	for name, script := range map[string]string{
		"adb": "#!/bin/sh\nprintf '%s\\0' \"$@\" >> \"$ADB_CALL\"\n[ \"$ADB_FAIL\" != 1 ] || exit 8\nif [ \"$1\" = '-s' ]; then shift 2; fi\n[ \"$1\" = shell ] || exit 3\nshift\n/bin/sh -c \"$1\"\n",
		"am":  "#!/bin/sh\nprintf '%s\\0' \"$@\" > \"$CAPTURE\"\n",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return capture
}

func readRemoteArgs(t *testing.T, file string) []string {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var args []string
	for _, part := range bytes.Split(bytes.TrimSuffix(data, []byte{0}), []byte{0}) {
		args = append(args, string(part))
	}
	return args
}

func TestActivityShellPreservesRemoteArguments(t *testing.T) {
	def := loadShellAction(t, "adb-debug-activity")
	if strings.Contains(strings.ReplaceAll(def.Command.Run, "${ADB_SERIAL}", ""), "${") {
		t.Fatal("shell-only brace expansions trigger unresolved-variable warnings in runner.Expand")
	}
	fields := map[string]string{}
	for _, field := range def.Params {
		fields[field.ID] = field.Type
	}
	if fields["PACKAGE"] != "text" || fields["ACTIVITY"] != "text" || fields["ARGS"] != "arguments" {
		t.Fatalf("param types: %v", fields)
	}
	presets := map[string]map[string]string{}
	for _, preset := range def.Presets {
		presets[preset.Name] = preset.Values
	}
	if presets["DebugActivity"] == nil || presets["MainActivity"] == nil {
		t.Fatalf("missing DebugActivity/MainActivity presets: %v", presets)
	}
	if presets["DebugActivity"]["ARGS"] != defaultParams(def)["ARGS"] || presets["DebugActivity"]["ACTIVITY"] != defaultParams(def)["ACTIVITY"] {
		t.Fatal("DebugActivity preset must preserve the default launch")
	}
	for _, tc := range []struct {
		name     string
		args     string
		activity string
		want     []string
	}{
		{"default", "", "", []string{"start", "-n", "com.baidu.che.codriver/com.baidu.che.codriver.ui.DebugActivity", "--es", "exec_button", "展示语音链路悬框"}},
		{"main preset", presets["MainActivity"]["ARGS"], presets["MainActivity"]["ACTIVITY"], []string{"start", "-n", "com.baidu.che.codriver/com.baidu.che.codriver.ui.MainActivity"}},
		{"repeated flags and shell characters", `[{"flag":"--es","values":["exec_button","two words ' \" $(printf injected) 中文"]},{"flag":"-W","values":[]},{"flag":"--es","values":["other","last"]}]`, "", []string{"start", "-n", "com.baidu.che.codriver/com.baidu.che.codriver.ui.DebugActivity", "--es", "exec_button", "two words ' \" $(printf injected) 中文", "-W", "--es", "other", "last"}},
		{"newline stays one remote value", `[{"flag":"--es","values":["note","line1\nline2; ' $(exit 9)"]}]`, "", []string{"start", "-n", "com.baidu.che.codriver/com.baidu.che.codriver.ui.DebugActivity", "--es", "note", "line1\nline2; ' $(exit 9)"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			capture := fakeADB(t)
			params := defaultParams(def)
			params["ADB_SERIAL"] = "device 1"
			if tc.args != "" {
				params["ARGS"] = tc.args
			}
			if tc.activity != "" {
				params["ACTIVITY"] = tc.activity
			}
			result := (&runner.ShellRunner{Cfg: runner.ShellConfig{Run: def.Command.Run, Timeout: 5 * time.Second}}).Run(context.Background(), params, func(string, string) {})
			if result.Err != nil || result.ExitCode != 0 {
				t.Fatalf("shell failed: %+v", result)
			}
			if got := readRemoteArgs(t, capture); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("remote args = %#v; want %#v", got, tc.want)
			}
			adbCall := readRemoteArgs(t, os.Getenv("ADB_CALL"))
			if len(adbCall) != 4 || adbCall[0] != "-s" || adbCall[1] != "device 1" || adbCall[2] != "shell" {
				t.Fatalf("selected device not used: %v", adbCall)
			}
		})
	}
}

type selectedDevice string

func (d selectedDevice) ResolveActive(context.Context) (string, error) { return string(d), nil }

func TestActivityShellUsesSelectedDevice(t *testing.T) {
	capture := fakeADB(t)
	reg := registry.Load(filepath.Join("..", "..", "actions"), filepath.Join("..", ".."))
	la, ok := reg.Actions["adb-debug-activity"]
	if !ok {
		t.Fatalf("activity action not loaded: %v", reg.Errors)
	}
	params := defaultParams(la.Def)
	builtins := builtinvars.New(selectedDevice("selected-device"))
	r, err := actionrun.Build(context.Background(), la, actionrun.Deps{Builtins: builtins}, actionrun.Options{Params: params})
	if err != nil {
		t.Fatal(err)
	}
	result := r.Run(context.Background(), params, func(string, string) {})
	if result.Err != nil || result.ExitCode != 0 {
		t.Fatalf("activity launch failed: %+v", result)
	}
	adbCall := readRemoteArgs(t, os.Getenv("ADB_CALL"))
	if len(adbCall) != 4 || adbCall[0] != "-s" || adbCall[1] != "selected-device" {
		t.Fatalf("selected device not used: %v (capture: %s)", adbCall, capture)
	}
}

func TestActivityShellRejectsInvalidArgs(t *testing.T) {
	def := loadShellAction(t, "adb-debug-activity")
	for _, input := range []string{``, `oops`, `{}`, `[{"flag":"--es","values":[7]}]`} {
		t.Run(input, func(t *testing.T) {
			capture := fakeADB(t)
			params := defaultParams(def)
			params["ARGS"] = input
			result := (&runner.ShellRunner{Cfg: runner.ShellConfig{Run: def.Command.Run, Timeout: 5 * time.Second}}).Run(context.Background(), params, func(string, string) {})
			if result.ExitCode == 0 {
				t.Fatalf("invalid ARGS accepted: %s", input)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatalf("adb called on invalid ARGS: %v", err)
			}
		})
	}
}

func TestActivityShellWithoutSelectedDeviceUsesDefaultADB(t *testing.T) {
	def := loadShellAction(t, "adb-debug-activity")
	capture := fakeADB(t)
	params := defaultParams(def)
	params["ADB_SERIAL"] = ""
	params["ARGS"] = "[]"
	result := (&runner.ShellRunner{Cfg: runner.ShellConfig{Run: def.Command.Run, Timeout: 5 * time.Second}}).Run(context.Background(), params, func(string, string) {})
	if result.Err != nil || result.ExitCode != 0 {
		t.Fatalf("default device launch failed: %+v", result)
	}
	if got := readRemoteArgs(t, os.Getenv("ADB_CALL")); len(got) != 2 || got[0] != "shell" {
		t.Fatalf("unexpected adb invocation: %v", got)
	}
	if got := readRemoteArgs(t, capture); !reflect.DeepEqual(got, []string{"start", "-n", "com.baidu.che.codriver/com.baidu.che.codriver.ui.DebugActivity"}) {
		t.Fatalf("unexpected remote args: %v", got)
	}
}

func TestActivityShellDoesNotRetryOtherDeviceOnADBFailure(t *testing.T) {
	def := loadShellAction(t, "adb-debug-activity")
	capture := fakeADB(t)
	t.Setenv("ADB_FAIL", "1")
	params := defaultParams(def)
	params["ADB_SERIAL"] = "device 1"
	result := (&runner.ShellRunner{Cfg: runner.ShellConfig{Run: def.Command.Run, Timeout: 5 * time.Second}}).Run(context.Background(), params, func(string, string) {})
	if result.ExitCode != 8 {
		t.Fatalf("adb failure should propagate: %+v", result)
	}
	if got := readRemoteArgs(t, os.Getenv("ADB_CALL")); len(got) != 4 || got[0] != "-s" || got[1] != "device 1" {
		t.Fatalf("adb retried or selected device lost: %v", got)
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatalf("remote am ran despite adb failure: %v", err)
	}
}

func TestActivityShellReportsMissingJQ(t *testing.T) {
	def := loadShellAction(t, "adb-debug-activity")
	capture := fakeADB(t)
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skipf("bash missing: %v", err)
	}
	if err := os.Symlink(bash, filepath.Join(filepath.Dir(capture), "bash")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", filepath.Dir(capture))
	var errors []string
	result := (&runner.ShellRunner{Cfg: runner.ShellConfig{Run: def.Command.Run, Timeout: 5 * time.Second}}).Run(context.Background(), defaultParams(def), func(stream, line string) {
		if stream == "stderr" {
			errors = append(errors, line)
		}
	})
	if result.ExitCode == 0 || !strings.Contains(strings.Join(errors, "\n"), "jq") {
		t.Fatalf("missing jq: result %+v, stderr %v", result, errors)
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatalf("adb called without jq: %v", err)
	}
}

func TestLogcatTagPresetStringsAreJSONArrays(t *testing.T) {
	for _, id := range []string{"adb-logcat", "adb-logcat-stream"} {
		t.Run(id, func(t *testing.T) {
			def := loadShellAction(t, id)
			var list bool
			for _, field := range def.Params {
				if field.ID == "TAG" {
					list = field.Type == "list"
				}
			}
			if !list {
				t.Fatal("TAG must be a list")
			}
			for _, preset := range def.Presets {
				var tags []string
				if err := json.Unmarshal([]byte(preset.Values["TAG"]), &tags); err != nil {
					t.Fatalf("%s: invalid TAG: %v", preset.Name, err)
				}
				if preset.Name == "AI BOX" && len(tags) != 5 {
					t.Fatalf("AI BOX tags lost: %v", tags)
				}
			}
		})
	}
}

func TestDebugWorkflowsKeepExecButtonArgs(t *testing.T) {
	for _, id := range []string{"xdzs-debug-chain", "xdzs-install-broadcast"} {
		t.Run(id, func(t *testing.T) {
			reg := workflow.Load(filepath.Join("..", "..", "workflows"))
			loaded, ok := reg.Workflows[id]
			if !ok {
				t.Fatalf("workflow %s not loaded: %v", id, reg.Errors)
			}
			if _, exists := loaded.Def.Env["EXEC_ID"]; exists {
				t.Fatal("legacy EXEC_ID remains")
			}
			var hasLaunch bool
			for _, step := range loaded.Def.Steps {
				if step.Action == "adb-debug-activity" {
					hasLaunch = true
				}
			}
			if !hasLaunch {
				t.Fatal("missing adb-debug-activity launch")
			}
			var rows []struct {
				Flag   string   `json:"flag"`
				Values []string `json:"values"`
			}
			args := loaded.Def.Env["ARGS"]
			if err := json.Unmarshal([]byte(args), &rows); err != nil || len(rows) != 1 || rows[0].Flag != "--es" || !reflect.DeepEqual(rows[0].Values, []string{"exec_button", "展示语音链路悬框"}) {
				t.Fatalf("ARGS = %q; parse error: %v", args, err)
			}
			capture := fakeADB(t)
			root := filepath.Join("..", "..")
			actions := registry.Load(filepath.Join(root, "actions"), root)
			params := map[string]any{"ADB_SERIAL": "device 1"} // Workflow must supply action defaults itself.
			launch := workflow.LoadedWorkflow{Def: workflow.WorkflowDef{Env: loaded.Def.Env, Steps: []workflow.Step{{Action: "adb-debug-activity"}}}}
			actionRun, shellRun := actionrun.WorkflowCallbacks(actions, actionrun.Deps{}, params)
			result := (&workflow.Executor{}).Execute(context.Background(), launch, actionRun, shellRun, params, func(string, string) {})
			if result.Err != nil || result.ExitCode != 0 {
				t.Fatalf("workflow launch failed: %+v", result)
			}
			want := []string{"start", "-n", "com.baidu.che.codriver/com.baidu.che.codriver.ui.DebugActivity", "--es", "exec_button", "展示语音链路悬框"}
			if got := readRemoteArgs(t, capture); !reflect.DeepEqual(got, want) {
				t.Fatalf("workflow env ARGS did not reach shell: %v", got)
			}
		})
	}
}
