package registry

import (
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// VariableGroup 是全局配置页的一个手动变量分组：名字、卡片颜色（五色色卡）与
// 成员键。一个变量最多属于一个分组；没归组的变量由页面归入「未分组」兜底分区。
type VariableGroup struct {
	Name  string   `json:"name" yaml:"name"`
	Color string   `json:"color,omitempty" yaml:"color,omitempty"`
	Keys  []string `json:"keys,omitempty" yaml:"keys,omitempty"`
}

// varGroupsFile 是 var-groups.yaml 的顶层结构。
type varGroupsFile struct {
	Groups []VariableGroup `yaml:"groups"`
}

// LoadVariableGroups 读取 var-groups.yaml。文件不存在、为空或 YAML 无法解析一律
// 视为没有分组（空列表 + nil）——分组是界面偏好，文件问题不该让应用启动不了、
// 页面打不开（与 config.yaml、fragments.yaml 的加载宽容度一致）；坏文件在下次
// 写入时被整份替换，自然修复。
func LoadVariableGroups(path string) ([]VariableGroup, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []VariableGroup{}, nil
		}
		return nil, err
	}
	if len(data) == 0 {
		return []VariableGroup{}, nil
	}
	var f varGroupsFile
	if err := yaml.Unmarshal(data, &f); err != nil {
		return []VariableGroup{}, nil
	}
	return normalizeVariableGroups(f.Groups), nil
}

// SaveVariableGroups 规整后把分组列表整份写回 var-groups.yaml，返回规整后的
// 结果（页面提交整份状态，文件因此自我清理；写盘方式与片段文件一致）。
func SaveVariableGroups(path string, groups []VariableGroup) ([]VariableGroup, error) {
	normalized := normalizeVariableGroups(groups)
	data, err := yaml.Marshal(&varGroupsFile{Groups: normalized})
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		return nil, err
	}
	return normalized, nil
}

// normalizeVariableGroups 规整变量分组列表（读与写共用同一套规则）：名称去首尾
// 空白、空名丢弃、重名只保留第一个、非法颜色按未设置、同一变量只保留首次出现
// （最前面）的分组；keys 可以为空。规整不报错——分组是界面偏好，手改的非法
// 颜色和重名在读写时被规整而不是报错。
func normalizeVariableGroups(groups []VariableGroup) []VariableGroup {
	out := make([]VariableGroup, 0, len(groups))
	seenName := map[string]bool{}
	seenKey := map[string]bool{}
	for _, g := range groups {
		name := strings.TrimSpace(g.Name)
		if name == "" || seenName[name] {
			continue
		}
		seenName[name] = true
		keys := make([]string, 0, len(g.Keys))
		for _, k := range g.Keys {
			if seenKey[k] {
				continue
			}
			seenKey[k] = true
			keys = append(keys, k)
		}
		out = append(out, VariableGroup{Name: name, Color: normalizeAmbColor(g.Color), Keys: keys})
	}
	return out
}
