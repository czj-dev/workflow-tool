package registry

import (
	"strings"
	"testing"
)

func TestValidateArrayParamDefaultsAndPresets(t *testing.T) {
	cases := []struct {
		name, kind, value string
		preset            bool
		valid             bool
	}{
		{"list empty default", "list", "", false, true},
		{"arguments empty default", "arguments", "", false, true},
		{"list empty array default", "list", "[]", false, true},
		{"arguments empty array default", "arguments", "[]", false, true},
		{"list strings", "list", `["a", "中😀", "a'b"]`, false, true},
		{"arguments rows", "arguments", `[{"flag":"--es","values":["key","中😀"]}]`, false, true},
		{"list non JSON", "list", "${TAG}", false, false},
		{"arguments non JSON", "arguments", "${ARGS}", false, false},
		{"list object", "list", `{}`, false, false},
		{"list wrong item", "list", `["a", 1]`, false, false},
		{"list null", "list", `null`, false, false},
		{"arguments scalar", "arguments", `["--es"]`, false, false},
		{"arguments missing flag", "arguments", `[{"values":[]}]`, false, false},
		{"arguments null flag", "arguments", `[{"flag":null,"values":[]}]`, false, false},
		{"arguments null values", "arguments", `[{"flag":"x","values":null}]`, false, false},
		{"arguments wrong value", "arguments", `[{"flag":"x","values":[1]}]`, false, false},
		{"list empty preset", "list", "", true, false},
		{"list array preset", "list", "[]", true, true},
		{"arguments array preset", "arguments", `[{"flag":"--es","values":[]}]`, true, true},
		{"list invalid preset", "list", `[false]`, true, false},
		{"arguments dynamic preset", "arguments", "${ARGS}", true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			param := ParamSpec{ID: "MY_PARAM", Type: tc.kind, Default: tc.value}
			def := &ActionDef{ID: "a", Title: "A", Command: Command{Run: "echo"}, Params: []ParamSpec{param}}
			if tc.preset {
				def.Params[0].Default = ""
				def.Presets = []Preset{{Name: "my-preset", Values: map[string]string{"MY_PARAM": tc.value}}}
			}
			err := Validate(def)
			if tc.valid && err != nil {
				t.Fatalf("expected valid array value: %v", err)
			}
			if !tc.valid && (err == nil || !strings.Contains(err.Error(), "MY_PARAM") ||
				(tc.preset && !strings.Contains(err.Error(), "my-preset"))) {
				t.Fatalf("expected error with param id and preset name when applicable, got %v", err)
			}
		})
	}
}

func TestValidateLogcatPresetWithLegacyTagAndAuthoritativeFilter(t *testing.T) {
	def := &ActionDef{ID: "logcat", Title: "Logcat", Command: Command{Adb: AdbCommand{Operation: "logcat-stream"}, Stream: "logcat"},
		Params:  []ParamSpec{{ID: "TAG", Type: "list"}, {ID: "FILTER", Type: "text"}},
		Presets: []Preset{{Name: "legacy", Values: map[string]string{"TAG": "Foo Bar", "FILTER": `{"tokens":[]}`}}}}
	if err := Validate(def); err != nil {
		t.Fatalf("valid FILTER makes legacy TAG irrelevant: %v", err)
	}
}

func TestValidatePresetsIgnoreValuesWithoutMatchingArrayParam(t *testing.T) {
	def := &ActionDef{ID: "a", Title: "A", Command: Command{Run: "echo"},
		Params:  []ParamSpec{{ID: "TEXT", Type: "text"}},
		Presets: []Preset{{Name: "p", Values: map[string]string{"TEXT": "not JSON", "OLD": "not JSON"}}}}
	if err := Validate(def); err != nil {
		t.Fatalf("non-array and unknown preset values remain unrestricted: %v", err)
	}
}
