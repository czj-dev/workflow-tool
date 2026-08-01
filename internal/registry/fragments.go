package registry

import (
	"os"

	"gopkg.in/yaml.v3"
)

// Fragment 是一条指令片段。
type Fragment struct {
	Title   string   `json:"title" yaml:"title"`
	Content string   `json:"content" yaml:"content"`
	Tags    []string `json:"tags" yaml:"tags"`
}

// fragmentsFile 是 fragments.yaml 的顶层结构。
type fragmentsFile struct {
	Fragments []Fragment `yaml:"fragments"`
}

// LoadFragments 读取 fragments.yaml。文件不存在返回空切片 + nil。
func LoadFragments(path string) ([]Fragment, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []Fragment{}, nil
		}
		return nil, err
	}
	if len(data) == 0 {
		return []Fragment{}, nil
	}
	var f fragmentsFile
	if err := yaml.Unmarshal(data, &f); err != nil {
		return nil, err
	}
	if f.Fragments == nil {
		return []Fragment{}, nil
	}
	return f.Fragments, nil
}

// SaveFragments 把片段列表写回 fragments.yaml。
func SaveFragments(path string, list []Fragment) error {
	f := fragmentsFile{Fragments: list}
	data, err := yaml.Marshal(&f)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}
