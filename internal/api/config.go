package api

import (
	"fmt"

	"workflow-tool/internal/registry"
)

// GetGlobalConfig 返回当前全局配置（返回副本，避免前端误改内部 map）。
func (s *Service) GetGlobalConfig() map[string]string {
	s.gMu.Lock()
	defer s.gMu.Unlock()
	out := make(map[string]string, len(s.global))
	for k, v := range s.global {
		out[k] = v
	}
	return out
}

// SetGlobalConfig 替换全局配置并写回 config.yaml。
func (s *Service) SetGlobalConfig(cfg map[string]string) error {
	s.gMu.Lock()
	defer s.gMu.Unlock()
	if err := registry.SaveGlobal(s.cfgPath, cfg); err != nil {
		return err
	}
	s.global = cfg
	return nil
}

// GetVariableGroups 返回规整后的变量分组列表，顺序即文件顺序（副本）。
// 分组与全局配置分开存：整理分组不碰运行时读取的 config.yaml。
func (s *Service) GetVariableGroups() []registry.VariableGroup {
	s.gMu.Lock()
	defer s.gMu.Unlock()
	out := make([]registry.VariableGroup, len(s.varGroups))
	copy(out, s.varGroups)
	return out
}

// SetVariableGroups 规整 → 写盘 → 更新内存 → 返回规整后的结果。与全局配置
// 共用互斥锁；写盘方式与片段文件一致。页面每次提交整份状态：页面上没有对应
// 行、且已保存全局配置里也不存在的变量（早已删除的变量）由页面在构建载荷时
// 丢弃，整份替换写盘因此让文件自我清理；未保存的草稿行照常提交、保留。
func (s *Service) SetVariableGroups(groups []registry.VariableGroup) ([]registry.VariableGroup, error) {
	s.gMu.Lock()
	defer s.gMu.Unlock()
	normalized, err := registry.SaveVariableGroups(s.varGroupsPath, groups)
	if err != nil {
		return nil, err
	}
	s.varGroups = normalized
	return normalized, nil
}

// AgentConfig 是 Settings → Agent 分区编辑的领域模型：三个已知字段 + auth.json 里
// 其余未知键的透传（键名词汇表将来扩展不留死角）。前端表单只关心已知字段。
type AgentConfig struct {
	BaseURL string            `json:"baseUrl"`         // OpenAI 兼容端点，需含 /v1
	AuthKey string            `json:"authKey"`         // 网关密钥；0600 落盘，不进 config.yaml
	Model   string            `json:"model"`           // 模型 id（如 GLM-5.3-Flash）
	Extra   map[string]string `json:"extra,omitempty"` // auth.json 里的未知键，保存时原样写回
}

// GetAgentConfig 返回 Agent 三键当前值（Settings → Agent 表单初值）。auth.json 不
// 存在时返回零值表单 + nil；损坏时返回 error——静默给空表单会让用户重存时覆盖掉
// 还可能救回的文件。
func (s *Service) GetAgentConfig() (AgentConfig, error) {
	kv, err := registry.LoadAuth(s.authPath)
	if err != nil {
		return AgentConfig{}, fmt.Errorf("读取 auth.json 失败: %w", err)
	}
	return agentConfigFromKV(kv), nil
}

// SetAgentConfig 把 Agent 三键写回用户级 auth.json（registry.SaveAuth：0600 原子写）。
// 文件里已有、前端未回传的未知键原样保留；auth.json 损坏时拒绝覆盖（先修文件
// 或删掉再配，比静默清空更安全）。
func (s *Service) SetAgentConfig(cfg AgentConfig) error {
	kv, err := registry.LoadAuth(s.authPath)
	if err != nil {
		return fmt.Errorf("读取 auth.json 失败，拒绝覆盖: %w", err)
	}
	kv["AI_BASE_URL"] = cfg.BaseURL
	kv["AI_AUTH_KEY"] = cfg.AuthKey
	kv["AI_MODEL"] = cfg.Model
	for k, v := range cfg.Extra {
		kv[k] = v
	}
	return registry.SaveAuth(s.authPath, kv)
}

// agentConfigFromKV 把 auth.json 的键值表拆成已知字段 + 未知键。
func agentConfigFromKV(kv map[string]string) AgentConfig {
	cfg := AgentConfig{
		BaseURL: kv["AI_BASE_URL"],
		AuthKey: kv["AI_AUTH_KEY"],
		Model:   kv["AI_MODEL"],
	}
	for k, v := range kv {
		if k == "AI_BASE_URL" || k == "AI_AUTH_KEY" || k == "AI_MODEL" {
			continue
		}
		if cfg.Extra == nil {
			cfg.Extra = map[string]string{}
		}
		cfg.Extra[k] = v
	}
	return cfg
}

// GetFragments 返回当前指令片段列表（副本）。
func (s *Service) GetFragments() []registry.Fragment {
	s.fMu.Lock()
	defer s.fMu.Unlock()
	out := make([]registry.Fragment, len(s.fragments))
	copy(out, s.fragments)
	return out
}

// SetFragments 替换指令片段并写回 fragments.yaml。
func (s *Service) SetFragments(list []registry.Fragment) error {
	s.fMu.Lock()
	defer s.fMu.Unlock()
	if err := registry.SaveFragments(s.fragPath, list); err != nil {
		return err
	}
	s.fragments = list
	return nil
}
