package schedule

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

var scheduleIDPattern = regexp.MustCompile(`^[a-z0-9-]+$`)

type File struct {
	Schedules []Definition `yaml:"schedules"`
}

// TargetCatalog 是当前已加载的目标集合，用于校验调度指向的目标存在。
// 三张表各自独立：同一 id 可以同时是动作、工作流与 AI 任务，按目标键各查各的表。
type TargetCatalog struct {
	Actions   map[string]struct{}
	Workflows map[string]struct{}
	AITasks   map[string]struct{}
}

// ValidateDefinitions validates a complete configuration, rejecting duplicate IDs.
func ValidateDefinitions(defs []Definition, catalog TargetCatalog) ([]Definition, error) {
	validated := make([]Definition, 0, len(defs))
	seen := make(map[string]struct{}, len(defs))
	for i, def := range defs {
		normalized, err := validateDefinition(def, &catalog)
		if err != nil {
			return nil, fmt.Errorf("schedule entry %d: %w", i+1, err)
		}
		if _, exists := seen[def.ID]; exists {
			return nil, fmt.Errorf("schedule entry %d: duplicate schedule id %q", i+1, def.ID)
		}
		seen[def.ID] = struct{}{}
		validated = append(validated, normalized)
	}
	return validated, nil
}

func validateDefinition(def Definition, catalog *TargetCatalog) (Definition, error) {
	if !scheduleIDPattern.MatchString(def.ID) {
		return Definition{}, fmt.Errorf("schedule id %q: expected lowercase letters, digits or hyphens", def.ID)
	}
	if strings.TrimSpace(def.Name) == "" {
		return Definition{}, fmt.Errorf("schedule %q: name must not be empty", def.ID)
	}
	if _, err := Parse(def.Cron); err != nil {
		return Definition{}, fmt.Errorf("schedule %q: cron: %w", def.ID, err)
	}
	kind, target, err := def.Target()
	if err != nil {
		return Definition{}, fmt.Errorf("schedule %q: exactly one target required: %w", def.ID, err)
	}
	if catalog != nil {
		var known bool
		switch kind {
		case TargetAction:
			_, known = catalog.Actions[target]
		case TargetWorkflow:
			_, known = catalog.Workflows[target]
		case TargetAI:
			_, known = catalog.AITasks[target]
		}
		if !known {
			return Definition{}, fmt.Errorf("schedule %q: unknown %s %q", def.ID, kind, target)
		}
	}
	params, err := cloneParams(def.Params)
	if err != nil {
		return Definition{}, fmt.Errorf("schedule %q: params: %w", def.ID, err)
	}
	if _, err := json.Marshal(params); err != nil {
		return Definition{}, fmt.Errorf("schedule %q: params are not JSON encodable: %w", def.ID, err)
	}
	return Definition{ID: def.ID, Name: strings.TrimSpace(def.Name), Enabled: def.Enabled, Cron: def.Cron,
		Action: def.Action, Workflow: def.Workflow, AI: def.AI, Params: params, CatchUp: def.CatchUp}, nil
}

func cloneParams(params map[string]any) (map[string]any, error) {
	copy := make(map[string]any, len(params))
	for key, value := range params {
		if value == nil {
			copy[key] = nil
			continue
		}
		cloned, err := cloneParam(reflect.ValueOf(value), make(map[paramVisit]bool))
		if err != nil {
			return nil, fmt.Errorf("key %q: %w", key, err)
		}
		copy[key] = cloned.Interface()
	}
	return copy, nil
}

type paramVisit struct {
	typeOf  reflect.Type
	address uintptr
	length  int
}

func cloneParam(value reflect.Value, active map[paramVisit]bool) (reflect.Value, error) {
	kind := value.Kind()
	if (kind == reflect.Map || kind == reflect.Slice || kind == reflect.Pointer) && !value.IsNil() {
		visit := paramVisit{typeOf: value.Type(), address: value.Pointer()}
		if kind == reflect.Slice {
			visit.length = value.Len()
		}
		if active[visit] {
			return reflect.Value{}, fmt.Errorf("cycle in params")
		}
		active[visit] = true
		defer delete(active, visit)
	}
	switch kind {
	case reflect.Interface, reflect.Pointer:
		if value.IsNil() {
			return value, nil
		}
		child, err := cloneParam(value.Elem(), active)
		if err != nil {
			return reflect.Value{}, err
		}
		copy := reflect.New(value.Type()).Elem()
		if kind == reflect.Pointer {
			copy = reflect.New(value.Type().Elem())
			copy.Elem().Set(child)
		} else {
			copy.Set(child)
		}
		return copy, nil
	case reflect.Map, reflect.Slice, reflect.Array:
		return cloneParamCollection(value, active)
	case reflect.Struct:
		if value.Type() == reflect.TypeFor[time.Time]() {
			return value, nil
		}
		return reflect.Value{}, fmt.Errorf("unsupported params type %s", value.Type())
	case reflect.String, reflect.Bool, reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Float32, reflect.Float64:
		return value, nil
	default:
		return reflect.Value{}, fmt.Errorf("unsupported params type %s", value.Type())
	}
}

func cloneParamCollection(value reflect.Value, active map[paramVisit]bool) (reflect.Value, error) {
	if value.Kind() == reflect.Map {
		if value.IsNil() {
			return value, nil
		}
		copy := reflect.MakeMapWithSize(value.Type(), value.Len())
		iter := value.MapRange()
		for iter.Next() {
			child, err := cloneParam(iter.Value(), active)
			if err != nil {
				return reflect.Value{}, err
			}
			copy.SetMapIndex(iter.Key(), child)
		}
		return copy, nil
	}
	if value.Kind() == reflect.Slice && value.IsNil() {
		return value, nil
	}
	copy := reflect.New(value.Type()).Elem()
	if value.Kind() == reflect.Slice {
		copy = reflect.MakeSlice(value.Type(), value.Len(), value.Len())
	}
	for i := 0; i < value.Len(); i++ {
		child, err := cloneParam(value.Index(i), active)
		if err != nil {
			return reflect.Value{}, err
		}
		copy.Index(i).Set(child)
	}
	return copy, nil
}

type yamlDefinition struct {
	ID       string         `yaml:"id"`
	Name     string         `yaml:"name"`
	Enabled  *bool          `yaml:"enabled"`
	Cron     string         `yaml:"cron"`
	Action   string         `yaml:"action"`
	Workflow string         `yaml:"workflow"`
	AI       string         `yaml:"ai"`
	Params   map[string]any `yaml:"params"`
	CatchUp  bool           `yaml:"catch_up"`
}

// LoadFile returns valid entries and diagnostics for any entries it skips.
func LoadFile(path string, catalog TargetCatalog) ([]Definition, []error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return []Definition{}, nil
	}
	if err != nil {
		return nil, []error{fmt.Errorf("read schedules %q: %w", path, err)}
	}
	entries, err := parseScheduleEntries(data)
	if err != nil {
		return nil, []error{fmt.Errorf("parse schedules %q: %w", path, err)}
	}
	defs := make([]Definition, 0, len(entries))
	var diagnostics []error
	seen := make(map[string]struct{}, len(entries))
	for i, entry := range entries {
		id := entryID(entry)
		if scheduleIDPattern.MatchString(id) {
			if _, duplicate := seen[id]; duplicate {
				diagnostics = append(diagnostics, fmt.Errorf("schedules %q entry %d (id %q): duplicate schedule id %q", path, i+1, id, id))
				continue
			}
			seen[id] = struct{}{}
		}
		def, err := decodeScheduleEntry(entry)
		if err == nil {
			def, err = validateDefinition(def, &catalog)
		}
		if err != nil {
			diagnostics = append(diagnostics, fmt.Errorf("schedules %q entry %d (id %q): %w", path, i+1, id, err))
			continue
		}
		defs = append(defs, def)
	}
	return defs, diagnostics
}

func parseScheduleEntries(data []byte) ([]*yaml.Node, error) {
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	var document yaml.Node
	if err := decoder.Decode(&document); err != nil {
		return nil, fmt.Errorf("yaml document: %w", err)
	}
	var extra yaml.Node
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("yaml document: multiple documents are not supported")
		}
		return nil, fmt.Errorf("yaml document: %w", err)
	}
	if len(document.Content) == 0 || document.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("root must be a mapping")
	}
	root := document.Content[0]
	var entries []*yaml.Node
	seen := false
	for i := 0; i < len(root.Content); i += 2 {
		key, value := root.Content[i], root.Content[i+1]
		if key.Value != "schedules" {
			return nil, fmt.Errorf("unknown root field %q", key.Value)
		}
		if seen {
			return nil, fmt.Errorf("duplicate root field %q", key.Value)
		}
		seen = true
		if value.Kind != yaml.SequenceNode {
			return nil, fmt.Errorf("schedules must be a sequence")
		}
		entries = value.Content
	}
	if !seen {
		return nil, fmt.Errorf("missing root field %q", "schedules")
	}
	return entries, nil
}

func decodeScheduleEntry(entry *yaml.Node) (Definition, error) {
	if entry.Kind != yaml.MappingNode {
		return Definition{}, fmt.Errorf("entry must be a mapping")
	}
	var raw yamlDefinition
	seen := make(map[string]struct{}, len(entry.Content)/2)
	for i := 0; i < len(entry.Content); i += 2 {
		key, value := entry.Content[i].Value, entry.Content[i+1]
		if _, duplicate := seen[key]; duplicate {
			return Definition{}, fmt.Errorf("duplicate field %q", key)
		}
		seen[key] = struct{}{}
		var target any
		switch key {
		case "id":
			target = &raw.ID
		case "name":
			target = &raw.Name
		case "enabled":
			target = &raw.Enabled
		case "cron":
			target = &raw.Cron
		case "action":
			target = &raw.Action
		case "workflow":
			target = &raw.Workflow
		case "ai":
			target = &raw.AI
		case "params":
			target = &raw.Params
		case "catch_up":
			target = &raw.CatchUp
		default:
			return Definition{}, fmt.Errorf("unknown field %q", key)
		}
		if err := value.Decode(target); err != nil {
			return Definition{}, fmt.Errorf("field %q: %w", key, err)
		}
	}
	enabled := true
	if _, present := seen["enabled"]; present {
		if raw.Enabled == nil {
			return Definition{}, fmt.Errorf("field %q: null is not allowed", "enabled")
		}
		enabled = *raw.Enabled
	}
	return Definition{ID: raw.ID, Name: raw.Name, Enabled: enabled, Cron: raw.Cron,
		Action: raw.Action, Workflow: raw.Workflow, AI: raw.AI, Params: raw.Params, CatchUp: raw.CatchUp}, nil
}

func entryID(entry *yaml.Node) string {
	if entry.Kind == yaml.MappingNode {
		for i := 0; i < len(entry.Content); i += 2 {
			if entry.Content[i].Value == "id" {
				var id string
				if err := entry.Content[i+1].Decode(&id); err == nil {
					return id
				}
				return ""
			}
		}
	}
	return ""
}

// SaveFile validates and atomically replaces the file with a complete configuration.
func SaveFile(path string, defs []Definition) (resultErr error) {
	validated := make([]Definition, 0, len(defs))
	seen := make(map[string]struct{}, len(defs))
	for i, def := range defs {
		normalized, err := validateDefinition(def, nil)
		if err != nil {
			return fmt.Errorf("save schedules %q entry %d: %w", path, i+1, err)
		}
		if _, exists := seen[def.ID]; exists {
			return fmt.Errorf("save schedules %q entry %d: duplicate schedule id %q", path, i+1, def.ID)
		}
		seen[def.ID] = struct{}{}
		validated = append(validated, normalized)
	}
	data, err := yaml.Marshal(File{Schedules: validated})
	if err != nil {
		return fmt.Errorf("encode schedules %q: %w", path, err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".schedules-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary schedules file for %q: %w", path, err)
	}
	defer func() {
		if err := os.Remove(tmp.Name()); err != nil && !errors.Is(err, os.ErrNotExist) {
			resultErr = errors.Join(resultErr, fmt.Errorf("remove temporary schedules file %q: %w", tmp.Name(), err))
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		return errors.Join(fmt.Errorf("write temporary schedules file %q: %w", tmp.Name(), err), tmp.Close())
	}
	if err := tmp.Sync(); err != nil {
		return errors.Join(fmt.Errorf("sync temporary schedules file %q: %w", tmp.Name(), err), tmp.Close())
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temporary schedules file %q: %w", tmp.Name(), err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("replace schedules file %q: %w", path, err)
	}
	return nil
}
