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
	// Color 可选，卡片颜色（色卡五色之一，normalizeAmbColor 规整）；未设置时
	// 跟随分区的琥珀色。读与写时不在色卡内的值一律按未设置处理、不报错。
	Color string `json:"color,omitempty" yaml:"color,omitempty"`
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
	for i := range f.Fragments {
		f.Fragments[i].Color = normalizeAmbColor(f.Fragments[i].Color)
	}
	return f.Fragments, nil
}

// SaveFragments 把片段列表写回 fragments.yaml（非法 color 写时按未设置落盘）。
func SaveFragments(path string, list []Fragment) error {
	clean := make([]Fragment, len(list))
	copy(clean, list)
	for i := range clean {
		clean[i].Color = normalizeAmbColor(clean[i].Color)
	}
	f := fragmentsFile{Fragments: clean}
	data, err := yaml.Marshal(&f)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}
