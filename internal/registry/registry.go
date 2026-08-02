package registry

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"gopkg.in/yaml.v3"
)

// ActionDef 是动作的 YAML 定义。
type ActionDef struct {
	ID          string      `yaml:"id"`
	Title       string      `yaml:"title"`
	Icon        string      `yaml:"icon"`
	Description string      `yaml:"description"`
	Command     Command     `yaml:"command"`
	Params      []ParamSpec `yaml:"params"`
	Presets     []Preset    `yaml:"presets"`
}

// ParamSpec 描述一个运行时参数（前端据此渲染表单）。
type ParamSpec struct {
	ID       string   `json:"id" yaml:"id"`
	Label    string   `json:"label" yaml:"label"`
	Type     string   `json:"type" yaml:"type"` // text|bool|select|path
	Required bool     `json:"required" yaml:"required"`
	Default  string   `json:"default" yaml:"default"`
	Options  []string `json:"options" yaml:"options"`
}

// Preset 是作者定义的一整套参数值。
type Preset struct {
	Name   string            `json:"name" yaml:"name"`
	Values map[string]string `json:"values" yaml:"values"`
}

// Command 是动作的执行块。
type Command struct {
	Shell   string            `yaml:"shell"`
	Script  string            `yaml:"script"`
	Cwd     string            `yaml:"cwd"`
	Timeout string            `yaml:"timeout"`
	Env     map[string]string `yaml:"env"`
	Stream  string            `yaml:"stream"` // "" 普通逐行；"llm" 按 stream-json 解析
}

// LoadedAction 是已校验、字段已解析的动作。
type LoadedAction struct {
	Def     ActionDef
	Timeout time.Duration
	Cwd     string // raw，运行时由 runner 用 params 替换
	File    string // 源文件绝对路径（编辑器读写锚点）
}

// FileError 记录单个文件的加载错误。
type FileError struct {
	File  string
	Error string
}

// Registry 是所有已加载动作的集合。
type Registry struct {
	Actions map[string]LoadedAction
	Errors  []FileError
}

var idPattern = regexp.MustCompile(`^[a-z0-9-]+$`)

// Load 扫描 dir 下所有 *.yaml，返回 Registry。
// baseDir 用于运行时解析相对 script 路径（Registry 仅透传，不做路径解析）。
func Load(dir, baseDir string) *Registry {
	reg := &Registry{Actions: map[string]LoadedAction{}}
	files, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil {
		reg.Errors = append(reg.Errors, FileError{File: dir, Error: err.Error()})
		return reg
	}
	for _, f := range files {
		def, err := parseFile(f)
		if err != nil {
			reg.Errors = append(reg.Errors, FileError{File: filepath.Base(f), Error: err.Error()})
			continue
		}
		if err := Validate(def); err != nil {
			reg.Errors = append(reg.Errors, FileError{File: filepath.Base(f), Error: err.Error()})
			continue
		}
		if _, exists := reg.Actions[def.ID]; exists {
			reg.Errors = append(reg.Errors, FileError{File: filepath.Base(f), Error: fmt.Sprintf("重复 id %q", def.ID)})
			continue
		}
		// Phase 3：不在 Load 时替换 ${VAR}，保留 raw，运行时由 runner 用 params 替换
		reg.Actions[def.ID] = LoadedAction{
			Def:     *def,
			Timeout: parseTimeout(def.Command.Timeout),
			Cwd:     def.Command.Cwd, // raw，未替换
			File:    f,               // 源文件路径，供编辑器定位
		}
	}
	return reg
}

func parseFile(path string) (*ActionDef, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ParseAction(data)
}

// ParseAction 解析 yaml 字节为 ActionDef（供 api 层编辑后校验复用）。
func ParseAction(data []byte) (*ActionDef, error) {
	var def ActionDef
	if err := yaml.Unmarshal(data, &def); err != nil {
		return nil, err
	}
	return &def, nil
}

func Validate(def *ActionDef) error {
	if !idPattern.MatchString(def.ID) {
		return fmt.Errorf("id 必须匹配 ^[a-z0-9-]+$，got %q", def.ID)
	}
	if def.Title == "" {
		return fmt.Errorf("title 必填")
	}
	if def.Command.Shell == "" && def.Command.Script == "" {
		return fmt.Errorf("command.shell 或 command.script 必填其一")
	}
	if def.Command.Shell != "" && def.Command.Script != "" {
		return fmt.Errorf("command.shell 与 command.script 互斥")
	}
	// params 校验
	for i, p := range def.Params {
		switch p.Type {
		case "text", "bool", "select", "path":
			// 合法
		default:
			return fmt.Errorf("params[%d].type 非法 %q（应为 text/bool/select/path）", i, p.Type)
		}
		if p.Type == "select" && len(p.Options) == 0 {
			return fmt.Errorf("params[%d] (%s) 是 select 必须提供 options", i, p.ID)
		}
	}
	switch def.Command.Stream {
	case "", "llm":
		// 合法
	default:
		return fmt.Errorf("command.stream 非法 %q（应为空或 llm）", def.Command.Stream)
	}
	return nil
}

func parseTimeout(s string) time.Duration {
	if s == "" {
		return 60 * time.Second
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 60 * time.Second
	}
	return d
}

// expandVars 已移除：Phase 3 起变量替换移到运行时（runner.Expand，用 params）。
