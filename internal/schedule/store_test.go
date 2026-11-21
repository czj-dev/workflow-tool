package schedule

import (
	"bytes"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func testCatalog() TargetCatalog {
	return TargetCatalog{Actions: map[string]struct{}{"patrol": {}}, Workflows: map[string]struct{}{"daily": {}}}
}

func testDefinition() Definition {
	return Definition{ID: "check", Name: "Check", Cron: "7 * * * *", Action: "patrol"}
}

func writeScheduleFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestLoadFileDefaultsEnabledAndParams(t *testing.T) {
	path := filepath.Join(t.TempDir(), "schedules.yaml")
	writeScheduleFile(t, path, "schedules:\n  - id: check\n    name: Check\n    cron: '7 * * * *'\n    action: patrol\n")
	defs, errs := LoadFile(path, testCatalog())
	if len(errs) != 0 || len(defs) != 1 {
		t.Fatalf("defs=%v errs=%v", defs, errs)
	}
	if !defs[0].Enabled || defs[0].Params == nil || len(defs[0].Params) != 0 {
		t.Fatalf("defaults not applied: %+v", defs[0])
	}
}

func TestLoadFilePreservesExplicitDisabled(t *testing.T) {
	path := filepath.Join(t.TempDir(), "schedules.yaml")
	writeScheduleFile(t, path, "schedules:\n  - id: check\n    name: Check\n    cron: '7 * * * *'\n    action: patrol\n    enabled: false\n")
	defs, errs := LoadFile(path, testCatalog())
	if len(errs) != 0 || len(defs) != 1 || defs[0].Enabled {
		t.Fatalf("defs=%v errs=%v", defs, errs)
	}
}

func TestLoadFileRejectsExplicitNullEnabled(t *testing.T) {
	path := filepath.Join(t.TempDir(), "schedules.yaml")
	writeScheduleFile(t, path, "schedules:\n  - id: check\n    name: Check\n    cron: '* * * * *'\n    action: patrol\n    enabled: null\n")
	defs, errs := LoadFile(path, testCatalog())
	if len(defs) != 0 || len(errs) != 1 || !strings.Contains(errs[0].Error(), "enabled") {
		t.Fatalf("explicit null should not enable schedule: defs=%v errs=%v", defs, errs)
	}
}

func TestLoadFileMissingReturnsEmptyWithoutErrors(t *testing.T) {
	defs, errs := LoadFile(filepath.Join(t.TempDir(), "missing.yaml"), testCatalog())
	if len(defs) != 0 || len(errs) != 0 {
		t.Fatalf("defs=%v errs=%v", defs, errs)
	}
}

func TestLoadFileSkipsInvalidEntriesWithContext(t *testing.T) {
	path := filepath.Join(t.TempDir(), "schedules.yaml")
	writeScheduleFile(t, path, `schedules:
  - id: check
    name: Check
    cron: '7 * * * *'
    action: patrol
  - id: missing
    name: Missing
    cron: '* * * * *'
    action: unknown
  - id: broken
    name: Broken
    cron: '* * * * *'
    action: patrol
    enabled: nope
  - id: check
    name: Duplicate
    cron: '* * * * *'
    action: patrol
`)
	defs, errs := LoadFile(path, testCatalog())
	if len(defs) != 1 || defs[0].ID != "check" || len(errs) != 3 {
		t.Fatalf("defs=%v errs=%v", defs, errs)
	}
	for i, context := range []string{"missing", "broken", "duplicate"} {
		if !strings.Contains(errs[i].Error(), context) {
			t.Fatalf("error %d lacks %q: %v", i, context, errs[i])
		}
	}
}

func TestLoadFileReservesDecodableIDBeforeValidatingEntry(t *testing.T) {
	for _, tc := range []struct{ name, first, want string }{
		{"unknown target", "name: Check\n    action: missing", "unknown action"},
		{"invalid name", "name: '   '\n    action: patrol", "name"},
		{"bad field type", "name: Check\n    action: patrol\n    enabled: nope", "enabled"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "schedules.yaml")
			writeScheduleFile(t, path, "schedules:\n  - id: check\n    cron: '* * * * *'\n    "+tc.first+"\n  - id: check\n    name: Later\n    cron: '* * * * *'\n    action: patrol\n")
			defs, errs := LoadFile(path, testCatalog())
			if len(defs) != 0 || len(errs) != 2 || !strings.Contains(errs[0].Error(), tc.want) || !strings.Contains(errs[1].Error(), "duplicate") {
				t.Fatalf("defs=%v errs=%v; first error should include %q, second duplicate", defs, errs, tc.want)
			}
		})
	}
}

func TestLoadFileReservesAliasedID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "schedules.yaml")
	writeScheduleFile(t, path, "schedules:\n  - id: &schedule-id check\n    name: First\n    cron: '* * * * *'\n    action: patrol\n  - id: *schedule-id\n    name: Second\n    cron: '* * * * *'\n    action: patrol\n")
	defs, errs := LoadFile(path, testCatalog())
	if len(defs) != 1 || defs[0].Name != "First" || len(errs) != 1 || !strings.Contains(errs[0].Error(), "duplicate") {
		t.Fatalf("defs=%v errs=%v", defs, errs)
	}
}

func TestLoadFileRejectsInvalidRoot(t *testing.T) {
	for _, tc := range []struct{ name, body, want string }{
		{"syntax", "schedules: [", "yaml"},
		{"not mapping", "- id: check\n", "mapping"},
		{"missing schedules", "{}\n", "schedules"},
		{"unknown field", "scheduls: []\n", "scheduls"},
		{"wrong schedules type", "schedules: {}\n", "schedules"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "schedules.yaml")
			writeScheduleFile(t, path, tc.body)
			defs, errs := LoadFile(path, testCatalog())
			if len(defs) != 0 || len(errs) != 1 || !strings.Contains(errs[0].Error(), tc.want) {
				t.Fatalf("defs=%v errs=%v; want %q", defs, errs, tc.want)
			}
		})
	}
}

func TestValidateRejectsInvalidDefinitions(t *testing.T) {
	valid := testDefinition()
	for _, tc := range []struct {
		name string
		defs []Definition
		want string
	}{
		{"invalid id", []Definition{{ID: "Bad ID", Name: valid.Name, Cron: valid.Cron, Action: valid.Action}}, "id"},
		{"empty name", []Definition{{ID: valid.ID, Name: "  ", Cron: valid.Cron, Action: valid.Action}}, "name"},
		{"invalid cron", []Definition{{ID: valid.ID, Name: valid.Name, Cron: "nope", Action: valid.Action}}, "cron"},
		{"no target", []Definition{{ID: valid.ID, Name: valid.Name, Cron: valid.Cron}}, "exactly one target"},
		{"both targets", []Definition{{ID: valid.ID, Name: valid.Name, Cron: valid.Cron, Action: valid.Action, Workflow: "daily"}}, "exactly one target"},
		{"unknown action", []Definition{{ID: valid.ID, Name: valid.Name, Cron: valid.Cron, Action: "missing"}}, "unknown action"},
		{"unknown workflow", []Definition{{ID: valid.ID, Name: valid.Name, Cron: valid.Cron, Workflow: "missing"}}, "unknown workflow"},
		{"duplicate id", []Definition{valid, valid}, "duplicate"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ValidateDefinitions(tc.defs, testCatalog())
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err=%v, want %q", err, tc.want)
			}
		})
	}
}

func TestValidateDefinitionsNormalizesWithoutMutating(t *testing.T) {
	input := []Definition{testDefinition()}
	got, err := ValidateDefinitions(input, testCatalog())
	if err != nil || len(got) != 1 || got[0].Params == nil || input[0].Params != nil {
		t.Fatalf("got=%v input=%v err=%v", got, input, err)
	}
}

func TestValidateDefinitionsCopiesNestedParams(t *testing.T) {
	input := []Definition{testDefinition()}
	input[0].Params = map[string]any{"nested": map[string]any{"values": []any{"first"}}}
	got, err := ValidateDefinitions(input, testCatalog())
	if err != nil {
		t.Fatal(err)
	}
	input[0].Params["nested"].(map[string]any)["values"].([]any)[0] = "changed"
	values := got[0].Params["nested"].(map[string]any)["values"].([]any)
	if values[0] != "first" {
		t.Fatalf("normalized params share nested values: %v", got[0].Params)
	}
}

func TestValidateDefinitionsCopiesTypedMutableParams(t *testing.T) {
	input := []Definition{testDefinition()}
	input[0].Params = map[string]any{
		"strings": []string{"first"},
		"map":     map[string]string{"value": "first"},
		"nested":  [][]string{{"first"}},
	}
	got, err := ValidateDefinitions(input, testCatalog())
	if err != nil {
		t.Fatal(err)
	}
	input[0].Params["strings"].([]string)[0] = "changed"
	input[0].Params["map"].(map[string]string)["value"] = "changed"
	input[0].Params["nested"].([][]string)[0][0] = "changed"
	if got[0].Params["strings"].([]string)[0] != "first" ||
		got[0].Params["map"].(map[string]string)["value"] != "first" ||
		got[0].Params["nested"].([][]string)[0][0] != "first" {
		t.Fatalf("normalized params share typed mutable values: %v", got[0].Params)
	}
}

func TestValidateDefinitionsRejectsUnsupportedStructParam(t *testing.T) {
	input := []Definition{testDefinition()}
	input[0].Params = map[string]any{"config": struct{ Values []string }{Values: []string{"first"}}}
	_, err := ValidateDefinitions(input, testCatalog())
	if err == nil || !strings.Contains(err.Error(), "params") {
		t.Fatalf("expected unsupported params error, got %v", err)
	}
}

func TestValidateDefinitionsRejectsCyclicParams(t *testing.T) {
	cyclic := map[string]any{}
	cyclic["self"] = cyclic
	input := []Definition{testDefinition()}
	input[0].Params = cyclic
	_, err := ValidateDefinitions(input, testCatalog())
	if err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("expected cyclic params error, got %v", err)
	}
}

func TestValidateDefinitionsAllowsFiniteOverlappingSlices(t *testing.T) {
	values := make([]any, 2)
	values[0] = "first"
	values[1] = values[:1]
	input := []Definition{testDefinition()}
	input[0].Params = map[string]any{"values": values}
	got, err := ValidateDefinitions(input, testCatalog())
	if err != nil {
		t.Fatalf("finite overlapping slices are valid: %v", err)
	}
	cloned := got[0].Params["values"].([]any)
	if cloned[1].([]any)[0] != "first" {
		t.Fatalf("unexpected cloned values: %v", cloned)
	}
}

func TestSaveFileRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "schedules.yaml")
	want := []Definition{{ID: "check", Name: "Check", Enabled: true, Cron: "7 * * * *", Action: "patrol", Params: map[string]any{"device": "active"}}, {ID: "review", Name: "Review", Enabled: false, Cron: "* * * * *", Workflow: "daily", Params: map[string]any{}}}
	if err := SaveFile(path, want); err != nil {
		t.Fatal(err)
	}
	got, errs := LoadFile(path, testCatalog())
	if len(errs) != 0 || !reflect.DeepEqual(got, want) {
		t.Fatalf("got=%v errs=%v want=%v", got, errs, want)
	}
}

func TestSaveFileRejectsDuplicateIDWithoutReplacingTarget(t *testing.T) {
	path := filepath.Join(t.TempDir(), "schedules.yaml")
	original := "schedules: []\n"
	writeScheduleFile(t, path, original)
	if err := SaveFile(path, []Definition{testDefinition(), testDefinition()}); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("want duplicate error, got %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != original {
		t.Fatalf("target modified: data=%q err=%v", data, err)
	}
}

func TestSaveFileCleansTemporaryFileAfterRenameFailure(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "schedules.yaml")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := SaveFile(path, []Definition{testDefinition()}); err == nil {
		t.Fatal("expected rename error")
	}
	matches, err := filepath.Glob(filepath.Join(dir, ".schedules-*.tmp"))
	if err != nil || len(matches) != 0 {
		t.Fatalf("temporary files remain: %v, err=%v", matches, err)
	}
}

func TestLoadFileRejectsNonFiniteParams(t *testing.T) {
	path := filepath.Join(t.TempDir(), "schedules.yaml")
	writeScheduleFile(t, path, "schedules:\n  - id: check\n    name: Check\n    cron: '* * * * *'\n    action: patrol\n    params: {nested: [.nan, .inf]}\n")
	defs, errs := LoadFile(path, testCatalog())
	if len(defs) != 0 || len(errs) != 1 || !strings.Contains(errs[0].Error(), "params") {
		t.Fatalf("nonfinite YAML must be rejected: defs=%v errs=%v", defs, errs)
	}
}

func TestSaveFileRejectsNonFiniteParamsWithoutReplacingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "schedules.yaml")
	writeScheduleFile(t, path, "schedules: []\n")
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		def := testDefinition()
		def.Params = map[string]any{"nested": []any{value}}
		if err := SaveFile(path, []Definition{def}); err == nil || !strings.Contains(err.Error(), "params") {
			t.Fatalf("SaveFile accepted nonfinite param: %v", err)
		}
		data, err := os.ReadFile(path)
		if err != nil || string(data) != "schedules: []\n" {
			t.Fatalf("failed save replaced file: %q %v", data, err)
		}
	}
}

func TestSaveFileDoesNotReplaceExistingFileOnTempCreationFailure(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "schedules.yaml")
	original := []byte("schedules: []\n")
	writeScheduleFile(t, path, string(original))
	if err := SaveFile(filepath.Join(dir, "missing", "schedules.yaml"), []Definition{}); err == nil {
		t.Fatal("expected write error")
	}
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, original) {
		t.Fatalf("existing file changed: %q err=%v", got, err)
	}
}
