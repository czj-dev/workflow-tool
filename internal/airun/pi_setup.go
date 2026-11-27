// pi_setup.go 完成 pi 侧初始化（设计 §1，阶段 0 spike 用真实端点验证后移植）：
// 可执行解析、三键校验（auth 合并后的生效 config）、hermetic 目录创建与 models.json 原子写。
// 密钥不落盘：models.json 的 apiKey 字段写 pi 官方的 ${AI_AUTH_KEY} 环境插值，
// 请求时从 pi 子进程 env 解析（pi models.md 文档化机制）；子进程 env 由 Build 的
// envInputs 透传 AI_AUTH_KEY，父进程自身 env 无此键。
package airun

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// piProviderID 是 models.json 里固定的自定义 provider 名，--model argv 的
// workflow-tool/<model> 前缀与之对应（runner 侧的 piProviderPrefix）。
const piProviderID = "workflow-tool"

// pi 相关键（config.yaml 与 auth.json 共用一套键名词汇表）：三键正源为 auth.json
// （config.yaml 退居回退），AI_PI_BIN 仍属 config.yaml；AI_CLI 已删除（残留只警告）。
const (
	cfgKeyBaseURL   = "AI_BASE_URL"
	cfgKeyAuthKey   = "AI_AUTH_KEY"
	cfgKeyModel     = "AI_MODEL"
	cfgKeyPiBin     = "AI_PI_BIN"
	cfgKeyLegacyCLI = "AI_CLI"
)

// pi hermetic 目录名（挂在应用目录下）：agent 目录经 env PI_CODING_AGENT_DIR 注入，
// 会话目录经 --session-dir argv 注入；用户自己的 ~/.pi 配置不生效。
const (
	piAgentDirName   = "pi-agent"
	piSessionDirName = "pi-sessions"
)

// piPaths 返回 hermetic 的 agent 目录与会话目录。
func piPaths(baseDir string) (agentDir, sessionDir string) {
	return filepath.Join(baseDir, piAgentDirName), filepath.Join(baseDir, piSessionDirName)
}

// setupPI 是 Build 的 pi 初始化入口：解析可执行 → 校验三键 → 建 hermetic 目录 →
// 写 models.json，返回 AIConfig 需要的四个终值字段。
func setupPI(baseDir string, global map[string]string) (piBin, model, agentDir, sessionDir string, err error) {
	piBin, err = resolvePiBin(global, baseDir)
	if err != nil {
		return "", "", "", "", err
	}
	var baseURL string
	baseURL, model, err = validatePIConfig(global)
	if err != nil {
		return "", "", "", "", err
	}
	agentDir, sessionDir = piPaths(baseDir)
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		return "", "", "", "", fmt.Errorf("创建 pi agent 目录失败: %w", err)
	}
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		return "", "", "", "", fmt.Errorf("创建 pi 会话目录失败: %w", err)
	}
	if err := writePIModels(agentDir, baseURL, model); err != nil {
		return "", "", "", "", fmt.Errorf("写 pi models.json 失败: %w", err)
	}
	return piBin, model, agentDir, sessionDir, nil
}

// resolvePiBin 按优先级解析 pi 可执行路径：config.yaml AI_PI_BIN（显式路径）>
// <BaseDir>/pi/pi（未来随包分发的解压位置，Windows 探 pi\pi.exe）> PATH 上的 pi。
// AI_PI_BIN 显式写了却指向不存在的文件时早失败——配置显式声明的就该是对的。
func resolvePiBin(global map[string]string, baseDir string) (string, error) {
	if p := strings.TrimSpace(global[cfgKeyPiBin]); p != "" {
		if !isExecutableFile(p) {
			return "", fmt.Errorf("config.yaml %s 指向的 pi 不存在或不可执行: %s", cfgKeyPiBin, p)
		}
		return p, nil
	}
	if p := filepath.Join(baseDir, "pi", piExeName()); isExecutableFile(p) {
		return p, nil
	}
	if p, err := exec.LookPath("pi"); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("未找到 pi 可执行文件：请在 config.yaml 配置 %s，或把 pi 解压到 %s，或装进 PATH",
		cfgKeyPiBin, filepath.Join(baseDir, "pi"))
}

// piExeName 是 pi 二进制文件名（Windows 带扩展名）。
func piExeName() string {
	if runtime.GOOS == "windows" {
		return "pi.exe"
	}
	return "pi"
}

// isExecutableFile 报告 path 是存在且（unix 下）带执行位的普通文件。
func isExecutableFile(path string) bool {
	fi, err := os.Stat(path)
	if err != nil || fi.IsDir() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return fi.Mode().Perm()&0o111 != 0
}

// validatePIConfig 校验 hermetic 运行必需的三键并返回 baseUrl 与 model。
// 缺任一即早失败：hermetic 设计下没有它们 pi 必然无模型可用，早失败优于流内报错。
// AI_BASE_URL 语义需含 /v1（pi 向其追加 /chat/completions，缺省会命中网关控制台
// HTML——阶段 0 实测）；此处不强制，由用户保证。
func validatePIConfig(global map[string]string) (baseURL, model string, err error) {
	var missing []string
	for _, k := range []string{cfgKeyBaseURL, cfgKeyAuthKey, cfgKeyModel} {
		if strings.TrimSpace(global[k]) == "" {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		return "", "", fmt.Errorf("Agent 配置（auth.json，config.yaml 回退）缺少 pi 必需键: %s（%s / %s / %s 三键齐全才能运行 AI 任务）",
			strings.Join(missing, ", "), cfgKeyBaseURL, cfgKeyAuthKey, cfgKeyModel)
	}
	return strings.TrimSpace(global[cfgKeyBaseURL]), strings.TrimSpace(global[cfgKeyModel]), nil
}

// ---- models.json ----

// piModelsFile 是 pi agent 目录下 models.json 的结构：只声明 workflow-tool 用到的
// 字段，未知字段不写（pi 对 provider 配置的其他字段有默认值）。
type piModelsFile struct {
	Providers map[string]piProviderCfg `json:"providers"`
}

type piProviderCfg struct {
	BaseURL string            `json:"baseUrl"` // 需含 /v1，pi 追加 /chat/completions
	API     string            `json:"api"`     // OpenAI 兼容端点用 completions 协议
	APIKey  string            `json:"apiKey"`  // ${AI_AUTH_KEY} 插值字面量，磁盘不落密钥
	Models  []piProviderModel `json:"models"`
}

type piProviderModel struct {
	ID string `json:"id"`
}

// writePIModels 把 provider 配置原子写进 agentDir/models.json（临时文件 + rename）。
// 内容不变时跳过——并发 Build 同内容 last-write-wins 无害。
func writePIModels(agentDir, baseURL, model string) error {
	mf := piModelsFile{Providers: map[string]piProviderCfg{
		piProviderID: {
			BaseURL: baseURL,
			API:     "openai-completions",
			APIKey:  "${" + cfgKeyAuthKey + "}",
			Models:  []piProviderModel{{ID: model}},
		},
	}}
	data, err := json.MarshalIndent(mf, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	dst := filepath.Join(agentDir, "models.json")
	if cur, err := os.ReadFile(dst); err == nil && bytes.Equal(cur, data) {
		return nil
	}
	tmp, err := os.CreateTemp(agentDir, ".models.json.*")
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
	if err := os.Rename(tmpName, dst); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}
