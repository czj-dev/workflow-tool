package registry

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
)

// LoadAuth 读取用户级 Agent 配置 auth.json（简单 key-value，键名沿用 AI_* 大写词汇，
// 与 config.yaml 单一词汇表）。文件不存在或为空时返回空 map + nil——首次配置前属
// 正常态，不强制存在；JSON 语法损坏返回 error：密钥文件悄悄清空比显式报错更危险。
func LoadAuth(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]string{}, nil
		}
		return nil, err
	}
	kv := map[string]string{}
	if len(bytes.TrimSpace(data)) == 0 {
		return kv, nil
	}
	if err := json.Unmarshal(data, &kv); err != nil {
		return nil, err
	}
	return kv, nil
}

// SaveAuth 把 Agent 配置原子写回 auth.json（同目录临时文件 + rename，与
// writePIModels 同法）。权限 0600——内容含密钥，不给同机其他用户读的机会；
// 父目录（UserDir）不存在时一并创建。
func SaveAuth(path string, kv map[string]string) error {
	if kv == nil {
		kv = map[string]string{} // nil 写成 {} 而非 null，回读语义一致
	}
	data, err := json.MarshalIndent(kv, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".auth.json.*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	// CreateTemp 即 0600，显式 chmod 声明密钥文件意图，防实现细节漂移。
	if err := os.Chmod(tmpName, 0o600); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}
