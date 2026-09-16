// skillrouter.go 集中维护 skill 同步的全部路径映射（设计见 spec）：
// 「CLI → 目录约定」路由表 + 作用域（project/user）+ agent-cwd → 目标目录，
// 以及同步足迹账本 skills.synced.json 的读写与自洁。
// 路径全部硬编码约定，不做配置化（无 CLAUDE_CONFIG_DIR 适配、无 config 覆盖）。
package actionrun

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"workflow-tool/internal/registry"
)

// cliSkillDirs 是「CLI → skill 目录约定」路由表（键小写归一）。
// 同一 CLI 可配多个目录（codex 双根），一个 skill 产出多条 SyncItem。
var cliSkillDirs = map[string][]string{
	"claude": {".claude/skills"},
	"ducc":   {".claude/skills"}, // CC 兼容，与 claude 同约定
	"codex":  {".codex/skills", ".agents/skills"},
}

// fallbackSkillDirs 是未知 CLI 的回退目录：能配进 LLM 形态的 CLI 必然兼容
// CC headless 协议（llmFixedArgs 即 CC 协议），大概率沿用其目录约定；
// 回退保证路由永不因表缺失而失败，警告保持可见。
var fallbackSkillDirs = []string{".claude/skills"}

// SkillRouter 维护「绑定 ids → 源/目标路径」映射与同步足迹。
// Skills/HomeDir 均为注入（测试不依赖真实 registry / 真实用户目录）。
type SkillRouter struct {
	Skills     func() map[string]registry.SkillMeta
	HomeDir    func() string
	LedgerPath string // skills.synced.json 绝对路径（exe 同级，dev 时项目根）

	// mu 保护 Record 的读-改-写：直跑与 workflow 并行 step 可并发触达同一
	// router 实例（api.go 的 runDeps 只构造一次），无锁会丢条目或交错写坏 JSON。
	mu sync.Mutex
}

// Route 把绑定的 skill ids 展开为 SyncItem 列表（一对多：codex 双根、
// project/user 分流到不同目标根）。agentCwd 恒非空（Build 已做 BaseDir 兜底）。
// 源缺失（加载后被移动/删除）返回 error——skill 是声明的依赖，动作失败。
func (r *SkillRouter) Route(ids []string, agentCwd, cli string) ([]SyncItem, SyncReport, error) {
	var report SyncReport
	skills := r.Skills()
	cliKey := strings.ToLower(strings.TrimSpace(cli))
	if cliKey == "" {
		cliKey = "ducc" // 与 LLMRunner 的 defaultLLMCLI 对齐
	}
	dirs, ok := cliSkillDirs[cliKey]
	if !ok {
		dirs = fallbackSkillDirs
		report.Warnings = append(report.Warnings,
			fmt.Sprintf("[skill-sync] 未知 CLI %q（config.yaml LLM_CLI），回退 .claude/skills 目录约定", cli))
	}
	home := r.HomeDir()
	var items []SyncItem
	for _, id := range ids {
		meta, ok := skills[id]
		if !ok {
			return nil, report, fmt.Errorf("skill %q 不存在（skills/ 加载后被移动或删除），请重新加载动作", id)
		}
		base := agentCwd
		if meta.Scope == "user" {
			if home == "" {
				return nil, report, fmt.Errorf("无法确定用户主目录，user 级 skill %q 无法同步", id)
			}
			base = home
		}
		for _, sub := range dirs {
			items = append(items, SyncItem{
				ID:     id,
				Scope:  meta.Scope,
				SrcDir: meta.Dir,
				DstDir: filepath.Join(base, filepath.FromSlash(sub), id),
			})
		}
	}
	return items, report, nil
}

// Record 把本次同步足迹合并进账本（目标根 → id 列表）并自洁落盘。
// 账本是维护性数据：写失败由调用方降级为警告，不使动作失败。
// 读-改-写全程持锁：并发 Record 串行化，防后写者覆盖前写者或交错写坏 JSON。
func (r *SkillRouter) Record(items []SyncItem) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	ledger := map[string][]string{}
	if data, err := os.ReadFile(r.LedgerPath); err == nil {
		_ = json.Unmarshal(data, &ledger) // 损坏则忽略重建
	}
	for _, it := range items {
		root := normalizeLedgerPath(filepath.Dir(it.DstDir))
		if !containsStr(ledger[root], it.ID) {
			ledger[root] = append(ledger[root], it.ID)
		}
	}
	// 自洁：源里已不存在的 id 全局丢弃
	skills := r.Skills()
	for root, ids := range ledger {
		kept := ids[:0]
		for _, id := range ids {
			if _, ok := skills[id]; ok {
				kept = append(kept, id)
			}
		}
		if len(kept) > 0 {
			ledger[root] = kept
		} else {
			delete(ledger, root)
		}
	}
	data, err := json.MarshalIndent(ledger, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(r.LedgerPath, data, 0o644)
}

// normalizeLedgerPath 归一为绝对路径（Windows 下统一反斜杠，作账本键）。
func normalizeLedgerPath(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	return abs
}

func containsStr(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
