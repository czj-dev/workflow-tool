package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"workflow-tool/internal/runstore"
)

// newAgentSvc 建一个用户目录重定向到临时目录的 service：否则 Get/SetAgentConfig
// 会读写真实 ~/.workflow-tool。WORKFLOW_TOOL_USER_HOME 必须在 New 之前设好
// （authPath 在构造时定死）。基于 newAiSvc 的假 pi 环境。
func newAgentSvc(t *testing.T) (*Service, string) {
	t.Helper()
	userDir := t.TempDir()
	t.Setenv("WORKFLOW_TOOL_USER_HOME", userDir)
	svc, _ := newAiSvc(t, "")
	return svc, userDir
}

func TestGetAgentConfigMissingFileIsEmpty(t *testing.T) {
	svc, userDir := newAgentSvc(t)
	cfg, err := svc.GetAgentConfig()
	if err != nil {
		t.Fatalf("auth.json 不存在应是空表单: %v", err)
	}
	if cfg.BaseURL != "" || cfg.AuthKey != "" || cfg.Model != "" || cfg.Extra != nil {
		t.Fatalf("空表单 = %+v", cfg)
	}
	// 读取不落盘：auth.json 不因打开设置页而被创建
	if _, err := os.Stat(filepath.Join(userDir, "auth.json")); !os.IsNotExist(err) {
		t.Fatalf("读取不应创建 auth.json: %v", err)
	}
}

func TestSetAgentConfigRoundTrip(t *testing.T) {
	svc, userDir := newAgentSvc(t)
	in := AgentConfig{
		BaseURL: "http://oneapi.example/v1",
		AuthKey: "k-test",
		Model:   "GLM-5.3-Flash",
		Extra:   map[string]string{"AI_FUTURE_KEY": "v"},
	}
	if err := svc.SetAgentConfig(in); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(userDir, "auth.json"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("auth.json 权限 = %v want 0600", fi.Mode().Perm())
	}
	raw, err := os.ReadFile(filepath.Join(userDir, "auth.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"AI_BASE_URL", "AI_AUTH_KEY", "AI_MODEL", "AI_FUTURE_KEY"} {
		if !strings.Contains(string(raw), k) {
			t.Fatalf("auth.json 应含键 %s: %s", k, raw)
		}
	}
	got, err := svc.GetAgentConfig()
	if err != nil {
		t.Fatal(err)
	}
	if got.BaseURL != in.BaseURL || got.AuthKey != in.AuthKey || got.Model != in.Model {
		t.Fatalf("回读不符: %+v", got)
	}
	if got.Extra["AI_FUTURE_KEY"] != "v" {
		t.Fatalf("未知键未透传: %+v", got.Extra)
	}
}

func TestSetAgentConfigKeepsUnknownKeysNotSentBack(t *testing.T) {
	svc, _ := newAgentSvc(t)
	if err := svc.SetAgentConfig(AgentConfig{
		BaseURL: "u", AuthKey: "k", Model: "m",
		Extra: map[string]string{"AI_X": "1"},
	}); err != nil {
		t.Fatal(err)
	}
	// 前端没带 Extra 保存（表单只回传已知字段）：文件里的未知键不丢
	if err := svc.SetAgentConfig(AgentConfig{BaseURL: "u2", AuthKey: "k2", Model: "m2"}); err != nil {
		t.Fatal(err)
	}
	got, err := svc.GetAgentConfig()
	if err != nil {
		t.Fatal(err)
	}
	if got.Extra["AI_X"] != "1" {
		t.Fatalf("未回传的未知键应保留: %+v", got.Extra)
	}
}

func TestAgentConfigCorruptFileErrorsAndRefusesOverwrite(t *testing.T) {
	svc, userDir := newAgentSvc(t)
	if err := os.WriteFile(filepath.Join(userDir, "auth.json"), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.GetAgentConfig(); err == nil {
		t.Fatal("损坏的 auth.json 读取应报错")
	}
	if err := svc.SetAgentConfig(AgentConfig{Model: "m"}); err == nil {
		t.Fatal("损坏的 auth.json 上保存应被拒绝（不覆盖）")
	}
	if raw, _ := os.ReadFile(filepath.Join(userDir, "auth.json")); string(raw) != "{broken" {
		t.Fatalf("拒绝覆盖时文件不应被改动: %s", raw)
	}
}

// TestRunAiUsesAgentConfig 端到端接线：config.yaml 不带三键时 RunAi 失败；经
// SetAgentConfig（Settings → Agent 的保存路径）写入 auth.json 后重跑即通——
// aiDeps.AgentConfig 每次运行现读，保存即生效。
func TestRunAiUsesAgentConfig(t *testing.T) {
	svc, _ := newAgentSvc(t)
	// config.yaml 清三键，只留 AI_PI_BIN（假 pi 路径）
	bin := svc.GetGlobalConfig()["AI_PI_BIN"]
	if err := svc.SetGlobalConfig(map[string]string{"AI_PI_BIN": bin}); err != nil {
		t.Fatal(err)
	}

	if err := svc.RunAi("t-ask", map[string]any{"TOPIC": "Go"}); err != nil {
		t.Fatal(err)
	}
	got := waitRuns(t, svc, 1, allSettled)[0]
	if got.Status != runstore.StatusFailed {
		t.Fatalf("config 与 auth 都无三键时应失败: %+v", got)
	}

	if err := svc.SetAgentConfig(AgentConfig{
		BaseURL: "http://oneapi.example/v1",
		AuthKey: "k-test",
		Model:   "M-TEST",
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.RunAi("t-ask", map[string]any{"TOPIC": "Go"}); err != nil {
		t.Fatal(err)
	}
	got = waitRuns(t, svc, 2, allSettled)[0]
	if got.Status != runstore.StatusSucceeded {
		t.Fatalf("auth.json 提供三键后应成功: %+v", got)
	}
}
