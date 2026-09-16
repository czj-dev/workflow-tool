# LLM 动作 Skill 同步机制 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LLM 动作声明绑定的 skill 在运行前由 `SkillRouter` 按「CLI 路由表 × 作用域 × agent-cwd」同步到 Agent 目录，CLI 自行发现加载（文件即注册，零 prompt 拼接）。

**Architecture:** registry 扫描 exe 同级 `skills/` 两级分区（根=project、`user/`=user）产出可用集并做加载校验；`SkillRouter`（actionrun 包）集中维护路径映射与足迹账本 `skills.synced.json`；`SyncSkills` 逐文件「源为准比对覆盖」；`Build`（签名改为返回 error）接线同步并把报告行注入 `LLMConfig`，由 `LLMRunner.Run` 开头最先 emit。

**Tech Stack:** Go stdlib（无新依赖）；测试 `testing` + `t.TempDir()`。

**Spec:** `docs/superpowers/specs/2026-09-16-llm-skill-sync-design.md`

## Global Constraints

- 报告行格式（stdout 流，不进 `Result.Stdout`）：`[skill-sync] <id>(<scope>) → <dstDir>` / `[skill-sync] <id>(<scope>) 已是最新，跳过`；警告行（stderr 流）带 `[skill-sync]` 前缀
- skill id 命名 `^[a-z0-9-]+$`；CLI 路由表键小写归一；未知 CLI 回退 `{".claude/skills"}` + 警告
- 同步失败 = 动作失败；账本 Record 失败 = 警告（不失败）
- 不做：UI、AI 生成、配置化路径、孤儿自动清理、CLI 协议分派
- 所有测试命令须显式 `cd C:/Users/ASUS/Documents/workflow-tool`（项目根），Go 路径用正斜杠

---

### Task 1: registry skills 扫描与加载校验

**Files:**
- Modify: `internal/registry/registry.go`（`LLMCommand.Skills` 字段、`SkillMeta`/`Registry.Skills`、`Load` 扫描+引用校验、`Validate` id 模式）
- Test: `internal/registry/skills_test.go`（新建）

**Interfaces:**
- Produces: `registry.SkillMeta{Scope, Dir string}`（Scope 为 `"project"`/`"user"`，Dir 为源目录绝对路径）；`Registry.Skills map[string]SkillMeta`；`LLMCommand.Skills []string`（yaml `skills`）——Task 3/5 依赖这些名字

- [ ] **Step 1: 写失败测试**

`internal/registry/skills_test.go`：

```go
package registry

import (
	"os"
	"path/filepath"
	"testing"
)

// writeSkill 在 baseDir/skills 下造一个 skill（scope 决定是否落 user/ 分区）。
func writeSkill(t *testing.T, baseDir, id, scope, content string) {
	t.Helper()
	sub := filepath.Join(baseDir, "skills")
	if scope == "user" {
		sub = filepath.Join(sub, "user")
	}
	dir := filepath.Join(sub, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if content != "" {
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// writeAction 写一个最小可加载的 llm 动作 YAML。
// skillsYAML 非空时是已带缩进的列表项文本（6 空格 起），插在 llm 块内
// prompt 之后——不能 append 到末尾，否则会挂到 params 列表项下。
func writeAction(t *testing.T, dir, id, skillsYAML string) {
	t.Helper()
	yaml := "id: " + id + "\ntitle: " + id + "\ncommand:\n  llm:\n    prompt: p\n"
	if skillsYAML != "" {
		yaml += "    skills:\n" + skillsYAML
	}
	yaml += "params:\n  - id: p\n    type: text\n"
	if err := os.WriteFile(filepath.Join(dir, id+".yaml"), []byte(yaml), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadSkillsScopes(t *testing.T) {
	base := t.TempDir()
	writeSkill(t, base, "bug-analyze", "project", "# x")
	writeSkill(t, base, "git-style", "user", "# x")
	writeSkill(t, base, "no-skill-md", "project", "") // 无 SKILL.md，不收录
	actDir := filepath.Join(base, "actions")
	if err := os.MkdirAll(actDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeAction(t, actDir, "demo-a", "      - bug-analyze\n      - git-style\n")

	reg := Load(actDir, base)

	if len(reg.Errors) != 0 {
		t.Fatalf("意外错误: %v", reg.Errors)
	}
	if got := reg.Skills["bug-analyze"]; got.Scope != "project" {
		t.Fatalf("bug-analyze scope = %q, want project", got.Scope)
	}
	if got := reg.Skills["git-style"]; got.Scope != "user" {
		t.Fatalf("git-style scope = %q, want user", got.Scope)
	}
	if _, ok := reg.Skills["no-skill-md"]; ok {
		t.Fatal("无 SKILL.md 的目录不应收录")
	}
}

func TestLoadSkillsCrossScopeConflict(t *testing.T) {
	base := t.TempDir()
	writeSkill(t, base, "dup", "project", "# x")
	writeSkill(t, base, "dup", "user", "# x")
	actDir := filepath.Join(base, "actions")
	if err := os.MkdirAll(actDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeAction(t, actDir, "demo-a", "")

	reg := Load(actDir, base)

	if len(reg.Errors) == 0 {
		t.Fatal("跨级同名 id 应报冲突")
	}
}

func TestLoadSkillRefMissing(t *testing.T) {
	base := t.TempDir()
	actDir := filepath.Join(base, "actions")
	if err := os.MkdirAll(actDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeAction(t, actDir, "demo-a", "      - ghost\n")

	reg := Load(actDir, base)

	if len(reg.Errors) == 0 {
		t.Fatal("引用不存在的 skill 应报错")
	}
	if _, ok := reg.Actions["demo-a"]; ok {
		t.Fatal("引用失败的动不应进入 Actions")
	}
}

func TestValidateSkillIDPattern(t *testing.T) {
	def := &ActionDef{ID: "x", Title: "x", Command: Command{LLM: LLMCommand{Prompt: "p", Skills: []string{"Bad_Name"}}}}
	if err := Validate(def); err == nil {
		t.Fatal("skill id 不匹配 ^[a-z0-9-]+$ 应报错")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd C:/Users/ASUS/Documents/workflow-tool && go test ./internal/registry -run 'TestLoadSkills|TestLoadSkillRef|TestValidateSkillID' -v`
Expected: 编译失败（`Skills`/`reg.Skills` 未定义）

- [ ] **Step 3: 最小实现**

`internal/registry/registry.go` 三处修改：

① `LLMCommand` 末尾加字段：

```go
	// Resume 可选，param id，值非空时通过 --resume <值> 续接指定 session id 的历史会话。
	Resume string `yaml:"resume"`
	// Skills 可选，绑定的 skill id 列表。运行前由 actionrun.SkillRouter 把
	// skills/ 源目录里对应 skill 同步到 Agent 工作目录，CLI 自行发现加载。
	Skills []string `yaml:"skills"`
```

② `Registry` 结构与 `SkillMeta` 类型（放在 `Registry` 定义旁）：

```go
// Registry 是所有已加载动作的集合。
type Registry struct {
	Actions map[string]LoadedAction
	Errors  []FileError
	// Skills 是 skills/ 两级分区扫描出的可用 skill 集（键为目录名即 id）。
	Skills map[string]SkillMeta
}

// SkillMeta 描述一个可用 skill：作用域（源目录位置决定）与源目录绝对路径。
type SkillMeta struct {
	Scope string // "project"（skills/<id>/）| "user"（skills/user/<id>/）
	Dir   string // 源目录绝对路径
}
```

③ `Load` 接线（函数开头建 `reg` 后、文件循环前）与循环内校验：

```go
func Load(dir, baseDir string) *Registry {
	reg := &Registry{Actions: map[string]LoadedAction{}}
	skills, skillErrs := loadSkills(baseDir)
	reg.Skills = skills
	reg.Errors = append(reg.Errors, skillErrs...)
	files, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	// ……原有代码不变，仅在 Validate(def) 通过后、写入 Actions 前插入：
		if err := validateSkillRefs(def, skills); err != nil {
			reg.Errors = append(reg.Errors, FileError{File: filepath.Base(f), Error: err.Error()})
			continue
		}
	// ……
}
```

`Validate` 的 `if def.Command.LLM.Prompt != ""` 块末尾追加（schema 级，api 编辑校验路径同样覆盖）：

```go
		for _, id := range def.Command.LLM.Skills {
			if !idPattern.MatchString(id) {
				return fmt.Errorf("command.llm.skills[%q] 必须匹配 ^[a-z0-9-]+$", id)
			}
		}
```

文件末尾新增两个函数：

```go
// loadSkills 扫描 baseDir/skills 两级分区：根目录（user/ 除外）= project 级，
// skills/user/ = user 级。子目录含 SKILL.md 才收录；frontmatter 不解析
// （name/description 本期无消费方，id 即目录名，坏 frontmatter 无法定义故不判）。
// 跨级同名 id 视为冲突，报 FileError。
func loadSkills(baseDir string) (map[string]SkillMeta, []FileError) {
	skills := map[string]SkillMeta{}
	var errs []FileError
	root := filepath.Join(baseDir, "skills")
	addScope := func(dir, scope string) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return // 目录不存在：无 skill，正常
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			name := e.Name()
			if scope == "project" && name == "user" {
				continue // user 分区由第二次调用扫
			}
			skillDir := filepath.Join(dir, name)
			if _, err := os.Stat(filepath.Join(skillDir, "SKILL.md")); err != nil {
				continue // 无 SKILL.md 宽松跳过
			}
			if _, exists := skills[name]; exists {
				errs = append(errs, FileError{File: "skills/" + name,
					Error: fmt.Sprintf("跨级同名 skill id %q 冲突（project 与 user 分区并存）", name)})
				continue
			}
			skills[name] = SkillMeta{Scope: scope, Dir: skillDir}
		}
	}
	addScope(root, "project")
	addScope(filepath.Join(root, "user"), "user")
	return skills, errs
}

// validateSkillRefs 校验动作引用的 skill id 都在可用集内（加载级，需 skills 扫描结果）。
func validateSkillRefs(def *ActionDef, skills map[string]SkillMeta) error {
	for _, id := range def.Command.LLM.Skills {
		if _, ok := skills[id]; !ok {
			return fmt.Errorf("command.llm.skills 引用的 skill %q 不存在于 skills/ 目录", id)
		}
	}
	return nil
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd C:/Users/ASUS/Documents/workflow-tool && go test ./internal/registry -v`
Expected: 全部 PASS（含既有测试无回归）

- [ ] **Step 5: 提交**

```bash
cd C:/Users/ASUS/Documents/workflow-tool && git add internal/registry/registry.go internal/registry/skills_test.go && git commit -m "feat(registry): skills 两级分区扫描与 llm.skills 引用校验"
```

---

### Task 2: SyncSkills 同步算法

**Files:**
- Create: `internal/actionrun/skillsync.go`
- Test: `internal/actionrun/skillsync_test.go`

**Interfaces:**
- Produces: `SyncItem{ID, Scope, SrcDir, DstDir string}`、`SyncReport{Synced, Skipped []SyncItem; Warnings []string}`、`SyncSkills(items []SyncItem) (SyncReport, error)`、`(SyncReport) Lines() []string`——Task 3/4/5 依赖

- [ ] **Step 1: 写失败测试**

`internal/actionrun/skillsync_test.go`：

```go
package actionrun

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// makeSkillDir 造一个含多文件的 skill 目录，files 为「相对路径→内容」。
func makeSkillDir(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for rel, content := range files {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func readAll(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		data, _ := os.ReadFile(p)
		out[filepath.ToSlash(rel)] = string(data)
		return nil
	})
	return out
}

func TestSyncSkillsFourCases(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()
	srcSkill := filepath.Join(src, "demo")
	dstSkill := filepath.Join(dst, "demo")

	// 情况 1：全新同步（含子目录附属文件）
	makeSkillDir(t, srcSkill, map[string]string{
		"SKILL.md":        "# v1",
		"refs/guide.md":   "guide",
	})

	rep, err := SyncSkills([]SyncItem{{ID: "demo", Scope: "project", SrcDir: srcSkill, DstDir: dstSkill}})
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Synced) != 1 || len(rep.Skipped) != 0 {
		t.Fatalf("全新同步应 synced=1, got %+v", rep)
	}
	if got := readAll(t, dstSkill); len(got) != 2 || got["SKILL.md"] != "# v1" {
		t.Fatalf("目标内容不符: %+v", got)
	}

	// 情况 2：一致跳过
	rep, err = SyncSkills([]SyncItem{{ID: "demo", Scope: "project", SrcDir: srcSkill, DstDir: dstSkill}})
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Skipped) != 1 || len(rep.Synced) != 0 {
		t.Fatalf("二次同步应 skipped=1, got %+v", rep)
	}

	// 情况 3：内容变更覆盖
	makeSkillDir(t, srcSkill, map[string]string{"SKILL.md": "# v2"})
	rep, err = SyncSkills([]SyncItem{{ID: "demo", Scope: "project", SrcDir: srcSkill, DstDir: dstSkill}})
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Synced) != 1 {
		t.Fatalf("变更应 synced=1, got %+v", rep)
	}
	if got := readAll(t, dstSkill); got["SKILL.md"] != "# v2" {
		t.Fatalf("覆盖失败: %q", got["SKILL.md"])
	}

	// 情况 4：目标多余文件删除（源里没有 refs/ 了）
	if err := os.Remove(filepath.Join(srcSkill, "refs", "guide.md")); err != nil {
		t.Fatal(err)
	}
	rep, err = SyncSkills([]SyncItem{{ID: "demo", Scope: "project", SrcDir: srcSkill, DstDir: dstSkill}})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := readAll(t, dstSkill)["refs/guide.md"]; ok {
		t.Fatal("目标多余文件应被删除")
	}

	// 报告行格式
	lines := rep.Lines()
	if len(lines) == 0 || !strings.Contains(lines[0], "[skill-sync] demo(project)") {
		t.Fatalf("报告行格式不符: %v", lines)
	}
}

func TestSyncSkillsSourceMissing(t *testing.T) {
	rep, err := SyncSkills([]SyncItem{{ID: "ghost", Scope: "project",
		SrcDir: filepath.Join(t.TempDir(), "ghost"), DstDir: filepath.Join(t.TempDir(), "d")}})
	if err == nil {
		t.Fatalf("源目录被删（含 SKILL.md 的目录整体不在）应报错, got %+v", rep)
	}
}
```

注意：情况 4 中源目录 `refs/` 空目录仍在——`syncOneDir` 的 walk 只收文件，空目录不产生条目，目标 `refs/guide.md` 相对路径不在源文件集内即被删，行为正确。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd C:/Users/ASUS/Documents/workflow-tool && go test ./internal/actionrun -run TestSyncSkills -v`
Expected: 编译失败（`SyncSkills`/`SyncItem` 未定义）

- [ ] **Step 3: 实现 `internal/actionrun/skillsync.go`**

```go
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd C:/Users/ASUS/Documents/workflow-tool && go test ./internal/actionrun -run TestSyncSkills -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd C:/Users/ASUS/Documents/workflow-tool && git add internal/actionrun/skillsync.go internal/actionrun/skillsync_test.go && git commit -m "feat(actionrun): SyncSkills 源为准比对覆盖同步算法"
```

---

### Task 3: SkillRouter 路由与足迹账本

**Files:**
- Create: `internal/actionrun/skillrouter.go`
- Test: `internal/actionrun/skillrouter_test.go`

**Interfaces:**
- Consumes: `registry.SkillMeta`（Task 1）、`SyncItem`/`SyncReport`（Task 2）
- Produces: `SkillRouter{Skills func() map[string]registry.SkillMeta; HomeDir func() string; LedgerPath string}`、`(*SkillRouter) Route(ids []string, agentCwd, cli string) ([]SyncItem, SyncReport, error)`、`(*SkillRouter) Record(items []SyncItem) error`——Task 5 依赖

- [ ] **Step 1: 写失败测试**

`internal/actionrun/skillrouter_test.go`：

```go
package actionrun

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"workflow-tool/internal/registry"
)

// newTestRouter 造一个全注入的 router：skills 固定集、home=tmp、账本在 tmp 下。
func newTestRouter(t *testing.T, skills map[string]registry.SkillMeta) (*SkillRouter, string) {
	t.Helper()
	home := t.TempDir()
	ledger := filepath.Join(t.TempDir(), "skills.synced.json")
	return &SkillRouter{
		Skills:     func() map[string]registry.SkillMeta { return skills },
		HomeDir:    func() string { return home },
		LedgerPath: ledger,
	}, home
}

func TestRouteScopesAndCwdFallback(t *testing.T) {
	skills := map[string]registry.SkillMeta{
		"bug-analyze": {Scope: "project", Dir: `/src/skills/bug-analyze`},
		"git-style":   {Scope: "user", Dir: `/src/skills/user/git-style`},
	}
	router, home := newTestRouter(t, skills)
	agentCwd := `D:\proj`

	items, rep, err := router.Route([]string{"bug-analyze", "git-style"}, agentCwd, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Warnings) != 0 {
		t.Fatalf("ducc 默认 CLI 不应警告: %v", rep.Warnings)
	}
	if len(items) != 2 {
		t.Fatalf("应产出 2 条, got %+v", items)
	}
	if items[0].DstDir != filepath.Join(agentCwd, ".claude", "skills", "bug-analyze") {
		t.Fatalf("project 级目标不符: %s", items[0].DstDir)
	}
	if items[1].DstDir != filepath.Join(home, ".claude", "skills", "git-style") {
		t.Fatalf("user 级目标不符: %s", items[1].DstDir)
	}

	// cwd 为空：不传 agentCwd（空串）应报错？不——空由 Build 兜底 BaseDir 后传入，
	// Route 收到的恒非空；这里验证 cli 大小写归一。
	items, _, err = router.Route([]string{"bug-analyze"}, agentCwd, "Claude")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(items[0].DstDir, ".claude") {
		t.Fatalf("Claude 大小写归一后应命中 claude 条目: %s", items[0].DstDir)
	}
}

func TestRouteCodexDualRoot(t *testing.T) {
	skills := map[string]registry.SkillMeta{
		"x": {Scope: "project", Dir: `/src/skills/x`},
	}
	router, _ := newTestRouter(t, skills)

	items, _, err := router.Route([]string{"x"}, `D:\p`, "codex")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("codex 双根应产出 2 条, got %+v", items)
	}
	if !strings.Contains(items[0].DstDir, ".codex") || !strings.Contains(items[1].DstDir, ".agents") {
		t.Fatalf("codex 双根目标不符: %+v", items)
	}
}

func TestRouteUnknownCLIFallback(t *testing.T) {
	skills := map[string]registry.SkillMeta{
		"x": {Scope: "project", Dir: `/src/skills/x`},
	}
	router, _ := newTestRouter(t, skills)

	items, rep, err := router.Route([]string{"x"}, `D:\p`, "somecc")
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Warnings) != 1 || !strings.Contains(rep.Warnings[0], "somecc") {
		t.Fatalf("未知 CLI 应有一条警告: %v", rep.Warnings)
	}
	if !strings.Contains(items[0].DstDir, ".claude") {
		t.Fatalf("未知 CLI 应回退 .claude/skills: %s", items[0].DstDir)
	}
}

func TestRouteMissingSkillErrors(t *testing.T) {
	router, _ := newTestRouter(t, map[string]registry.SkillMeta{})
	if _, _, err := router.Route([]string{"ghost"}, `D:\p`, ""); err == nil {
		t.Fatal("源缺失应报错（动作失败）")
	}
}

func TestRecordLedgerSelfClean(t *testing.T) {
	skills := map[string]registry.SkillMeta{
		"x": {Scope: "project", Dir: `/src/skills/x`},
	}
	router, _ := newTestRouter(t, skills)

	items := []SyncItem{
		{ID: "x", Scope: "project", SrcDir: `/src/skills/x`, DstDir: `D:\p\.claude\skills\x`},
		{ID: "y", Scope: "user", SrcDir: `/src/skills/user/y`, DstDir: `C:\h\.claude\skills\y`}, // y 不在源
	}
	if err := router.Record(items); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(router.LedgerPath)
	if err != nil {
		t.Fatal(err)
	}
	var ledger map[string][]string
	if err := json.Unmarshal(data, &ledger); err != nil {
		t.Fatal(err)
	}
	if len(ledger) != 1 {
		t.Fatalf("陈旧条目应被自洁，只剩 1 个根: %+v", ledger)
	}
	key := filepath.Dir(filepath.Clean(`D:\p\.claude\skills\x`))
	if got := ledger[key]; len(got) != 1 || got[0] != "x" {
		t.Fatalf("账本内容不符: %v", got)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd C:/Users/ASUS/Documents/workflow-tool && go test ./internal/actionrun -run TestRoute -v`
Expected: 编译失败（`SkillRouter` 未定义）

- [ ] **Step 3: 实现 `internal/actionrun/skillrouter.go`**

```go
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
func (r *SkillRouter) Record(items []SyncItem) error {
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd C:/Users/ASUS/Documents/workflow-tool && go test ./internal/actionrun -run 'TestRoute|TestRecord' -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd C:/Users/ASUS/Documents/workflow-tool && git add internal/actionrun/skillrouter.go internal/actionrun/skillrouter_test.go && git commit -m "feat(actionrun): SkillRouter CLI 路由表分流与足迹账本"
```

---

### Task 4: LLMRunner 报告行 emit

**Files:**
- Modify: `internal/runner/llm_runner.go`（`LLMConfig` 两字段 + `Run` 开头 emit）
- Test: `internal/runner/llm_runner_test.go`（追加用例）

**Interfaces:**
- Consumes: 报告行为 `[]string`（Task 2 的 `Lines()` 输出）
- Produces: `LLMConfig.SkillSyncReport []string`、`LLMConfig.SkillSyncWarnings []string`——Task 5 依赖

- [ ] **Step 1: 写失败测试**

`internal/runner/llm_runner_test.go` 末尾追加（沿用该文件既有的 emit 收集辅助；若已有 `collectEmits` 之类辅助则复用，否则按下述内联收集）：

```go
func TestLLMRunnerEmitsSkillSyncReportFirst(t *testing.T) {
	var got []string
	emit := func(stream, line string) { got = append(got, stream+":"+line) }

	r := &LLMRunner{Cfg: LLMConfig{
		Prompt:            "hi",
		CLI:               "definitely-no-such-cli", // 不存在的 CLI：子进程必然启动失败，
		// 但报告行应在任何失败路径之前 emit
		SkillSyncReport:   []string{"[skill-sync] demo(project) → D:\\p\\.claude\\skills\\demo"},
		SkillSyncWarnings: []string{"[skill-sync] 未知 CLI 回退"},
	}}
	res := r.Run(context.Background(), map[string]any{}, emit)

	// CLI 启动失败无任何子进程输出，收集器里应恰有手动注入的 2 行且顺序固定：
	// 警告（stderr）在前、报告（stdout）在后。
	if len(got) != 2 || got[0] != "stderr:[skill-sync] 未知 CLI 回退" || got[1] != "stdout:[skill-sync] demo(project) → D:\\p\\.claude\\skills\\demo" {
		t.Fatalf("报告行应最先 emit: %v", got)
	}
	if res.Stdout != "" {
		t.Fatalf("报告行不得进 Result.Stdout: %q", res.Stdout)
	}
}
```

（若现有测试文件的 import 缺 `context` 则补。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd C:/Users/ASUS/Documents/workflow-tool && go test ./internal/runner -run TestLLMRunnerEmitsSkillSync -v`
Expected: 编译失败（字段未定义）

- [ ] **Step 3: 实现**

`LLMConfig` 结构体 `Builtins` 字段前追加：

```go
	// SkillSyncReport 是 Build 层注入的 [skill-sync] 报告行，Run 开头最先以
	// stdout 流 emit（进输出面板）；不经 CLI 输出解析，不进 Result.Stdout。
	SkillSyncReport []string
	// SkillSyncWarnings 是同步警告行（未知 CLI 回退、账本写失败），stderr 流。
	SkillSyncWarnings []string
```

`Run` 方法内、`cfg := r.Cfg` 的 Prompt 空检查**之前**插入（报告行先于一切失败路径）：

```go
	if emit != nil {
		for _, w := range cfg.SkillSyncWarnings {
			emit("stderr", w)
		}
		for _, l := range cfg.SkillSyncReport {
			emit("stdout", l)
		}
	}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd C:/Users/ASUS/Documents/workflow-tool && go test ./internal/runner -v`
Expected: 全部 PASS（含既有 LLM 用例无回归）

- [ ] **Step 5: 提交**

```bash
cd C:/Users/ASUS/Documents/workflow-tool && git add internal/runner/llm_runner.go internal/runner/llm_runner_test.go && git commit -m "feat(runner): LLMRunner 开头 emit skill 同步报告行"
```

---

### Task 5: Build 接线与 api 两路径适配

**Files:**
- Modify: `internal/actionrun/build.go`（`Build`/`buildLLM` 签名改 `(runner.Runner, error)`；`Deps.SkillRouter`；同步接线）
- Modify: `internal/actionrun/build_test.go`（既有 Build 调用适配 + 新增 LLM skills 接线用例）
- Modify: `internal/api/api.go:70`（runDeps 构造 SkillRouter）
- Modify: `internal/api/run.go:113`、`internal/api/workflows.go:172`（错误适配）

**Interfaces:**
- Consumes: Task 1 的 `registry.SkillMeta`/`Skills`；Task 2 的 `SyncSkills`/`SyncReport.Lines()`；Task 3 的 `SkillRouter.Route/Record`；Task 4 的 `LLMConfig.SkillSyncReport/SkillSyncWarnings`
- Produces: `actionrun.Build(ctx, la, deps, opts) (runner.Runner, error)`；`Deps.SkillRouter *SkillRouter`

- [ ] **Step 1: 写失败测试**

`internal/actionrun/build_test.go` 追加（并先把该文件里既有 `Build(...)` 单值接收改为 `r, err := Build(...)`，`_ = err` 或断言 nil——既有用例全部适配）：

```go
func TestBuildLLMSkillSyncWiring(t *testing.T) {
	base := t.TempDir() // 充当 BaseDir（= agent-cwd 兜底值）
	src := filepath.Join(base, "skills", "demo")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "SKILL.md"), []byte("# demo"), 0o644); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	dst := filepath.Join(home, ".claude", "skills", "demo") // user 级落 home

	la := registry.LoadedAction{Def: registry.ActionDef{ID: "a", Title: "a", Command: registry.Command{
		LLM: registry.LLMCommand{Prompt: "p", Skills: []string{"demo-user"}}}}}
	// 造 user 级 skill 元数据（registry 包外手写，验证 Build 只消费 router 输出）
	skills := map[string]registry.SkillMeta{"demo-user": {Scope: "user", Dir: src}}
	router := &SkillRouter{
		Skills:     func() map[string]registry.SkillMeta { return skills },
		HomeDir:    func() string { return home },
		LedgerPath: filepath.Join(t.TempDir(), "skills.synced.json"),
	}
	deps := Deps{BaseDir: base, SkillRouter: router}

	r, err := Build(context.Background(), la, deps, Options{Params: map[string]any{"p": "hi"}})
	if err != nil {
		t.Fatal(err)
	}
	lr, ok := r.(*runner.LLMRunner)
	if !ok {
		t.Fatalf("应构造 LLMRunner, got %T", r)
	}
	if len(lr.Cfg.SkillSyncReport) == 0 {
		t.Fatal("报告行应注入 LLMConfig")
	}
	if data, err := os.ReadFile(filepath.Join(dst, "SKILL.md")); err != nil || string(data) != "# demo" {
		t.Fatalf("user 级目标未落盘: %v", err)
	}
	// cwd 兜底：LLM.Cwd 空时 agent-cwd 用 BaseDir——本用例走 user 级不依赖它，
	// project 级兜底由 Route 的调用点保证（buildLLM 内 cwd=="" → deps.BaseDir）。
}

func TestBuildLLMSkillSyncFailureFails(t *testing.T) {
	router := &SkillRouter{
		Skills:     func() map[string]registry.SkillMeta { return map[string]registry.SkillMeta{} },
		HomeDir:    func() string { return t.TempDir() },
		LedgerPath: filepath.Join(t.TempDir(), "skills.synced.json"),
	}
	la := registry.LoadedAction{Def: registry.ActionDef{ID: "a", Title: "a", Command: registry.Command{
		LLM: registry.LLMCommand{Prompt: "p", Skills: []string{"ghost"}}}}}
	if _, err := Build(context.Background(), la, Deps{BaseDir: t.TempDir(), SkillRouter: router},
		Options{Params: map[string]any{"p": "hi"}}); err == nil {
		t.Fatal("skill 同步失败应使 Build 返回 error（动作失败）")
	}
}
```

（import 需补 `context`/`os`/`path/filepath`/`workflow-tool/internal/registry`/`workflow-tool/internal/runner`——以文件现有 import 为准增删。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd C:/Users/ASUS/Documents/workflow-tool && go test ./internal/actionrun -run TestBuildLLMSkillSync -v`
Expected: 编译失败（`Deps.SkillRouter` 未定义、Build 单返回值）

- [ ] **Step 3: 实现 build.go**

① `Deps` 加字段（`BashPath` 后）：

```go
	BashPath  func() string         // config.yaml BASH_PATH 惰性读取（bash/sh 解析级联第一优先），nil = 无覆盖
	// SkillRouter 集中维护 skill 同步路径映射与足迹账本（nil = 不支持 skill 同步，
	// 仅测试场景；声明了 skills 且 router 为 nil 时 Build 报错）。
	SkillRouter *SkillRouter
```

② `Build` 签名与三分支：

```go
// Build 按 LoadedAction 的 command 形态构造对应 Runner。
// registry.Validate 已保证四选一互斥，default 分支即 shell/script 形态。
// LLM 形态绑定了 skills 时先执行同步（失败即返回 error，动作失败）。
func Build(ctx context.Context, la registry.LoadedAction, deps Deps, opts Options) (runner.Runner, error) {
	capture := la.Def.Command.CaptureOutput
	if opts.CaptureOverride != nil {
		capture = opts.CaptureOverride
	}
	switch {
	case la.Def.Command.Adb.Operation != "":
		return &adb.ADBRunner{
			Operation:    la.Def.Command.Adb.Operation,
			Timeout:      la.Timeout,
			Dev:          deps.ADBDevice,
			ResolvePaths: deps.ADBPaths,
			Control:      opts.ADBControl,
			Builtins:     deps.Builtins,
		}, nil
	case la.Def.Command.LLM.Prompt != "":
		return buildLLM(ctx, la, deps, opts)
	default:
		return &runner.ShellRunner{Cfg: runner.ShellConfig{
			Run:           la.Def.Command.Run,
			Script:        la.Def.Command.Script,
			Shell:         la.Def.Command.Shell,
			BashPath:      bashPathOf(deps),
			Cwd:           la.Cwd, // raw，由 ShellRunner 用 params 替换
			Timeout:       la.Timeout,
			Env:           mergeEnv(la.Def.Command.Env, opts.ExtraEnv),
			BaseDir:       deps.BaseDir,
			CaptureOutput: capture,
			Builtins:      deps.Builtins,
		}}, nil
	}
}
```

③ `buildLLM` 重写（同步接线）：

```go
// buildLLM 按 command.llm 声明的 param id 从 params 取终值构造 LLMRunner。
// CLI 名空时由 LLMRunner 内部取默认（ducc）。绑定了 skills 时先路由+同步：
// agent-cwd 用展开后的 Cwd（空则 BaseDir 兜底，与 registry 扫描同源），
// 同步失败返回 error（动作失败）；账本 Record 失败降级为警告行。
func buildLLM(ctx context.Context, la registry.LoadedAction, deps Deps, opts Options) (runner.Runner, error) {
	cmd := la.Def.Command.LLM
	cwd := runner.Expand(ctx, la.Cwd, opts.Params, deps.Builtins)
	if cwd == "" {
		cwd = deps.BaseDir // 显式兜底，不依赖子进程「继承父进程 cwd」的隐式语义
	}
	cfg := runner.LLMConfig{
		CLI:          strOf(opts.Params, "LLM_CLI"),
		SystemPrompt: strOf(opts.Params, cmd.System),
		Prompt:       strOf(opts.Params, cmd.Prompt),
		Resume:       strings.TrimSpace(strOf(opts.Params, cmd.Resume)),
		// LLMRunner 不做 ${VAR} 替换，Cwd 在这里展开成终值（与 Shell 形态传 raw 不同）。
		Cwd:      cwd,
		Timeout:  la.Timeout,
		Env:      mergeEnv(la.Def.Command.Env, opts.ExtraEnv),
		Builtins: deps.Builtins,
	}
	if len(cmd.Skills) > 0 {
		if deps.SkillRouter == nil {
			return nil, fmt.Errorf("动作绑定了 command.llm.skills 但 SkillRouter 未注入")
		}
		items, routeReport, err := deps.SkillRouter.Route(cmd.Skills, cwd, cfg.CLI)
		if err != nil {
			return nil, err
		}
		syncReport, err := SyncSkills(items)
		if err != nil {
			return nil, err
		}
		if err := deps.SkillRouter.Record(items); err != nil {
			syncReport.Warnings = append(syncReport.Warnings,
				fmt.Sprintf("[skill-sync] 足迹账本写入失败（不影响本次同步）: %v", err))
		}
		cfg.SkillSyncReport = syncReport.Lines()
		cfg.SkillSyncWarnings = append(routeReport.Warnings, syncReport.Warnings...)
	}
	return &runner.LLMRunner{Cfg: cfg}, nil
}
```

（Route 不产 synced/skipped，报告行统一来自 syncReport；警告行先路由层后同步层，`append(nil, ...)` 两边皆空时结果为 nil，无害。）

④ api 三处适配：

`internal/api/api.go:70` 替换为：

```go
	svc.runDeps = actionrun.Deps{BaseDir: baseDir, ADBPaths: svc.binPaths, ADBDevice: svc.dev, Builtins: svc.builtins, BashPath: svc.bashOverride,
		SkillRouter: &actionrun.SkillRouter{
			// 惰性取当前 registry（热重载后 Skills 随之更新）
			Skills:  func() map[string]registry.SkillMeta { return svc.reg.Skills },
			HomeDir: func() string { h, _ := os.UserHomeDir(); return h },
			LedgerPath: filepath.Join(baseDir, "skills.synced.json"),
		}}
```

（该文件 import 需补 `os`、`path/filepath`，以现有 import 为准。）

`internal/api/run.go:113` 替换为：

```go
	r, err := actionrun.Build(ctx, la, s.runDeps, actionrun.Options{Params: params, ADBControl: ctrl})
	if err != nil {
		ev.DoneUnordered(-1, err.Error(), 0)
		return
	}
	res := r.Run(ctx, params, ev.EmitFunc())
```

`internal/api/workflows.go:172` 替换为：

```go
		r, err := actionrun.Build(req.Ctx, la, s.runDeps, actionrun.Options{
			Params:          runParams,
			ExtraEnv:        expandedEnv,
			CaptureOverride: req.CaptureOutput,
		})
		if err != nil {
			req.Emit("stderr", err.Error())
			return runner.Result{ExitCode: -1, Err: err,
				Outputs: map[string]string{"exit_code": "-1", "success": "false"}}
		}
		return r.Run(req.Ctx, runParams, req.Emit)
```

- [ ] **Step 4: 跑测试与编译**

Run: `cd C:/Users/ASUS/Documents/workflow-tool && go build ./... && go test ./internal/actionrun ./internal/registry ./internal/runner ./internal/api -v`
Expected: 编译通过，全部 PASS（`build_test.go` 既有用例已适配双返回值）

- [ ] **Step 5: 提交**

```bash
cd C:/Users/ASUS/Documents/workflow-tool && git add internal/actionrun/build.go internal/actionrun/build_test.go internal/api/api.go internal/api/run.go internal/api/workflows.go && git commit -m "feat(actionrun): Build 接线 skill 同步，失败即动作失败，api 两路径适配"
```

---

### Task 6: 文档、demo 资产与全量验证

**Files:**
- Modify: `docs/action.md`（`command.llm` 章节增 `skills` 字段）
- Modify: `CLAUDE.md`（架构小节 LLM 域提一句 + 动作 YAML 小节提 `skills` 可选字段）
- Modify: `.gitignore`（追加 `skills.synced.json`）
- Create: `skills/demo-skill/SKILL.md`、`actions/demo-llm-skill.yaml`（真机验收资产，对齐 demo-* 命名）

**Interfaces:** 无代码接口；产出为文档与验收资产。

- [ ] **Step 1: 建 demo 资产**

`skills/demo-skill/SKILL.md`：

```markdown
---
name: demo-skill
description: 演示 skill 同步机制的最小样例
---

# demo-skill

你是演示助手。收到任何问题时，先复述一遍本 skill 的名字（demo-skill）
确认已被加载，再回答问题。
```

`actions/demo-llm-skill.yaml`：

```yaml
id: demo-llm-skill
title: LLM Skill 同步演示
icon: hi:ai-magic
command:
  llm:
    prompt: user_prompt
    skills:
      - demo-skill
params:
  - id: user_prompt
    label: 提问
    type: textarea
```

（`hi:ai-magic` 若不在 `frontend/src/components/ActionIcon.tsx` 注册表中，换任一已注册 key 或删除 icon 行——执行时以注册表为准。）

- [ ] **Step 2: 改 `.gitignore`**

追加一行：

```
skills.synced.json
```

- [ ] **Step 3: 改 `docs/action.md`**

`command.llm`（LLM 域形态）章节的 `resume` 字段说明后追加：

```markdown
#### `skills`（可选，string[]）

绑定的 skill id 列表。运行前把 exe 同级 `skills/` 源目录中对应的 skill **整目录同步**到 Agent 目录（源为准：内容比对，不一致覆盖，目标多余文件删除；一致跳过），由 CLI 自行发现加载——**不在 prompt/system 层拼接任何内容**。

- 源目录两级分区，**位置即作用域**：`skills/<id>/` = project 级 → 同步到 `<cwd>/.claude/skills/<id>/`（`cwd` 展开后为空则用 exe 目录）；`skills/user/<id>/` = user 级 → 同步到 `~/.claude/skills/<id>/`（全局一次生效）
- 目标目录按 **CLI 路由表**（`config.yaml` 的 `LLM_CLI`）：`claude`/`ducc` → `.claude/skills`；`codex` → `.codex/skills` + `.agents/skills` 双根；未知 CLI 回退 `.claude/skills` 并输出警告
- id 命名 `^[a-z0-9-]+$`，两级合并单一命名空间，跨级同名加载时报冲突；引用不存在的 id 该动作加载失败
- 同步结果以 `[skill-sync]` 报告行出现在输出面板首行（如 `[skill-sync] demo-skill(project) → D:\proj\.claude\skills\demo-skill`）
- 同步目标写失败 = 动作失败（skill 是声明的依赖）；同步足迹记录在 exe 同级 `skills.synced.json`
```

- [ ] **Step 4: 改 `CLAUDE.md`**

架构小节「LLM 域」段末（`"llm" / "llm-thinking"` 句后）追加一句：

```
`command.llm.skills` 声明绑定的 skill 在 Build 期由 `actionrun.SkillRouter` 按「CLI 路由表 × 作用域（skills/ 根=project 随 cwd、skills/user/=user 落 home）」同步到 Agent 目录（源为准比对覆盖，足迹记 exe 同级 skills.synced.json），报告行由 LLMRunner.Run 开头 emit——文件即注册，零 prompt 拼接。
```

「动作 YAML」小节 `command.llm{system, prompt}` 一等形态描述处补：`skills`（可选，绑定的 skill id 列表，运行前同步到 Agent 目录，见 docs/action.md）。

- [ ] **Step 5: 全量验证**

Run: `cd C:/Users/ASUS/Documents/workflow-tool && go test ./... && go vet ./...`
Expected: 全部 PASS、无 vet 告警

- [ ] **Step 6: 真机验收（可选但推荐）**

Run: `cd C:/Users/ASUS/Documents/workflow-tool && bash deploy/build.sh`
然后运行 `workflow-tool.exe` → 执行「LLM Skill 同步演示」动作 → 验证：
1. 输出面板首行出现 `[skill-sync] demo-skill(project) → <exe目录>\.claude\skills\demo-skill`
2. `<exe目录>/.claude/skills/demo-skill/SKILL.md` 存在且内容与源一致
3. 再次运行出现 `[skill-sync] demo-skill(project) 已是最新，跳过`
4. 项目根生成 `skills.synced.json`（dev 验收时）

- [ ] **Step 7: 提交**

```bash
cd C:/Users/ASUS/Documents/workflow-tool && git add docs/action.md CLAUDE.md .gitignore skills/demo-skill/SKILL.md actions/demo-llm-skill.yaml && git commit -m "docs: llm.skills 字段文档与 demo 验收资产"
```
