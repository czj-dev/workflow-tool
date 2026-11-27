package airun

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// piKeys 造一份三键齐全的 config 快照（值是测试假值，非真实密钥）。
func piKeys() map[string]string {
	return map[string]string{
		cfgKeyBaseURL: "http://oneapi.example/v1",
		cfgKeyAuthKey: "k-very-secret",
		cfgKeyModel:   "GLM-5.3-Flash",
	}
}

// fakeBin 造一个存在且带执行位的假可执行文件，返回路径。
func fakeBin(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestResolvePiBinOrder 探测优先级：AI_PI_BIN > <BaseDir>/pi/pi > PATH；全缺报错。
func TestResolvePiBinOrder(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("探测用 unix 执行位语义")
	}
	baseDir := t.TempDir()
	global := piKeys()
	bundled := fakeBin(t, filepath.Join(baseDir, "pi", "pi"))
	pathDir := t.TempDir()
	onPath := fakeBin(t, filepath.Join(pathDir, "pi"))
	t.Setenv("PATH", pathDir)

	// 显式 AI_PI_BIN 优先于 bundled 与 PATH
	explicit := fakeBin(t, filepath.Join(t.TempDir(), "pi-explicit"))
	global[cfgKeyPiBin] = explicit
	if got, err := resolvePiBin(global, baseDir); err != nil || got != explicit {
		t.Fatalf("AI_PI_BIN 应最优先: %q %v", got, err)
	}

	// 未配 AI_PI_BIN：bundled 优先于 PATH
	delete(global, cfgKeyPiBin)
	if got, err := resolvePiBin(global, baseDir); err != nil || got != bundled {
		t.Fatalf("bundled 应优先于 PATH: %q %v", got, err)
	}

	// bundled 不存在：PATH 兜底
	if err := os.Remove(bundled); err != nil {
		t.Fatal(err)
	}
	if got, err := resolvePiBin(global, baseDir); err != nil || got != onPath {
		t.Fatalf("PATH 应兜底: %q %v", got, err)
	}

	// AI_PI_BIN 指向不存在的文件：早失败
	global[cfgKeyPiBin] = filepath.Join(t.TempDir(), "no-such-pi")
	if _, err := resolvePiBin(global, baseDir); err == nil || !strings.Contains(err.Error(), cfgKeyPiBin) {
		t.Fatalf("AI_PI_BIN 失效应报错, got %v", err)
	}

	// 全缺：报错
	delete(global, cfgKeyPiBin)
	t.Setenv("PATH", t.TempDir())
	if _, err := resolvePiBin(piKeys(), baseDir); err == nil || !strings.Contains(err.Error(), "pi") {
		t.Fatalf("全缺应报错, got %v", err)
	}
}

// TestValidatePIConfig 三键缺任一早失败；齐全时返回 trim 后的 baseUrl 与 model。
func TestValidatePIConfig(t *testing.T) {
	for _, k := range []string{cfgKeyBaseURL, cfgKeyAuthKey, cfgKeyModel} {
		global := piKeys()
		delete(global, k)
		if _, _, err := validatePIConfig(global); err == nil || !strings.Contains(err.Error(), k) {
			t.Fatalf("缺 %s 应报错, got %v", k, err)
		}
	}
	global := piKeys()
	global[cfgKeyBaseURL] = "  http://x.example/v1  " // 值带空白
	b, m, err := validatePIConfig(global)
	if err != nil || b != "http://x.example/v1" || m != "GLM-5.3-Flash" {
		t.Fatalf("齐全时应返回终值: %q %q %v", b, m, err)
	}
}

// TestWritePIModels 内容契约：provider 固定 workflow-tool、apiKey 是 ${AI_AUTH_KEY}
// 插值字面量（密钥不落盘）、幂等跳过、变更重写、不留临时文件。
func TestWritePIModels(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "models.json")
	if err := writePIModels(dir, "http://oneapi.example/v1", "GLM-5.3-Flash"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var mf piModelsFile
	if err := json.Unmarshal(raw, &mf); err != nil {
		t.Fatal(err)
	}
	p, ok := mf.Providers[piProviderID]
	if !ok {
		t.Fatalf("providers 缺 %q: %s", piProviderID, raw)
	}
	if p.BaseURL != "http://oneapi.example/v1" || p.API != "openai-completions" {
		t.Fatalf("provider 字段不符: %+v", p)
	}
	if p.APIKey != "${AI_AUTH_KEY}" {
		t.Fatalf("apiKey 应是插值字面量（密钥不落盘）, got %q", p.APIKey)
	}
	if len(p.Models) != 1 || p.Models[0].ID != "GLM-5.3-Flash" {
		t.Fatalf("models 不符: %+v", p.Models)
	}
	if strings.Contains(string(raw), "k-very-secret") {
		t.Fatalf("密钥落盘: %s", raw)
	}

	// 幂等：内容不变跳过（mtime 不动）
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	if err := writePIModels(dir, "http://oneapi.example/v1", "GLM-5.3-Flash"); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(path); err != nil || !fi.ModTime().Equal(old) {
		t.Fatalf("内容未变应跳过重写: %v %v", fi, err)
	}

	// 内容变更：重写生效
	if err := writePIModels(dir, "http://other.example/v1", "M2"); err != nil {
		t.Fatal(err)
	}
	if raw2, _ := os.ReadFile(path); !strings.Contains(string(raw2), "other.example") || !strings.Contains(string(raw2), "M2") {
		t.Fatalf("变更未生效: %s", raw2)
	}

	// 原子写不在 agent 目录留临时文件
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".models.json") {
			t.Fatalf("残留临时文件: %s", e.Name())
		}
	}
}

// TestSetupPI 端到端：bundled 探测、hermetic 目录创建、models.json 落位。
func TestSetupPI(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("探测用 unix 执行位语义")
	}
	baseDir := t.TempDir()
	bundled := fakeBin(t, filepath.Join(baseDir, "pi", "pi"))
	t.Setenv("PATH", t.TempDir()) // 隔离 PATH，验证 bundled 路径

	piBin, model, agentDir, sessionDir, err := setupPI(baseDir, piKeys())
	if err != nil {
		t.Fatal(err)
	}
	if piBin != bundled {
		t.Fatalf("piBin = %q want %q", piBin, bundled)
	}
	if model != "GLM-5.3-Flash" {
		t.Fatalf("model = %q", model)
	}
	if agentDir != filepath.Join(baseDir, piAgentDirName) || sessionDir != filepath.Join(baseDir, piSessionDirName) {
		t.Fatalf("hermetic 目录 = %q / %q", agentDir, sessionDir)
	}
	for _, d := range []string{agentDir, sessionDir} {
		if fi, err := os.Stat(d); err != nil || !fi.IsDir() {
			t.Fatalf("目录未创建: %s (%v)", d, err)
		}
	}
	if _, err := os.Stat(filepath.Join(agentDir, "models.json")); err != nil {
		t.Fatalf("models.json 未落位: %v", err)
	}

	// 三键缺一：早失败（可执行可解析，轮到键校验），目录都不建
	fresh := t.TempDir()
	fakeBin(t, filepath.Join(fresh, "pi", "pi"))
	bad := piKeys()
	delete(bad, cfgKeyModel)
	if _, _, _, _, err := setupPI(fresh, bad); err == nil || !strings.Contains(err.Error(), cfgKeyModel) {
		t.Fatalf("缺键应早失败, got %v", err)
	}
	if fi, err := os.Stat(filepath.Join(fresh, piAgentDirName)); err == nil || fi != nil {
		t.Fatalf("早失败不应建 agent 目录: %v", err)
	}
}
