# 保存为 Preset 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ParamForm 运行按钮下方加「保存」按钮，弹窗输入名称+描述，把当前参数存为该动作的 preset（写回 yaml，重名覆盖）。

**Architecture:** 后端新增纯函数 `registry.AddPresetToYAML`（`yaml.v3` Node round-trip 保留注释、同名覆盖、values 用 flow style）+ `api.Service.AddPreset`（读原文→改→写回→Reload→返回列表）。前端新建 base-ui `dialog.tsx` 封装 + `SavePresetDialog` 组件，ParamForm 挂载保存按钮，PresetList tooltip 显示 description。

**Tech Stack:** Go + `gopkg.in/yaml.v3`（Node API）+ Wails v3 alpha2.119 + React 19 + base-ui + vitest。

## Global Constraints

（摘自 CLAUDE.md 与设计文档，所有任务隐含遵守）

- 锁定 Wails `v3.0.0-alpha2.119`，不升 alpha.3。
- 改 `internal/api/api.go` 后**必须** `wails3 generate bindings` → `npm run build` → `go build`，否则前端调 `AddPreset` 报 method ID not found。
- 前端用 **base-ui**（非 radix）；新 UI 原语按 [`ui/sheet.tsx`](../../../frontend/src/components/ui/sheet.tsx) 的封装风格（`@base-ui/react/dialog`，函数式 + `data-slot` + `cn`）。
- 新增前端静态文案只改 `frontend/src/i18n/locales/{zh,en}.json`（flat key 结构）。
- 前端测试 mock bindings 用 `vi.hoisted` 模式（参照 [`ParamForm.test.tsx`](../../../frontend/src/components/ParamForm.test.tsx)），断言查中文文案。
- 跨 macOS / Windows。

## File Structure

| 文件 | 责任 | 动作 |
|------|------|------|
| `internal/registry/registry.go` | `Preset.Description` 字段 + `AddPresetToYAML` 纯函数 | 修改 |
| `internal/registry/registry_test.go` | `AddPresetToYAML` 单测 | 修改 |
| `internal/api/api.go` | `Service.AddPreset` 方法 | 修改 |
| `frontend/bindings/.../service.js` + `models.ts` | `AddPreset` + `Preset.description` 绑定 | 自动生成 |
| `frontend/src/components/ui/dialog.tsx` | base-ui Dialog 居中模态封装 | 新建 |
| `frontend/src/components/SavePresetDialog.tsx` | 名称+描述输入弹窗 | 新建 |
| `frontend/src/components/SavePresetDialog.test.tsx` | 弹窗交互单测 | 新建 |
| `frontend/src/context/ActionRunnerProvider.tsx` | `addPreset` 方法 + bindings 导入 | 修改 |
| `frontend/src/components/ParamForm.tsx` | 保存按钮 + 挂载 dialog | 修改 |
| `frontend/src/components/ParamForm.test.tsx` | 保存按钮渲染断言 | 修改 |
| `frontend/src/components/PresetList.tsx` | tooltip 显示 description 优先 | 修改 |
| `frontend/src/i18n/locales/{zh,en}.json` | 新文案 | 修改 |

---

## Task 1: registry `AddPresetToYAML` 纯函数 + 单测

**Files:**
- Modify: `internal/registry/registry.go`（`Preset` 加 `Description`；新增 `AddPresetToYAML` 及辅助函数）
- Test: `internal/registry/registry_test.go`

**Interfaces:**
- Produces: `Preset.Description string`（yaml `description,omitempty`）；`func AddPresetToYAML(raw []byte, name, description string, values map[string]string) ([]byte, error)`

- [ ] **Step 1: 写失败测试**

Append to `internal/registry/registry_test.go`:

```go
func TestAddPresetToYAML_NewPreset(t *testing.T) {
	in := []byte("id: a\ntitle: A\ncommand:\n  shell: echo\n")
	out, err := AddPresetToYAML(in, "p1", "描述", map[string]string{"URL": "x"})
	if err != nil {
		t.Fatalf("AddPresetToYAML: %v", err)
	}
	def, err := ParseAction(out)
	if err != nil {
		t.Fatalf("输出无法解析: %v\n%s", err, out)
	}
	if len(def.Presets) != 1 || def.Presets[0].Name != "p1" {
		t.Fatalf("want 1 preset p1, got %+v", def.Presets)
	}
	if def.Presets[0].Description != "描述" {
		t.Fatalf("description want 描述, got %q", def.Presets[0].Description)
	}
	if def.Presets[0].Values["URL"] != "x" {
		t.Fatalf("values.URL want x, got %+v", def.Presets[0].Values)
	}
}

func TestAddPresetToYAML_OverwriteSameName(t *testing.T) {
	in := []byte("id: a\ntitle: A\npresets:\n  - name: p1\n    values: {URL: old}\ncommand:\n  shell: echo\n")
	out, err := AddPresetToYAML(in, "p1", "新描述", map[string]string{"URL": "new"})
	if err != nil {
		t.Fatal(err)
	}
	def, _ := ParseAction(out)
	if len(def.Presets) != 1 {
		t.Fatalf("覆盖后应仍为 1 个 preset, got %d", len(def.Presets))
	}
	if def.Presets[0].Values["URL"] != "new" {
		t.Fatalf("URL 应覆盖为 new, got %q", def.Presets[0].Values["URL"])
	}
	if def.Presets[0].Description != "新描述" {
		t.Fatalf("description 应为新描述, got %q", def.Presets[0].Description)
	}
}

func TestAddPresetToYAML_EmptyName(t *testing.T) {
	if _, err := AddPresetToYAML([]byte("id: a\ntitle: A\n"), "  ", "", nil); err == nil {
		t.Fatal("空 name 应报错")
	}
}

func TestAddPresetToYAML_PreservesComments(t *testing.T) {
	in := []byte("# 顶部注释\nid: a\ntitle: A\ncommand:\n  shell: echo\n")
	out, err := AddPresetToYAML(in, "p1", "", map[string]string{"K": "v"})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(out, []byte("# 顶部注释")) {
		t.Fatalf("顶部注释应保留, got:\n%s", out)
	}
}
```

> 需在 `registry_test.go` 顶部 import 加 `"bytes"`。

- [ ] **Step 2: 运行测试，确认失败**

Run: `go test ./internal/registry -run TestAddPresetToYAML -v`
Expected: 编译失败 `undefined: AddPresetToYAML`。

- [ ] **Step 3: 实现 `Preset.Description` + `AddPresetToYAML`**

在 `internal/registry/registry.go`：

(a) 修改 `Preset` 结构（加 `Description`，置于 Name 与 Values 之间）:

```go
// Preset 是作者定义的整套参数值。
type Preset struct {
	Name        string            `json:"name" yaml:"name"`
	Description string            `json:"description" yaml:"description,omitempty"`
	Values      map[string]string `json:"values" yaml:"values"`
}
```

(b) 顶部 import 块加 `"bytes"`、`"sort"`、`"strings"`（`yaml.v3` 已存在）。

(c) 文件末尾追加 `AddPresetToYAML` 及辅助函数:

```go
// AddPresetToYAML 在 yaml 原文中新增/覆盖一个 preset，保留其余节点注释与格式。
// 同名 preset 删除后追加（值被覆盖，位置移到 presets 列表末尾）；否则追加。
// name trim 后为空返回错误。values 序列化为 flow 风格 { K: V }。
func AddPresetToYAML(raw []byte, name, description string, values map[string]string) ([]byte, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, fmt.Errorf("preset name 不能为空")
	}

	var root yaml.Node
	if err := yaml.Unmarshal(raw, &root); err != nil {
		return nil, fmt.Errorf("yaml 解析失败: %w", err)
	}
	// 空文档：Unmarshal 得到零值节点，建一个空 mapping
	if root.Kind == 0 {
		root = yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	}
	if root.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("yaml 根节点应为 mapping")
	}

	// 找/建 presets 键
	var presetsNode *yaml.Node
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value == "presets" {
			presetsNode = root.Content[i+1]
			break
		}
	}
	if presetsNode == nil {
		keyNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "presets"}
		presetsNode = &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		root.Content = append(root.Content, keyNode, presetsNode)
	} else if presetsNode.Kind != yaml.SequenceNode {
		presetsNode.Kind = yaml.SequenceNode
		presetsNode.Tag = "!!seq"
		presetsNode.Content = nil
	}

	// 构造 flow-style values mapping（key 字母序，输出稳定）
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	valuesNode := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Style: yaml.FlowStyle}
	for _, k := range keys {
		valuesNode.Content = append(valuesNode.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: k},
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: values[k]},
		)
	}

	// 删除同名 preset（覆盖语义：删旧 + 追加新，位置移到末尾）
	kept := presetsNode.Content[:0]
	for _, item := range presetsNode.Content {
		if item.Kind == yaml.MappingNode && presetNameOf(item) == name {
			continue
		}
		kept = append(kept, item)
	}
	presetsNode.Content = kept
	presetsNode.Content = append(presetsNode.Content, newPresetMapping(name, description, valuesNode))

	return encodeYAMLNode(&root)
}

// presetNameOf 从 preset mapping 节点取 name 字段值。
func presetNameOf(item *yaml.Node) string {
	for i := 0; i+1 < len(item.Content); i += 2 {
		if item.Content[i].Value == "name" {
			return item.Content[i+1].Value
		}
	}
	return ""
}

// newPresetMapping 构造 name → description(非空时) → values 顺序的 mapping 节点。
func newPresetMapping(name, description string, valuesNode *yaml.Node) *yaml.Node {
	m := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	add := func(k string, v *yaml.Node) {
		m.Content = append(m.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: k},
			v,
		)
	}
	add("name", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: name})
	if description != "" {
		add("description", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: description})
	}
	add("values", valuesNode)
	return m
}

// encodeYAMLNode 以 2 空格缩进序列化节点。
func encodeYAMLNode(root *yaml.Node) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(root); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `go test ./internal/registry -v`
Expected: PASS（含 4 个 `TestAddPresetToYAML_*` + 原有测试全绿）。

- [ ] **Step 5: 提交**

```sh
git add internal/registry/registry.go internal/registry/registry_test.go
git commit -m "feat(registry): AddPresetToYAML 纯函数 + Preset.Description

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: api `Service.AddPreset` + 重新生成 bindings

**Files:**
- Modify: `internal/api/api.go`（新增 `AddPreset` 方法）
- Auto-generated: `frontend/bindings/`（`wails3 generate bindings` 产物）

**Interfaces:**
- Consumes: `registry.AddPresetToYAML`（Task 1）
- Produces: `Service.AddPreset(actionID, name, description string, values map[string]string) (ListResult, error)` —— 前端经 bindings 调用

- [ ] **Step 1: 实现 `AddPreset` 方法**

在 `internal/api/api.go` 的 `CancelAction` 方法后插入：

```go
// AddPreset 给指定动作新增/覆盖一个 preset（同名覆盖），写回 yaml 并重载，返回最新列表。
func (s *Service) AddPreset(actionID, name, description string, values map[string]string) (ListResult, error) {
	la, ok := s.reg.Actions[actionID]
	if !ok {
		return ListResult{}, fmt.Errorf("未知动作 %q", actionID)
	}
	raw, err := os.ReadFile(la.File)
	if err != nil {
		return ListResult{}, err
	}
	updated, err := registry.AddPresetToYAML(raw, name, description, values)
	if err != nil {
		return ListResult{}, err
	}
	if err := os.WriteFile(la.File, updated, 0644); err != nil {
		return ListResult{}, err
	}
	s.Reload()
	return s.buildListResult(), nil
}
```

> `registry` 已在 import 中；`os`、`fmt` 已存在。无需新增 import。

- [ ] **Step 2: 验证编译**

Run: `go build ./internal/api`
Expected: 无输出，编译通过。

- [ ] **Step 3: 重新生成前端 bindings**

Run: `wails3 generate bindings`
Expected: 无报错；`frontend/bindings/workflow-tool/internal/api/service.js` 含 `export function AddPreset(...)`，`models.ts` 的 `Preset` 类型含 `description?: string`。

- [ ] **Step 4: 验证 binding 已生成**

Run: `grep -n "AddPreset" frontend/bindings/workflow-tool/internal/api/service.js`
Expected: 命中一行 `export function AddPreset`。

- [ ] **Step 5: 提交**

```sh
git add internal/api/api.go frontend/bindings
git commit -m "feat(api): Service.AddPreset 新增/覆盖 preset + 重生成 bindings

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 前端 `ui/dialog.tsx` + `SavePresetDialog` + `addPreset`

**Files:**
- Create: `frontend/src/components/ui/dialog.tsx`
- Create: `frontend/src/components/SavePresetDialog.tsx`
- Create: `frontend/src/components/SavePresetDialog.test.tsx`
- Modify: `frontend/src/context/ActionRunnerProvider.tsx`（导入 `AddPreset` + `addPreset` 方法 + context value）

**Interfaces:**
- Consumes: bindings `AddPreset`（Task 2）；`formValues`、`currentId`（provider 现有状态）
- Produces: `useActionRunner().addPreset(name, description): Promise<void>`；`<SavePresetDialog open onClose />`

- [ ] **Step 1: 新建 `ui/dialog.tsx`（base-ui 居中模态，参照 sheet.tsx）**

Create `frontend/src/components/ui/dialog.tsx`:

```tsx
"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon } from "@hugeicons/core-free-icons"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & { showCloseButton?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-slot="dialog-overlay"
        className="fixed inset-0 z-50 bg-black/40 data-ending-style:opacity-0 data-starting-style:opacity-0"
      />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed left-1/2 top-1/2 z-50 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border bg-popover p-6 text-popover-foreground shadow-lg transition duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button variant="ghost" className="absolute top-4 right-4" size="icon-sm" />
            }
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-1.5", className)} {...props} />
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-heading font-medium text-foreground", className)}
      {...props}
    />
  )
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div"> {
  return <div data-slot="dialog-footer" className={cn("mt-2 flex justify-end gap-2", className)} {...props} />
}

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
}
```

- [ ] **Step 2: `ActionRunnerProvider` 加 `addPreset`**

(a) [ActionRunnerProvider.tsx:10-22](../../../frontend/src/context/ActionRunnerProvider.tsx#L10-L22) 的 bindings 导入加 `AddPreset`：

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
  AddPreset,
} from "../../bindings/workflow-tool/internal/api/service.js";
```

(b) `RunnerContextValue` 接口加一行（紧挨 `saveActionYaml` 之后）：

```ts
  addPreset: (name: string, description: string) => Promise<void>;
```

(c) 在 `saveActionYaml` 定义之后加 `addPreset` 实现：

```ts
  // addPreset：把当前 formValues 存为 currentId 动作的 preset（同名覆盖）。
  const addPreset = async (name: string, description: string) => {
    if (!currentId) return;
    const res = await AddPreset(currentId, name, description, formValues);
    setActions((res && res.actions) || []);
    setErrors((res && res.errors) || []);
  };
```

(d) context value 对象（`const value: RunnerContextValue = {...}`）加 `addPreset,`（紧挨 `saveActionYaml,` 之后）。

- [ ] **Step 3: 新建 `SavePresetDialog.tsx`**

Create `frontend/src/components/SavePresetDialog.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useActionRunner } from "../hooks/useActionRunner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";

// 保存为预设弹窗：名称必填 + 描述可选。确定时调 addPreset（当前 formValues），
// 成功后关闭并清空输入；失败在弹窗内显示错误。
export function SavePresetDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { addPreset } = useActionRunner();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [error, setError] = useState("");

  const canConfirm = name.trim().length > 0;

  const reset = () => {
    setName("");
    setDesc("");
    setError("");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const onConfirm = async () => {
    if (!canConfirm) return;
    try {
      await addPreset(name.trim(), desc.trim());
      reset();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleClose();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("preset.title")}</DialogTitle>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="preset-name">{t("preset.nameLabel")}</FieldLabel>
          <Input
            id="preset-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("preset.namePlaceholder")}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="preset-desc">{t("preset.descLabel")}</FieldLabel>
          <Input
            id="preset-desc"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder={t("preset.descPlaceholder")}
          />
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {t("preset.cancel")}
          </Button>
          <Button disabled={!canConfirm} onClick={onConfirm}>
            {t("preset.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: 写 `SavePresetDialog` 测试**

Create `frontend/src/components/SavePresetDialog.test.tsx`（参照 ParamForm.test.tsx 的 hoisted mock 模式）:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../i18n";

const { mockAddPreset } = vi.hoisted(() => ({
  mockAddPreset: vi.fn(() => Promise.resolve({ actions: [], errors: [] })),
}));

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  RunAction: vi.fn(),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn(),
  GetFragments: vi.fn().mockResolvedValue([]),
  SetFragments: vi.fn(),
  PickDirectory: vi.fn(),
  OpenActionsDir: vi.fn(),
  GetActionYaml: vi.fn(),
  SetActionYaml: vi.fn(),
  AddPreset: mockAddPreset,
}));

vi.mock("@wailsio/runtime", () => ({ Events: { On: vi.fn() } }));

import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { SavePresetDialog } from "./SavePresetDialog";

beforeEach(async () => {
  mockAddPreset.mockReset().mockResolvedValue({ actions: [], errors: [] });
  await i18n.changeLanguage("zh");
});

describe("SavePresetDialog", () => {
  it("名称为空时确定按钮禁用", () => {
    render(
      <ActionRunnerProvider>
        <SavePresetDialog open={true} onClose={() => {}} />
      </ActionRunnerProvider>
    );
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("填名称后确定调用 addPreset 并关闭", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ActionRunnerProvider>
        <SavePresetDialog open={true} onClose={onClose} />
      </ActionRunnerProvider>
    );
    await user.type(screen.getByLabelText(/名称/), "我的预设");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/名称/); // 等一拍让 async 完成
    expect(mockAddPreset).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: 运行测试 + 类型检查**

Run: `cd frontend && npm test -- --run SavePresetDialog`
Expected: 2 个测试 PASS。

Run: `cd frontend && npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: 提交**

```sh
git add frontend/src/components/ui/dialog.tsx frontend/src/components/SavePresetDialog.tsx frontend/src/components/SavePresetDialog.test.tsx frontend/src/context/ActionRunnerProvider.tsx
git commit -m "feat(frontend): dialog 组件 + SavePresetDialog + addPreset

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: ParamForm 保存按钮 + PresetList tooltip + i18n + 端到端

**Files:**
- Modify: `frontend/src/components/ParamForm.tsx`（保存按钮 + 挂载 dialog）
- Modify: `frontend/src/components/ParamForm.test.tsx`（保存按钮断言 + mock AddPreset）
- Modify: `frontend/src/components/PresetList.tsx`（tooltip）
- Modify: `frontend/src/i18n/locales/zh.json` + `en.json`（新文案）

**Interfaces:**
- Consumes: `SavePresetDialog`、`addPreset`（Task 3）；`Preset.description`（bindings，Task 2）

- [ ] **Step 1: 加 i18n 文案**

在 `frontend/src/i18n/locales/zh.json` 的 `"main.run": "运行",` 之后加 `"main.save": "保存",`，并在文件末尾 `}` 前加 preset 块：

```json
  "main.save": "保存",
  "preset.title": "保存为预设",
  "preset.nameLabel": "名称",
  "preset.descLabel": "描述（可选）",
  "preset.namePlaceholder": "输入预设名称",
  "preset.descPlaceholder": "可选说明",
  "preset.confirm": "保存",
  "preset.cancel": "取消"
```

`frontend/src/i18n/locales/en.json` 对应加：

```json
  "main.save": "Save",
  "preset.title": "Save as Preset",
  "preset.nameLabel": "Name",
  "preset.descLabel": "Description (optional)",
  "preset.namePlaceholder": "Enter preset name",
  "preset.descPlaceholder": "Optional description",
  "preset.confirm": "Save",
  "preset.cancel": "Cancel"
```

- [ ] **Step 2: ParamForm 加保存按钮 + 挂载 dialog**

Modify `frontend/src/components/ParamForm.tsx`：

(a) 顶部 import 加 `useState` 与 `SavePresetDialog`：

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { useActionRunner } from "../hooks/useActionRunner";
import { SavePresetDialog } from "./SavePresetDialog";
```

> 原 import 第一行无 `useState`，此处新增；其余行保持不变。

(b) `ParamForm` 函数体内，`const action = ...` 之后加 dialog 状态：

```tsx
  const [saveOpen, setSaveOpen] = useState(false);
```

(c) 运行按钮下方追加保存按钮 + dialog（替换 [ParamForm.tsx:141-143](../../../frontend/src/components/ParamForm.tsx#L141-L143) 的运行 Button 块）：

```tsx
      <Button disabled={!canRun} onClick={onRun}>
        {t("main.run")}
      </Button>
      <Button variant="outline" onClick={() => setSaveOpen(true)}>
        {t("main.save")}
      </Button>
      <SavePresetDialog open={saveOpen} onClose={() => setSaveOpen(false)} />
```

- [ ] **Step 3: PresetList tooltip 显示 description 优先**

Modify [PresetList.tsx:44](../../../frontend/src/components/PresetList.tsx#L44)：

```tsx
            tooltip={p.description || p.name}
```

> `p` 的类型来自 bindings 的 `Preset`，Task 2 已含 `description?: string`。

- [ ] **Step 4: 更新 ParamForm 测试（加保存按钮断言 + mock AddPreset）**

(a) 在 [ParamForm.test.tsx:25-34](../../../frontend/src/components/ParamForm.test.tsx#L25-L34) 的 `vi.mock(...)` 工厂内，`PickDirectory: mockPickDirectory,` 之后加：

```tsx
  AddPreset: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
```

(b) 在最后的 `describe("ParamForm", ...)` 内追加一个测试：

```tsx
  it("渲染保存按钮并可打开保存弹窗", async () => {
    const user = userEvent.setup();
    render(
      <ActionRunnerProvider>
        <Harness />
      </ActionRunnerProvider>
    );
    const saveBtn = await screen.findByRole("button", { name: "保存" });
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);
    expect(await screen.findByText(/保存为预设/)).toBeInTheDocument();
  });
```

- [ ] **Step 5: 运行前端测试 + lint + typecheck**

Run: `cd frontend && npm test -- --run`
Expected: 全部 PASS（含 ParamForm 新测试）。

Run: `cd frontend && npm run lint && npm run typecheck`
Expected: 无错误（pre-existing lint debt 容忍，新增代码不引入新告警）。

- [ ] **Step 6: 构建前端 + exe（按 CLAUDE.md：改 api.go 需 npm build → go build）**

Run: `cd frontend && npm run build && cd ..`
Expected: 产出 `frontend/dist/`，无错误。

Run: `go build -ldflags "-H windowsgui" -o workflow-tool.exe .`
Expected: 无错误，产出 `workflow-tool.exe`。

- [ ] **Step 7: 端到端手动验证（连真机/模拟器或任意有参数动作）**

运行 `workflow-tool.exe` → 选一个有参数的动作（如「抓取日志」）→ 填几项参数 → 点「保存」→ 弹窗输入名称+描述 → 确定。
Expected: 弹窗关闭；侧栏该动作下出现新 preset 子项；hover 该子项 tooltip 显示描述。

再填不同参数 → 「保存」→ 输入**同名** → 确定。
Expected: 该 preset 的值被覆盖（侧栏仍只一个同名项）。

打开 `actions/<动作>.yaml` 核对：新 preset 含 `name`/`description`/`values`，`values` 为 `{ K: V }` flow 风格，原有注释保留。

- [ ] **Step 8: 提交**

```sh
git add frontend/src/components/ParamForm.tsx frontend/src/components/ParamForm.test.tsx frontend/src/components/PresetList.tsx frontend/src/i18n/locales/zh.json frontend/src/i18n/locales/en.json frontend/dist
git commit -m "feat(frontend): ParamForm 保存按钮 + PresetList tooltip + i18n

Co-Authored-By: Claude <noreply@anthropic.com>"
```

> `frontend/dist` 是 `npm run build` 产物；如 `.gitignore` 已忽略 dist 则勿 add（按仓库现状：embed 需要 dist 入库则提交，否则跳过此路径）。

---

## Self-Review

**1. Spec coverage（对照设计文档）：**
- `Preset.Description` 字段 → Task 1 Step 3(a) ✓
- `AddPresetToYAML`（Node round-trip、同名覆盖、flow values、name 空、保留注释）→ Task 1 ✓（4 个测试覆盖各场景）
- `Service.AddPreset`（读→改→写→Reload→buildListResult）→ Task 2 Step 1 ✓
- bindings 重生成 → Task 2 Step 3-4 ✓
- `ui/dialog.tsx`（base-ui 封装，参照 sheet）→ Task 3 Step 1 ✓
- `SavePresetDialog`（名称必填+描述可选+错误反馈）→ Task 3 Step 3 ✓
- `ActionRunnerProvider.addPreset` → Task 3 Step 2 ✓
- ParamForm 保存按钮（运行下方，始终 enabled）→ Task 4 Step 2 ✓
- PresetList tooltip description 优先 → Task 4 Step 3 ✓
- i18n zh/en → Task 4 Step 1 ✓
- 端到端验证（新增/覆盖/yaml 格式）→ Task 4 Step 7 ✓

**2. Placeholder scan：** 无 TBD/TODO；所有代码块完整；每步含 exact command + expected。`frontend/dist` 的 add 与否在 Step 8 注明按 .gitignore 现状判定——这是条件说明非占位符。✓

**3. Type/命名一致性：**
- `AddPresetToYAML(raw, name, description, values)` —— Task 1 定义，Task 2 `AddPreset` 调用参数顺序一致 ✓
- `Service.AddPreset(actionID, name, description, values)` —— bindings 生成 `AddPreset(actionID, name, description, values)`，provider `addPreset(name, description)` 内部传 `AddPreset(currentId, name, description, formValues)` ✓
- `SavePresetDialog({ open, onClose })` —— Task 3 定义，Task 4 ParamForm `<SavePresetDialog open={saveOpen} onClose={...} />` 一致 ✓
- `addPreset(name, description)` —— provider 定义与 SavePresetDialog 调用一致 ✓
- `Preset.description` —— registry、bindings models、PresetList `p.description` 一致 ✓
