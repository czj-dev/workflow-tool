// internal/workflow/loader.go
package workflow

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// FileError 记录单个文件的加载错误。
type FileError struct {
	File  string
	Error string
}

// WorkflowRegistry 是所有已加载 workflow 的集合。
type WorkflowRegistry struct {
	Workflows map[string]LoadedWorkflow
	Errors    []FileError
}

// ParseWorkflow 解析 YAML 字节为 WorkflowDef（供 SetWorkflowYaml 校验用）。
func ParseWorkflow(data []byte) (*WorkflowDef, error) {
	var def WorkflowDef
	if err := yaml.Unmarshal(data, &def); err != nil {
		return nil, err
	}
	return &def, nil
}

// Load 扫描 dir 下所有 *.yaml，返回 WorkflowRegistry。
func Load(dir string) *WorkflowRegistry {
	reg := &WorkflowRegistry{Workflows: map[string]LoadedWorkflow{}}
	files, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil {
		reg.Errors = append(reg.Errors, FileError{File: dir, Error: err.Error()})
		return reg
	}
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			reg.Errors = append(reg.Errors, FileError{File: filepath.Base(f), Error: err.Error()})
			continue
		}
		var def WorkflowDef
		if err := yaml.Unmarshal(data, &def); err != nil {
			reg.Errors = append(reg.Errors, FileError{File: filepath.Base(f), Error: err.Error()})
			continue
		}
		if err := Validate(&def); err != nil {
			reg.Errors = append(reg.Errors, FileError{File: filepath.Base(f), Error: err.Error()})
			continue
		}
		if _, exists := reg.Workflows[def.ID]; exists {
			reg.Errors = append(reg.Errors, FileError{File: filepath.Base(f), Error: fmt.Sprintf("重复 id %q", def.ID)})
			continue
		}
		reg.Workflows[def.ID] = LoadedWorkflow{Def: def, File: f}
	}
	return reg
}
