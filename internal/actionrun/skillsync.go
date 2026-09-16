// skillsync.go 实现「源为准，比对覆盖」的 skill 目录同步。
// 设计见 docs/superpowers/specs/2026-09-16-llm-skill-sync-design.md：
// 逐「相对路径+内容」比对，一致跳过；不一致逐文件覆盖写，目标多余文件删除；
// 名单外目录永不触碰；不做目录级先删后拷（中途失败最多留旧文件，不留空目录）。
package actionrun

import (
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// SyncItem 是一次同步的单个「源→目标」映射（SkillRouter.Route 产出）。
type SyncItem struct {
	ID     string
	Scope  string // "project" | "user"，仅用于报告行展示
	SrcDir string // 源目录（registry 扫描出的绝对路径）
	DstDir string // 目标目录（SkillRouter 按路由表拼出的绝对路径）
}

// SyncReport 汇总一次同步的结果。
type SyncReport struct {
	Synced   []SyncItem
	Skipped  []SyncItem
	Warnings []string // 非致命警告（未知 CLI 回退、账本写失败等），stderr 流
}

// Lines 返回 stdout 报告行（LLMRunner.Run 开头最先 emit，不进 Result.Stdout）。
func (r SyncReport) Lines() []string {
	var lines []string
	for _, it := range r.Synced {
		lines = append(lines, fmt.Sprintf("[skill-sync] %s(%s) → %s", it.ID, it.Scope, it.DstDir))
	}
	for _, it := range r.Skipped {
		lines = append(lines, fmt.Sprintf("[skill-sync] %s(%s) 已是最新，跳过", it.ID, it.Scope))
	}
	return lines
}

// SyncSkills 对 items 逐条执行目录同步。
func SyncSkills(items []SyncItem) (SyncReport, error) {
	var report SyncReport
	for _, it := range items {
		changed, err := syncOneDir(it.SrcDir, it.DstDir)
		if err != nil {
			return report, fmt.Errorf("skill %q 同步失败: %w", it.ID, err)
		}
		if changed {
			report.Synced = append(report.Synced, it)
		} else {
			report.Skipped = append(report.Skipped, it)
		}
	}
	return report, nil
}

// syncOneDir 把 src 整目录同步到 dst（源为准），返回是否有变更。
func syncOneDir(src, dst string) (bool, error) {
	srcFiles, err := walkFiles(src)
	if err != nil {
		return false, err
	}
	if len(srcFiles) == 0 {
		return false, fmt.Errorf("源目录 %s 不存在或为空（运行时被移动/删除）", src)
	}
	dstFiles, err := walkFiles(dst)
	if err != nil {
		return false, err
	}
	changed := false
	for rel, srcPath := range srcFiles {
		dstPath := filepath.Join(dst, filepath.FromSlash(rel))
		srcData, err := os.ReadFile(srcPath)
		if err != nil {
			return false, err
		}
		dstData, derr := os.ReadFile(dstPath)
		if derr != nil || !bytes.Equal(srcData, dstData) {
			if err := os.MkdirAll(filepath.Dir(dstPath), 0o755); err != nil {
				return false, err
			}
			if err := os.WriteFile(dstPath, srcData, 0o644); err != nil {
				return false, err
			}
			changed = true
		}
	}
	for rel := range dstFiles {
		if _, ok := srcFiles[rel]; !ok {
			if err := os.Remove(filepath.Join(dst, filepath.FromSlash(rel))); err != nil {
				return false, err
			}
			changed = true
		}
	}
	return changed, nil
}

// walkFiles 收集 dir 下所有文件的「相对路径(slash)→绝对路径」映射；
// 目录不存在返回空 map（目标侧语义：全部视为待新增）。
func walkFiles(dir string) (map[string]string, error) {
	out := map[string]string{}
	root, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		out[filepath.ToSlash(rel)] = p
		return nil
	})
	return out, err
}
