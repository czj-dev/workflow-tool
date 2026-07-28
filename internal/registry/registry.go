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
	ID          string  `yaml:"id"`
	Title       string  `yaml:"title"`
	Icon        string  `yaml:"icon"`
	Description string  `yaml:"description"`
	Command     Command `yaml:"command"`
}

// Command 是动作的执行块。
type Command struct {
	Shell   string            `yaml:"shell"`
	Script  string            `yaml:"script"`
	Cwd     string            `yaml:"cwd"`
	Timeout string            `yaml:"timeout"`
	Env     map[string]string `yaml:"env"`
}

// LoadedAction 是已校验、字段已解析的动作。
type LoadedAction struct {
	Def     ActionDef
	Timeout time.Duration
	Cwd     string // 已做 ${VAR} 替换
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
		if err := validate(def); err != nil {
			reg.Errors = append(reg.Errors, FileError{File: filepath.Base(f), Error: err.Error()})
			continue
		}
		if _, exists := reg.Actions[def.ID]; exists {
			reg.Errors = append(reg.Errors, FileError{File: filepath.Base(f), Error: fmt.Sprintf("重复 id %q", def.ID)})
			continue
		}
		// 变量替换：shell/script/cwd
		def.Command.Shell = expandVars(def.Command.Shell)
		def.Command.Script = expandVars(def.Command.Script)
		cwd := expandVars(def.Command.Cwd)
		reg.Actions[def.ID] = LoadedAction{
			Def:     *def,
			Timeout: parseTimeout(def.Command.Timeout),
			Cwd:     cwd,
		}
	}
	return reg
}

func parseFile(path string) (*ActionDef, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var def ActionDef
	if err := yaml.Unmarshal(data, &def); err != nil {
		return nil, err
	}
	return &def, nil
}

func validate(def *ActionDef) error {
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

// expandVars 从环境变量替换 ${VAR}，未定义的保留原样。
func expandVars(s string) string {
	return os.Expand(s, func(name string) string {
		if v, ok := os.LookupEnv(name); ok {
			return v
		}
		return "${" + name + "}"
	})
}
