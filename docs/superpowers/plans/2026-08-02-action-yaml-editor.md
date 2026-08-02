# Action.yaml 原文编辑器 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在右栏顶部标题栏点击进入编辑视图，通过 Select 切换并直接编辑某个 Action 的 `actions/*.yaml` 原文，保存即写盘热重载。

**Architecture:** 后端 `registry` 导出 `ParseAction`/`Validate` 并在 `LoadedAction` 记录源文件路径；`api.Service` 新增 `GetActionYaml`/`SetActionYaml`（校验→写盘→整体 Reload→返回新列表）。前端 `ActionRunnerProvider` 加 `"edit"` 视图与两个封装方法；新组件 `ActionYamlEditor` 用 `Select` + 等宽 `Textarea` 编辑原文；`OutputToolbar` 标题改为可点击入口。

**Tech Stack:** Go（Wails v3 alpha2.119）、`gopkg.in/yaml.v3`；React 19 + TS、base-ui `Select`、shadcn `Textarea`/`Button`/`Alert`、react-i18next、vitest。

## Global Constraints

- 锁定 Wails `v3.0.0-alpha2.119`（CLI 与库同版本），**不要升到 alpha.3**。
- 改 `internal/api/api.go` 的 Service 方法后，**必须** `wails3 generate bindings` → `npm run build` → `go build`，否则前端报 "method ID not found"。
- 前端静态文案只改 `frontend/src/i18n/locales/{zh,en}.json`；action 的 title/description 与后端 stdout/stderr 不参与 i18n。
- 前端测试查中文文案（先 `i18n.changeLanguage("zh")`）。
- action `id` 必须匹配 `^[a-z0-9-]+$`；`command.shell` 与 `command.script` 互斥；`command.stream` 只允许 `""` 或 `"llm"`。
- base-ui `Select` 在 jsdom 下 portal 交互不可靠（同 `ParamForm.test` 对 MODE 字段的处理）——单测不覆盖 Select 打开/选择交互，该路径靠联调验证。
- 提交信息用中文，`feat:`/`test:` 前缀，末尾附 `Co-Authored-By: Claude <noreply@anthropic.com>`。

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `internal/registry/registry.go` | 记录源文件路径；导出解析/校验 | Modify |
| `internal/registry/registry_test.go` | File/ParseAction/Validate 单测 | Modify |
| `internal/api/api.go` | GetActionYaml/SetActionYaml/Reload/buildListResult | Modify |
| `internal/api/api_test.go` | 读写 yaml 单测 | Modify |
| `frontend/bindings/.../api/service.js` | 自动生成的绑定 | Regenerate |
| `frontend/src/context/ActionRunnerProvider.tsx` | view 加 "edit" + getActionYaml/saveActionYaml | Modify |
| `frontend/src/context/ActionRunnerProvider.test.tsx` | mock + saveActionYaml 刷新测试 | Modify |
| `frontend/src/components/OutputToolbar.tsx` | 标题可点击入口 | Modify |
| `frontend/src/components/OutputPanel.tsx` | edit 分支 | Modify |
| `frontend/src/components/ActionYamlEditor.tsx` | Select + Textarea 编辑器 | Create |
| `frontend/src/components/ActionYamlEditor.test.tsx` | 编辑器单测 | Create |
| `frontend/src/components/OutputPanel.test.tsx` | mock + 入口测试 | Modify |
| `frontend/src/i18n/locales/{zh,en}.json` | edit.* 文案 | Modify |

---

## Task 1: registry 记录源文件路径 + 导出 ParseAction/Validate

**Files:**
- Modify: `internal/registry/registry.go`
- Modify: `internal/registry/registry_test.go`

**Interfaces:**
- Produces: `registry.LoadedAction.File string`（源文件绝对路径）；`registry.ParseAction(data []byte) (*ActionDef, error)`；`registry.Validate(def *ActionDef) error`。供 Task 2 的 `api.Service` 调用。

- [ ] **Step 1: 写失败测试（追加到 registry_test.go 末尾）**

```go
func TestLoadRecordsSourceFile(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.yaml", `id: a
title: A
command:
  shell: echo hi
`)
	reg := Load(dir, dir)
	la := reg.Actions["a"]
	if la.File == "" {
		t.Fatal("Load 应在 LoadedAction.File 记录源文件路径")
	}
	if filepath.Base(la.File) != "a.yaml" {
		t.Fatalf("File 应指向 a.yaml，got %q", la.File)
	}
}

func TestParseActionExported(t *testing.T) {
	def, err := ParseAction([]byte("id: a\ntitle: A\ncommand:\n  shell: echo\n"))
	if err != nil {
		t.Fatal(err)
	}
	if def.ID != "a" || def.Title != "A" {
		t.Fatalf("ParseAction 解析错误: %+v", def)
	}
}

func TestValidateExported(t *testing.T) {
	legal := &ActionDef{ID: "a", Title: "A", Command: Command{Shell: "echo"}}
	if err := Validate(legal); err != nil {
		t.Fatalf("合法定义不应报错: %v", err)
	}
	bad := &ActionDef{ID: "Bad ID"}
	if err := Validate(bad); err == nil {
		t.Fatal("非法 id 应被 Validate 拒绝")
	}
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `go test ./internal/registry -run "TestLoadRecordsSourceFile|TestParseActionExported|TestValidateExported" -v`
Expected: FAIL（`la.File` 为空；`ParseAction`/`Validate` 未定义）。

- [ ] **Step 3: 改 registry.go —— LoadedAction 加 File 字段**

```go
// LoadedAction 是已校验、字段已解析的动作。
type LoadedAction struct {
	Def     ActionDef
	Timeout time.Duration
	Cwd     string // raw，运行时由 runner 用 params 替换
	File    string // 源文件绝对路径（编辑器读写锚点）
}
```

- [ ] **Step 4: 改 registry.go —— Load 循环里记录 File**

把 `reg.Actions[def.ID] = LoadedAction{...}` 块改为（加 `File: f`，`f` 是 glob 出的全路径）：

```go
		reg.Actions[def.ID] = LoadedAction{
			Def:     *def,
			Timeout: parseTimeout(def.Command.Timeout),
			Cwd:     def.Command.Cwd, // raw，未替换
			File:    f,               // 源文件路径，供编辑器定位
		}
```

- [ ] **Step 5: 改 registry.go —— 拆出导出的 ParseAction，parseFile 复用它**

把现有 `parseFile` 替换为：

```go
func parseFile(path string) (*ActionDef, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ParseAction(data)
}

// ParseAction 解析 yaml 字节为 ActionDef（供 api 层编辑后校验复用）。
func ParseAction(data []byte) (*ActionDef, error) {
	var def ActionDef
	if err := yaml.Unmarshal(data, &def); err != nil {
		return nil, err
	}
	return &def, nil
}
```

- [ ] **Step 6: 改 registry.go —— validate 改名为导出的 Validate**

把 `func validate(def *ActionDef) error {` 改为 `func Validate(def *ActionDef) error {`，并把 Load 里调用处 `if err := validate(def); err != nil {` 改为 `if err := Validate(def); err != nil {`。

- [ ] **Step 7: 运行全部 registry 测试**

Run: `go test ./internal/registry -v`
Expected: PASS（新测试通过，旧测试不受影响——`validate` 仅在 `Load` 内被调一处）。

- [ ] **Step 8: 提交**

```bash
git add internal/registry/registry.go internal/registry/registry_test.go
git commit -m "refactor(registry): 记录源文件路径并导出 ParseAction/Validate

为编辑器读写 action yaml 做准备：LoadedAction 增 File 字段，
拆出导出的 ParseAction，validate 升级为 Validate。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: api 新增 GetActionYaml / SetActionYaml + 重载

**Files:**
- Modify: `internal/api/api.go`
- Modify: `internal/api/api_test.go`
- Regenerate: `frontend/bindings/workflow-tool/internal/api/service.js`（命令生成）

**Interfaces:**
- Consumes: `registry.ParseAction`、`registry.Validate`、`registry.Load`（Task 1 产物）。
- Produces: `Service.GetActionYaml(id string) (string, error)`；`Service.SetActionYaml(id string, text string) (ListResult, error)`；前端 bindings `GetActionYaml`/`SetActionYaml`（供 Task 3 import）。
- 约定：测试中 actions 文件须写在 `<dir>/actions/` 下（与生产 `baseDir/actions` 一致），因 `Reload` 用 `filepath.Join(s.baseDir, "actions")`。

- [ ] **Step 1: 写失败测试（追加到 api_test.go；顶部 import 加 `"strings"`）**

```go
func TestGetActionYamlReturnsRawWithComments(t *testing.T) {
	dir := t.TempDir()
	ad := filepath.Join(dir, "actions")
	os.Mkdir(ad, 0755)
	os.WriteFile(filepath.Join(ad, "a.yaml"), []byte("# 注释\nid: a\ntitle: A\ncommand:\n  shell: echo hi\n"), 0644)
	svc := New(registry.Load(ad, dir), dir, filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
	got, err := svc.GetActionYaml("a")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "# 注释") {
		t.Fatalf("应保留注释原文，got %q", got)
	}
}

func TestSetActionYamlValidWritesAndReloads(t *testing.T) {
	dir := t.TempDir()
	ad := filepath.Join(dir, "actions")
	os.Mkdir(ad, 0755)
	os.WriteFile(filepath.Join(ad, "a.yaml"), []byte("id: a\ntitle: A\ncommand:\n  shell: echo hi\n"), 0644)
	svc := New(registry.Load(ad, dir), dir, filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
	res, err := svc.SetActionYaml("a", "id: a\ntitle: 改名\ncommand:\n  shell: echo bye\n")
	if err != nil {
		t.Fatal(err)
	}
	if res.Actions[0].Title != "改名" {
		t.Fatalf("重载后应见新标题，got %+v", res.Actions[0])
	}
	persisted, _ := svc.GetActionYaml("a")
	if !strings.Contains(persisted, "改名") {
		t.Fatalf("应落盘，got %q", persisted)
	}
}

func TestSetActionYamlRejectsBadYAML(t *testing.T) {
	dir := t.TempDir()
	ad := filepath.Join(dir, "actions")
	os.Mkdir(ad, 0755)
	orig := "id: a\ntitle: A\ncommand:\n  shell: echo hi\n"
	os.WriteFile(filepath.Join(ad, "a.yaml"), []byte(orig), 0644)
	svc := New(registry.Load(ad, dir), dir, filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
	_, err := svc.SetActionYaml("a", "id: a\n  : : :\n")
	if err == nil {
		t.Fatal("非法 yaml 应报错")
	}
	got, _ := svc.GetActionYaml("a")
	if got != orig {
		t.Fatalf("非法时不该写盘，got %q", got)
	}
}

func TestSetActionYamlRejectsValidation(t *testing.T) {
	dir := t.TempDir()
	ad := filepath.Join(dir, "actions")
	os.Mkdir(ad, 0755)
	os.WriteFile(filepath.Join(ad, "a.yaml"), []byte("id: a\ntitle: A\ncommand:\n  shell: echo hi\n"), 0644)
	svc := New(registry.Load(ad, dir), dir, filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
	// 缺 title → Validate 失败
	_, err := svc.SetActionYaml("a", "id: a\ncommand:\n  shell: echo\n")
	if err == nil {
		t.Fatal("校验失败应报错")
	}
}

func TestSetActionYamlRejectsIDChange(t *testing.T) {
	dir := t.TempDir()
	ad := filepath.Join(dir, "actions")
	os.Mkdir(ad, 0755)
	orig := "id: a\ntitle: A\ncommand:\n  shell: echo hi\n"
	os.WriteFile(filepath.Join(ad, "a.yaml"), []byte(orig), 0644)
	svc := New(registry.Load(ad, dir), dir, filepath.Join(dir, "config.yaml"), filepath.Join(dir, "fragments.yaml"))
	_, err := svc.SetActionYaml("a", "id: b\ntitle: A\ncommand:\n  shell: echo\n")
	if err == nil {
		t.Fatal("改 id 应被拒绝")
	}
	got, _ := svc.GetActionYaml("a")
	if got != orig {
		t.Fatalf("改 id 被拒不该写盘，got %q", got)
	}
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `go test ./internal/api -run "TestGetActionYaml|TestSetActionYaml" -v`
Expected: FAIL（`svc.GetActionYaml` / `svc.SetActionYaml` 未定义，`strings` 未导入）。

- [ ] **Step 3: 改 api.go —— 抽 buildListResult，ListActions 复用**

把现有 `ListActions` 方法体替换为：

```go
// ListActions 返回全部已加载动作 + 加载错误。
func (s *Service) ListActions() ListResult {
	return s.buildListResult()
}

// buildListResult 从当前 registry 构造前端可见列表（ListActions 与 SetActionYaml 末尾共用）。
func (s *Service) buildListResult() ListResult {
	items := make([]ActionItem, 0, len(s.reg.Actions))
	for _, la := range s.reg.Actions {
		items = append(items, ActionItem{
			ID:          la.Def.ID,
			Title:       la.Def.Title,
			Icon:        la.Def.Icon,
			Description: la.Def.Description,
			Params:      la.Def.Params,
			Presets:     la.Def.Presets,
			Stream:      la.Def.Command.Stream,
		})
	}
	errs := make([]string, 0, len(s.reg.Errors))
	for _, e := range s.reg.Errors {
		errs = append(errs, fmt.Sprintf("%s: %s", e.File, e.Error))
	}
	return ListResult{Actions: items, Errors: errs}
}

// Reload 重扫 actions 目录重建 registry（编辑保存后调用）。
// 低频操作：整体替换 reg 指针；正在运行的 action 持有旧 LoadedAction 副本，不受影响。
func (s *Service) Reload() {
	s.reg = registry.Load(filepath.Join(s.baseDir, "actions"), s.baseDir)
}

// GetActionYaml 返回指定 action 源文件原文（含注释与格式）。
func (s *Service) GetActionYaml(id string) (string, error) {
	la, ok := s.reg.Actions[id]
	if !ok {
		return "", fmt.Errorf("未知动作 %q", id)
	}
	data, err := os.ReadFile(la.File)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// SetActionYaml 校验并写回 action 源文件，随后重载 registry，返回最新列表。
// 禁止改 id（id 为文件锚点）；解析/校验失败时不写盘。
func (s *Service) SetActionYaml(id string, text string) (ListResult, error) {
	la, ok := s.reg.Actions[id]
	if !ok {
		return ListResult{}, fmt.Errorf("未知动作 %q", id)
	}
	def, err := registry.ParseAction([]byte(text))
	if err != nil {
		return ListResult{}, fmt.Errorf("YAML 解析失败: %w", err)
	}
	if def.ID != id {
		return ListResult{}, fmt.Errorf("id 不可修改（原 %q，现 %q）", id, def.ID)
	}
	if err := registry.Validate(def); err != nil {
		return ListResult{}, err
	}
	if err := os.WriteFile(la.File, []byte(text), 0644); err != nil {
		return ListResult{}, err
	}
	s.Reload()
	return s.buildListResult(), nil
}
```

- [ ] **Step 4: 运行全部 api 测试**

Run: `go test ./internal/api -v`
Expected: PASS（新测试通过，旧 `TestListActions*` 因 `buildListResult` 行为等价不受影响）。

- [ ] **Step 5: 重新生成前端 bindings**

Run: `wails3 generate bindings`
Expected: `frontend/bindings/workflow-tool/internal/api/service.js` 出现 `GetActionYaml` 与 `SetActionYaml` 两个导出函数（`$Call.ByID(...)`）。

- [ ] **Step 6: 提交**

```bash
git add internal/api/api.go internal/api/api_test.go frontend/bindings
git commit -m "feat(api): 新增 Action yaml 原文读写接口

GetActionYaml 读源文件原文（含注释）；SetActionYaml 解析→禁改 id→
Validate→写盘→Reload→返回新列表。抽出 buildListResult 共用。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 前端 context 加 "edit" 视图与封装方法

**Files:**
- Modify: `frontend/src/context/ActionRunnerProvider.tsx`
- Modify: `frontend/src/context/ActionRunnerProvider.test.tsx`

**Interfaces:**
- Consumes: bindings `GetActionYaml`、`SetActionYaml`（Task 2 生成）。
- Produces: `RunnerContextValue.view` 含 `"edit"`；`getActionYaml(id) => Promise<string>`；`saveActionYaml(id, text) => Promise<void>`（成功后内部刷新 actions/errors）。供 Task 4 组件使用。

- [ ] **Step 1: 写失败测试（在 ActionRunnerProvider.test.tsx 的 hoisted 块、mock 工厂、beforeEach、describe 各加相应项）**

hoisted 块 `return { ... }` 内追加：

```ts
      mockGetActionYaml: vi.fn(),
      mockSetActionYaml: vi.fn(),
```

`vi.mock(...service.js, ...)` 工厂对象内追加：

```ts
    GetActionYaml: mockGetActionYaml,
    SetActionYaml: mockSetActionYaml,
```

`beforeEach` 内追加：

```ts
    mockGetActionYaml.mockReset();
    mockSetActionYaml.mockReset();
```

`describe` 内追加测试：

```ts
  it("saveActionYaml 写回并刷新 actions", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockSetActionYaml.mockResolvedValue({
      actions: [
        { id: "a", title: "新名", icon: "", description: "", params: [], presets: [], stream: "" },
      ],
      errors: [],
    });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.saveActionYaml("a", "id: a\ntitle: 新名\n");
    });
    expect(mockSetActionYaml).toHaveBeenCalledWith("a", "id: a\ntitle: 新名\n");
    expect(result.current.actions).toHaveLength(1);
    expect(result.current.actions[0].title).toBe("新名");
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd frontend && npx vitest run src/context/ActionRunnerProvider.test.tsx`
Expected: FAIL（`saveActionYaml` 不是 function；TS 类型缺失）。

- [ ] **Step 3: 改 ActionRunnerProvider.tsx —— import 新增两个绑定**

把 service.js 的 import 块改为（新增末两行）：

```ts
import {
  ListActions,
  RunAction,
  CancelAction,
  GetGlobalConfig,
  SetGlobalConfig,
  GetFragments,
  SetFragments,
  PickDirectory,
  OpenActionsDir,
  GetActionYaml,
  SetActionYaml,
} from "../../bindings/workflow-tool/internal/api/service.js";
```

- [ ] **Step 4: 扩展 view 联合类型（两处）与 setView 签名**

`RunnerContextValue.view` 改为：

```ts
  view: "output" | "form" | "global" | "llm" | "fragments" | "edit";
```

`setView` 签名改为：

```ts
  setView: (v: "output" | "form" | "global" | "llm" | "fragments" | "edit") => void;
```

`useState` 泛型改为：

```ts
  const [view, setView] = useState<
    "output" | "form" | "global" | "llm" | "fragments" | "edit"
  >("output");
```

- [ ] **Step 5: 在 Provider 内加两个方法（紧挨 saveFragments 之后）**

```ts
  const getActionYaml = async (id: string): Promise<string> => {
    return await GetActionYaml(id);
  };

  // saveActionYaml：写回 yaml（后端校验+重载），成功后用返回的列表刷新 actions/errors。
  const saveActionYaml = async (id: string, text: string): Promise<void> => {
    const res = await SetActionYaml(id, text);
    setActions((res && res.actions) || []);
    setErrors((res && res.errors) || []);
  };
```

- [ ] **Step 6: 把两方法挂到 value 对象（紧挨 openActionsDir 之后）**

```ts
    openActionsDir,
    getActionYaml,
    saveActionYaml,
  };
```

并把接口 `RunnerContextValue` 内（紧挨 openActionsDir 之后）追加：

```ts
  openActionsDir: () => Promise<void>;
  getActionYaml: (id: string) => Promise<string>;
  saveActionYaml: (id: string, text: string) => Promise<void>;
```

- [ ] **Step 7: 运行该测试文件**

Run: `cd frontend && npx vitest run src/context/ActionRunnerProvider.test.tsx`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add frontend/src/context/ActionRunnerProvider.tsx frontend/src/context/ActionRunnerProvider.test.tsx
git commit -m "feat(frontend): context 加 edit 视图与 yaml 读写封装

view 联合类型加 edit；新增 getActionYaml/saveActionYaml（后者刷新列表）。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 编辑视图组件 + 入口 + OutputPanel 分支 + i18n

**Files:**
- Modify: `frontend/src/i18n/locales/zh.json`、`frontend/src/i18n/locales/en.json`
- Create: `frontend/src/components/ActionYamlEditor.tsx`
- Create: `frontend/src/components/ActionYamlEditor.test.tsx`
- Modify: `frontend/src/components/OutputPanel.tsx`
- Modify: `frontend/src/components/OutputToolbar.tsx`
- Modify: `frontend/src/components/OutputPanel.test.tsx`

**Interfaces:**
- Consumes: `useActionRunner()` 的 `actions`/`currentId`/`getActionYaml`/`saveActionYaml`/`setView`（Task 3）；i18n key `edit.*`。
- Produces: `<ActionYamlEditor />` 组件；`OutputPanel` 在 `view==="edit"` 渲染它；`OutputToolbar` 标题点击 `setView("edit")`。

- [ ] **Step 1: 加 i18n 文案 —— zh.json（在末尾 `fragments.tagsPlaceholder` 行后追加）**

```json
  "fragments.tagsPlaceholder": "标签（逗号分隔）",
  "edit.title": "编辑 Action",
  "edit.placeholder": "选择 Action",
  "edit.save": "保存",
  "edit.saving": "保存中…",
  "edit.reset": "重置",
  "edit.loading": "加载中…",
  "edit.empty": "（无 Action，可在 actions/ 放 yaml）",
  "edit.runAfterSave": "已保存，下次运行生效",
  "edit.tooltip": "编辑 yaml"
}
```

- [ ] **Step 2: 加 i18n 文案 —— en.json（同结构追加）**

```json
  "fragments.tagsPlaceholder": "Tags (comma-separated)",
  "edit.title": "Edit Action",
  "edit.placeholder": "Select an action",
  "edit.save": "Save",
  "edit.saving": "Saving…",
  "edit.reset": "Reset",
  "edit.loading": "Loading…",
  "edit.empty": "(No actions. Put yaml in actions/)",
  "edit.runAfterSave": "Saved. Takes effect on next run.",
  "edit.tooltip": "Edit yaml"
}
```

- [ ] **Step 3: 写 ActionYamlEditor.test.tsx（失败测试）**

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../i18n";

const { mockListActions, mockGetActionYaml, mockSetActionYaml, mockOn, listeners } =
  vi.hoisted(() => {
    const listeners: Record<string, (e: unknown) => void> = {};
    return {
      mockListActions: vi.fn(),
      mockGetActionYaml: vi.fn(),
      mockSetActionYaml: vi.fn(),
      mockOn: vi.fn((name: string, cb: (e: unknown) => void) => {
        listeners[name] = cb;
        return () => {
          delete listeners[name];
        };
      }),
      listeners,
    };
  });

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: mockListActions,
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn().mockResolvedValue(undefined),
  GetFragments: vi.fn().mockResolvedValue([]),
  SetFragments: vi.fn().mockResolvedValue(undefined),
  PickDirectory: vi.fn().mockResolvedValue(""),
  GetActionYaml: mockGetActionYaml,
  SetActionYaml: mockSetActionYaml,
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));

import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { ActionYamlEditor } from "./ActionYamlEditor";

beforeEach(async () => {
  Object.keys(listeners).forEach((k) => delete listeners[k]);
  mockListActions.mockReset().mockResolvedValue({
    actions: [{ id: "a", title: "动作A", icon: "", description: "", params: [], presets: [], stream: "" }],
    errors: [],
  });
  mockGetActionYaml.mockReset().mockResolvedValue("# 注释\nid: a\ntitle: 动作A\ncommand:\n  shell: echo hi\n");
  mockSetActionYaml.mockReset().mockResolvedValue({ actions: [], errors: [] });
  mockOn.mockClear();
  await i18n.changeLanguage("zh");
});

describe("ActionYamlEditor", () => {
  it("进入时加载首个 action 原文到编辑区", async () => {
    render(
      <ActionRunnerProvider>
        <ActionYamlEditor />
      </ActionRunnerProvider>
    );
    const ta = await screen.findByRole("textbox");
    await waitFor(() =>
      expect(ta).toHaveValue(expect.stringContaining("# 注释"))
    );
  });

  it("编辑后保存调用 saveActionYaml 并清 dirty", async () => {
    const user = userEvent.setup();
    render(
      <ActionRunnerProvider>
        <ActionYamlEditor />
      </ActionRunnerProvider>
    );
    const ta = await screen.findByRole("textbox");
    await waitFor(() => expect(ta).toHaveValue(expect.stringContaining("echo hi")));
    const saveBtn = screen.getByRole("button", { name: "保存" });
    expect(saveBtn).toBeDisabled();
    await user.type(ta, "{End}\n# 新行");
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);
    await waitFor(() => expect(mockSetActionYaml).toHaveBeenCalled());
    // 保存成功后 dirty 清零 → 再次禁用
    await waitFor(() => expect(saveBtn).toBeDisabled());
  });

  it("保存失败显示错误文案", async () => {
    mockSetActionYaml.mockRejectedValueOnce("YAML 解析失败: line 1");
    const user = userEvent.setup();
    render(
      <ActionRunnerProvider>
        <ActionYamlEditor />
      </ActionRunnerProvider>
    );
    const ta = await screen.findByRole("textbox");
    await waitFor(() => expect(ta).toHaveValue(expect.stringContaining("echo hi")));
    await user.type(ta, "{End}x");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/YAML 解析失败/)).toBeInTheDocument();
  });

  it("无 action 时显示空态", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    render(
      <ActionRunnerProvider>
        <ActionYamlEditor />
      </ActionRunnerProvider>
    );
    expect(await screen.findByText(/无 Action/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
```

- [ ] **Step 4: 运行测试，确认失败**

Run: `cd frontend && npx vitest run src/components/ActionYamlEditor.test.tsx`
Expected: FAIL（`ActionYamlEditor` 未创建）。

- [ ] **Step 5: 创建 ActionYamlEditor.tsx**

```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";

// 把任意 catch 到的错误转成字符串（Wails 可能抛 string 或 Error）。
function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

// Action yaml 原文编辑器：Select 切换动作 + Textarea 编辑原文 + 保存写盘热重载。
// 切换动作自动丢弃未保存改动（按需求不弹确认）。
export function ActionYamlEditor() {
  const { t } = useTranslation();
  const { actions, currentId, getActionYaml, saveActionYaml } = useActionRunner();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // actions 到达后初始化 editingId（currentId 优先，否则首个）
  useEffect(() => {
    if (!editingId && actions.length > 0) {
      setEditingId(currentId ?? actions[0].id);
    }
  }, [editingId, actions, currentId]);

  // editingId 变化时拉取原文
  useEffect(() => {
    if (!editingId) {
      setText("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotice(null);
    getActionYaml(editingId)
      .then((raw) => {
        if (cancelled) return;
        setText(raw);
        setDirty(false);
      })
      .catch((e) => {
        if (!cancelled) setError(errMsg(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editingId, getActionYaml]);

  const onReset = async () => {
    if (!editingId) return;
    setError(null);
    setNotice(null);
    try {
      const raw = await getActionYaml(editingId);
      setText(raw);
      setDirty(false);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const onSave = async () => {
    if (!editingId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await saveActionYaml(editingId, text);
      setDirty(false);
      setNotice(t("edit.runAfterSave"));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  if (actions.length === 0) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b px-4 py-2">
          <SidebarTrigger />
          <span className="font-semibold">{t("edit.title")}</span>
        </header>
        <div className="p-4 text-muted-foreground">{t("edit.empty")}</div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <Select value={editingId ?? undefined} onValueChange={(v) => setEditingId(v)}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder={t("edit.placeholder")} />
            </SelectTrigger>
            <SelectContent>
              {actions.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!dirty || saving || loading}
            onClick={onReset}
          >
            {t("edit.reset")}
          </Button>
          <Button size="sm" disabled={!dirty || saving || loading} onClick={onSave}>
            {saving ? t("edit.saving") : t("edit.save")}
          </Button>
        </div>
      </header>
      <Textarea
        className="m-4 flex-1 resize-none font-mono text-xs"
        value={loading ? t("edit.loading") : text}
        readOnly={loading}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
      />
      {error && (
        <Alert variant="destructive" className="mx-4 mb-4">
          <AlertDescription className="whitespace-pre-wrap font-mono">
            {error}
          </AlertDescription>
        </Alert>
      )}
      {notice && !error && (
        <div className="mx-4 mb-4 text-sm text-muted-foreground">{notice}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: 运行 ActionYamlEditor 测试**

Run: `cd frontend && npx vitest run src/components/ActionYamlEditor.test.tsx`
Expected: PASS。

- [ ] **Step 7: OutputPanel 加 edit 分支**

把 `OutputPanel.tsx` 顶部 import 加一行，并在函数体 `if (view === "global")` 之前插入 edit 分支：

import 区追加：

```ts
import { ActionYamlEditor } from "./ActionYamlEditor";
```

函数体（在 `if (view === "global")` 之前）插入：

```tsx
  if (view === "edit") {
    return (
      <main className="flex min-w-0 flex-1 flex-col">
        <ActionYamlEditor />
      </main>
    );
  }
```

- [ ] **Step 8: OutputToolbar 标题改可点击入口**

把 `OutputToolbar.tsx` 的 `useActionRunner()` 解构加上 `setView`：

```tsx
  const { actions, currentId, status, cancel, clearOutput, copyOutput, setView } =
    useActionRunner();
```

把标题区 `<span className="flex items-center gap-1.5 font-semibold">...</span>` 替换为可点击 button：

```tsx
        <button
          type="button"
          onClick={() => setView("edit")}
          title={t("edit.tooltip")}
          className="flex items-center gap-1.5 rounded px-1 font-semibold hover:bg-accent cursor-pointer"
        >
          {current ? (
            <>
              <ActionIcon name={current.icon ?? "hi:play"} />
              {current.title}
            </>
          ) : (
            t("main.selectAction")
          )}
        </button>
```

- [ ] **Step 9: 更新 OutputPanel.test.tsx —— mock 加新方法 + 入口测试**

`vi.mock(...service.js, ...)` 工厂对象内追加：

```ts
  GetActionYaml: vi.fn().mockResolvedValue("id: a1\ntitle: A1\n"),
  SetActionYaml: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
```

`describe` 内追加（验证点标题 → 进 edit 视图 → 编辑器出现）：

```tsx
  it("点击标题进入编辑视图", async () => {
    const user = userEvent.setup();
    render(
      <ActionRunnerProvider>
        <SidebarProvider>
          <OutputPanel />
        </SidebarProvider>
      </ActionRunnerProvider>
    );
    await screen.findByText("A1");
    await user.click(screen.getByRole("button", { name: /编辑 yaml/ }));
    expect(await screen.findByText(/选择 Action|Select an action/)).toBeInTheDocument();
  });
```

并确保顶部已 import `userEvent`（若无则加 `import userEvent from "@testing-library/user-event";`）。

- [ ] **Step 10: 运行全部前端测试 + lint + 类型检查**

Run:
```bash
cd frontend && npx vitest run
npm run lint
npm run typecheck
```
Expected: 全部 PASS（含 OutputPanel、ActionYamlEditor、ActionRunnerProvider、GlobalConfigEditor 等既有测试）。

- [ ] **Step 11: 提交**

```bash
git add frontend/src/i18n/locales/zh.json frontend/src/i18n/locales/en.json \
        frontend/src/components/ActionYamlEditor.tsx \
        frontend/src/components/ActionYamlEditor.test.tsx \
        frontend/src/components/OutputPanel.tsx \
        frontend/src/components/OutputToolbar.tsx \
        frontend/src/components/OutputPanel.test.tsx
git commit -m "feat(frontend): 右栏标题栏点击编辑 Action yaml 原文

新增 ActionYamlEditor（Select 切换 + 等宽 Textarea + 保存/重置），
OutputPanel 加 edit 分支，OutputToolbar 标题改为可点击入口，
补 edit.* 中英文案。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 全量构建联调验收

**Files:** 无源码改动（构建 + 手动验证）。

- [ ] **Step 1: 前端构建**

Run: `cd frontend && npm run build`
Expected: 构建成功，产出 `frontend/dist/`。

- [ ] **Step 2: Go 构建（带 windowsgui）**

Run:
```bash
cd ..
go build -ldflags "-H windowsgui" -o workflow-tool.exe .
```
Expected: 产出 `workflow-tool.exe`，与项目根 `actions/` 同级。

- [ ] **Step 3: 手动联调验证清单**

启动 `workflow-tool.exe`，逐项确认：

1. 右栏顶部「当前动作标题」hover 有高亮 + tooltip「编辑 yaml」，点击进入编辑视图。
2. Select 列出所有 action，默认选中当前运行/首个 action，编辑区显示其 yaml 原文（含注释）。
3. 改动文本 → 「保存」按钮启用；点击保存 → 提示「已保存，下次运行生效」；侧栏标题更新。
4. 故意写错（如删 title 或改 id）→ 保存被拒，红色 Alert 显示后端中文错误，文件未变。
5. Select 切到另一 action → 自动加载新原文，旧改动被丢弃（不弹确认）。
6. 「重置」→ 文本回到磁盘内容。
7. 退出编辑：点侧栏任一 action 运行/进表单 → 回到 output/form 视图。

- [ ] **Step 4（可选）: 提交构建产物无关的收尾**

若无源码改动则跳过；若联调中发现小修，按改动单独提交。

---

## Self-Review 记录

- **Spec 覆盖**：交互入口（OutputToolbar）→ Task 4 Step 8；编辑视图布局 → Task 4 Step 5；后端 File/Get/Set/Reload → Task 1+2；前端 context → Task 3；错误处理（语法/校验/改 id/空态/丢弃）→ Task 2 测试 + Task 4 Step 5/测试；i18n → Task 4 Step 1-2；构建链 → Task 5。无遗漏。
- **占位符**：无 TBD/TODO，所有代码块完整。
- **类型一致**：`getActionYaml`/`saveActionYaml` 在 Task 3 定义、Task 4 消费，签名一致；`buildListResult`/`Reload`/`GetActionYaml`/`SetActionYaml` 在 Task 2 自洽；view 联合类型三处同步。
