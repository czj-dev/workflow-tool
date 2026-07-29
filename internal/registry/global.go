package registry

import (
	"os"

	"gopkg.in/yaml.v3"
)

// LoadGlobal 读取全局配置 config.yaml（简单 key-value）。
// 文件不存在时返回空 map + nil（启动时正常，不强制存在）。
func LoadGlobal(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]string{}, nil
		}
		return nil, err
	}
	kv := map[string]string{}
	if err := yaml.Unmarshal(data, kv); err != nil {
		return nil, err
	}
	return kv, nil
}

// SaveGlobal 把全局配置写回 config.yaml。
func SaveGlobal(path string, kv map[string]string) error {
	data, err := yaml.Marshal(kv)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}
