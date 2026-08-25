package registry

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"workflow-tool/internal/runner"
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
	ID          string   `json:"id" yaml:"id"`
	Label       string   `json:"label" yaml:"label"`
	Type        string   `json:"type" yaml:"type"` // text|bool|select|path|file
	Required    bool     `json:"required" yaml:"required"`
	Default     string   `json:"default" yaml:"default"`
	Options     []string `json:"options" yaml:"options"`
	Description string   `json:"description,omitempty" yaml:"description,omitempty"` // 字段下方的说明文案（可选）
}

// Preset 是作者定义的一整套参数值。
type Preset struct {
	Name        string            `json:"name" yaml:"name"`
	Description string            `json:"description" yaml:"description,omitempty"`
	Values      map[string]string `json:"values" yaml:"values"`
}

// Command 是动作的执行块。
type Command struct {
	Run    string `yaml:"run"`    // 形态 A：内联命令（GHA run，落临时脚本执行）
	Script string `yaml:"script"` // 形态 B：脚本文件路径（带扩展名，按扩展名路由解释器）
	// Shell 是 run/script 形态的可选修饰字段：解释器逻辑名（默认 bash），
	// 或含 {0} 的自定义模板。只允许搭配 run/script。
	Shell   string            `yaml:"shell"`
	Cwd     string            `yaml:"cwd"`
	Timeout string            `yaml:"timeout"`
	Env     map[string]string `yaml:"env"`
	Stream  string            `yaml:"stream"` // "" 普通逐行；"logcat" 前端走结构化日志视图
	// nil/true=默认捕获；false=关闭（scrcpy/logcat 等长跑用）
	CaptureOutput *bool `yaml:"capture_output"`
	// Adb 是第三种执行形态：调用内置 ADBRunner 按 operation 分发到 adb 域服务。
	// 与 run/script/llm 四选一互斥。
	Adb AdbCommand `yaml:"adb"`
	// LLM 是第四种执行形态：调用内置 LLMRunner，按 System/Prompt 指向的 param 拼装 CLI 调用。
	// 与 run/script/adb 四选一互斥。
	LLM LLMCommand `yaml:"llm"`
}

// AdbCommand 描述一个 adb 域操作调用。
type AdbCommand struct {
	// Operation 是 adb 域操作名（如 install-package/logcat-stream/push/scrcpy-start）。
	// 空表示该动作不是 adb 形态。
	Operation string `yaml:"operation"`
}

// LLMCommand 描述一次 LLM 调用：作者只声明「哪个 param 是 system、哪个是 prompt」，
// CLI 名（config.yaml LLM_CLI，默认 ducc）、固定 flag 拼装、stream-json 解析全在 LLMRunner 内部。
type LLMCommand struct {
	// System 可选，param id，值通过 --append-system-prompt 作为独立 argv 传给 CLI
	// （不经 shell 字符串，多行/引号/$ 都零风险）。空表示不追加系统提示。
	System string `yaml:"system"`
	// Prompt 必填，param id，值写入子进程 stdin。空表示该动作不是 llm 形态。
	Prompt string `yaml:"prompt"`
	// Resume 可选，param id，值非空时通过 --resume <值> 续接指定 session id 的历史会话。
	Resume string `yaml:"resume"`
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
	// command 四选一互斥：run / script / adb.operation / llm.prompt
	commandForms := 0
	if def.Command.Run != "" {
		commandForms++
	}
	if def.Command.Script != "" {
		commandForms++
	}
	if def.Command.Adb.Operation != "" {
		commandForms++
	}
	if def.Command.LLM.Prompt != "" {
		commandForms++
	}
	if commandForms == 0 {
		return fmt.Errorf("command 必须指定 run/script/adb/llm 之一")
	}
	if commandForms > 1 {
		return fmt.Errorf("command.run/script/adb/llm 四选一互斥")
	}
	// shell 是 run/script 形态的修饰字段
	if def.Command.Shell != "" {
		if def.Command.Adb.Operation != "" || def.Command.LLM.Prompt != "" {
			return fmt.Errorf("command.shell 只能搭配 run/script 形态")
		}
		if _, err := runner.LookupShellSpec(def.Command.Shell); err != nil {
			return err
		}
	}
	// script 必须带受支持的扩展名（.sh/.ps1/.py/.js）；显式写了 shell 时由它决定
	// 解释器，扩展名推断让位——与 runner.buildCommandFromCfg 同语义，校验不得更严。
	if def.Command.Script != "" && def.Command.Shell == "" {
		if _, err := runner.ShellNameByScript(def.Command.Script); err != nil {
			return err
		}
	}
	// params 校验
	for i, p := range def.Params {
		switch p.Type {
		case "text", "bool", "select", "path", "file", "textarea":
			// 合法
		default:
			return fmt.Errorf("params[%d].type 非法 %q（应为 text/bool/select/path/file/textarea）", i, p.Type)
		}
		if p.Type == "select" && len(p.Options) == 0 {
			return fmt.Errorf("params[%d] (%s) 是 select 必须提供 options", i, p.ID)
		}
	}
	// command.llm 校验：prompt/system/resume 引用的 param 必须存在
	if def.Command.LLM.Prompt != "" {
		if !hasParam(def.Params, def.Command.LLM.Prompt) {
			return fmt.Errorf("command.llm.prompt 引用的 param %q 不存在于 params 中", def.Command.LLM.Prompt)
		}
		if def.Command.LLM.System != "" && !hasParam(def.Params, def.Command.LLM.System) {
			return fmt.Errorf("command.llm.system 引用的 param %q 不存在于 params 中", def.Command.LLM.System)
		}
		if def.Command.LLM.Resume != "" && !hasParam(def.Params, def.Command.LLM.Resume) {
			return fmt.Errorf("command.llm.resume 引用的 param %q 不存在于 params 中", def.Command.LLM.Resume)
		}
	}
	switch def.Command.Stream {
	case "", "logcat":
		// 合法
	default:
		return fmt.Errorf("command.stream 非法 %q（应为空 / logcat）", def.Command.Stream)
	}
	return nil
}

// hasParam 判断 params 中是否存在指定 id 的参数。
func hasParam(params []ParamSpec, id string) bool {
	for _, p := range params {
		if p.ID == id {
			return true
		}
	}
	return false
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

// AddPresetToYAML 在 yaml 原文中新增/覆盖一个 preset，保留其余节点注释与格式。
// 同名 preset 删除后追加（值被覆盖，位置移到 presets 列表末尾）；否则追加。
// name trim 后为空返回错误。values 序列化为 flow 风格 { K: V }。
func AddPresetToYAML(raw []byte, name, description string, values map[string]string) ([]byte, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, fmt.Errorf("preset name 不能为空")
	}

	var root yaml.Node
	if err := yaml.Unmarshal(raw, &root); err != nil {
		return nil, fmt.Errorf("yaml 解析失败: %w", err)
	}
	// yaml.v3 的 Unmarshal 把文档包在 DocumentNode 里，真正的根 mapping 是 Content[0]
	if root.Kind == yaml.DocumentNode && len(root.Content) == 1 {
		root = *root.Content[0]
	}
	// 空文档：Unmarshal 得到零值节点，建一个空 mapping
	if root.Kind == 0 {
		root = yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	}
	if root.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("yaml 根节点应为 mapping")
	}

	// 找/建 presets 键
	var presetsNode *yaml.Node
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value == "presets" {
			presetsNode = root.Content[i+1]
			break
		}
	}
	if presetsNode == nil {
		keyNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "presets"}
		presetsNode = &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		root.Content = append(root.Content, keyNode, presetsNode)
	} else if presetsNode.Kind != yaml.SequenceNode {
		presetsNode.Kind = yaml.SequenceNode
		presetsNode.Tag = "!!seq"
		presetsNode.Content = nil
	}

	// 构造 flow-style values mapping（key 字母序，输出稳定）
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	valuesNode := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Style: yaml.FlowStyle}
	for _, k := range keys {
		valuesNode.Content = append(valuesNode.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: k},
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: values[k]},
		)
	}

	// 删除同名 preset（覆盖语义：删旧 + 追加新，位置移到末尾）
	kept := presetsNode.Content[:0]
	for _, item := range presetsNode.Content {
		if item.Kind == yaml.MappingNode && presetNameOf(item) == name {
			continue
		}
		kept = append(kept, item)
	}
	presetsNode.Content = kept
	presetsNode.Content = append(presetsNode.Content, newPresetMapping(name, description, valuesNode))

	return encodeYAMLNode(&root)
}

// presetNameOf 从 preset mapping 节点取 name 字段值。
func presetNameOf(item *yaml.Node) string {
	for i := 0; i+1 < len(item.Content); i += 2 {
		if item.Content[i].Value == "name" {
			return item.Content[i+1].Value
		}
	}
	return ""
}

// newPresetMapping 构造 name → description(非空时) → values 顺序的 mapping 节点。
func newPresetMapping(name, description string, valuesNode *yaml.Node) *yaml.Node {
	m := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	add := func(k string, v *yaml.Node) {
		m.Content = append(m.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: k},
			v,
		)
	}
	add("name", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: name})
	if description != "" {
		add("description", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: description})
	}
	add("values", valuesNode)
	return m
}

// encodeYAMLNode 以 2 空格缩进序列化节点。
func encodeYAMLNode(root *yaml.Node) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(root); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
