# 保存为 Preset 功能 设计

> 日期：2026-08-02
> 类型：新功能（前端 dialog + 后端 AddPreset API + registry yaml 操作）

## 背景与目标

动作的 `presets`（[`registry.Preset`](../../internal/registry/registry.go)）机制已存在：动作 yaml 的 `presets` 字段定义「整套预设参数值」，侧栏 [PresetList.tsx](../../frontend/src/components/PresetList.tsx) 渲染为动作子项，单击预填表单、双击直接运行。但**用户无法在 UI 内新增 preset**——只能手编 yaml。

**目标**：在参数表单的「运行」按钮下方加「保存」按钮，点击弹窗输入名称（+可选描述），把当前填写的参数组合存为该动作的 preset，立即可在侧栏复用。

## 需求

- 「保存」按钮位于 [ParamForm.tsx](../../frontend/src/components/ParamForm.tsx) 运行按钮**下方**；无参数动作不渲染（ParamForm 已 `return null`）。
- 点击「保存」→ 弹出模态 dialog，输入**名称**（必填）+ **描述**（可选）→ 确定。
- 把当前 `formValues`（全部参数）存为该动作的 preset（写入 yaml `presets` 字段）。
- **重名覆盖**：同名 preset 用当前参数更新其 `values` 与 `description`。
- preset 说明用结构化的 `description` 字段承载（不依赖 `#` 行注释保留）。
- 保留 yaml 原有格式与注释（`yaml.Node` round-trip）。
- 跨 macOS / Windows 一致。

## 设计

### 1. 数据模型：Preset 增加 Description

[`internal/registry/registry.go`](../../internal/registry/registry.go) 的 `Preset` 加 `Description` 字段：

```go
type Preset struct {
    Name        string            `json:"name" yaml:"name"`
    Description string            `json:"description" yaml:"description,omitempty"`
    Values      map[string]string `json:"values" yaml:"values"`
}
```

`omitempty`：描述为空时不写该字段，保持 yaml 简洁。前端 `bindings/.../models.ts` 的 `Preset` 类型会随 bindings 重新生成自动带上 `description`。

### 2. 后端 registry：`AddPresetToYAML`

新增纯函数（不依赖 Wails，可单测）：

```go
// AddPresetToYAML 在 yaml 原文中新增/覆盖一个 preset，保留其余节点注释与格式。
// 同名 preset 覆盖 values 与 description；否则追加。name 为空返回错误。
func AddPresetToYAML(raw []byte, name, description string, values map[string]string) ([]byte, error)
```

实现要点（`yaml.v3` Node API）：
1. `yaml.Unmarshal(raw, &node)` 解析为 `yaml.Node`（保留 HeadComment/LineComment/FootComment）。
2. 在根 mapping 中找 `presets` 键：
   - 不存在 → 新建 `presets` sequence node 挂到根 mapping。
   - 存在 → 遍历其 sequence 子项，找 `name` 等于入参的 mapping。
3. 命中同名 → 覆盖该 mapping 的 `values`（重建为 flow-style mapping node）与 `description`（非空才写）；未命中 → 追加一个新 mapping node。
4. 新 preset mapping 节点字段顺序固定：`name` → `description`（非空时）→ `values`。`values` 用 `Style: yaml.FlowStyle` 序列化为 `{ K: V }`，对齐 [adb-query.yaml](../../actions/adb-query.yaml) 现有格式。
5. `encoder := yaml.NewEncoder(...); encoder.SetIndent(2); encoder.Encode(&node)` 写回字节。

校验：`name` trim 后非空，否则 `error`。

### 3. 后端 api：`Service.AddPreset`

[`internal/api/api.go`](../../internal/api/api.go) 新增方法，复用现有 `GetActionYaml` + `Reload` + `buildListResult` 模式：

```go
// AddPreset 给指定动作新增/覆盖一个 preset（同名覆盖），写回 yaml 并重载，返回最新列表。
func (s *Service) AddPreset(actionID, name, description string, values map[string]string) (ListResult, error)
```

流程：取 `la.File` 原文 → `registry.AddPresetToYAML` → `os.WriteFile` → `s.Reload()` → `s.buildListResult()`。name 非空校验失败直接返回 error。

> ⚠️ **改 api.go 后必须** `wails3 generate bindings` → `npm run build` → `go build`（见 CLAUDE.md），否则前端调 `AddPreset` 报 method ID not found。

### 4. 前端

#### 4.1 新建 `ui/dialog.tsx`

项目目前**无** dialog 组件（有 `sheet`/`alert`）。按 base-ui 模式新建，导出 `Dialog / DialogTrigger / DialogContent / DialogHeader / DialogTitle / DialogFooter / DialogClose`。封装风格参照现有 [ui/sheet.tsx](../../frontend/src/components/ui/sheet.tsx)（同为 base-ui Dialog 家族）。

#### 4.2 新建 `SavePresetDialog.tsx`

受控模态，props：`open: boolean`、`onClose: () => void`。内部状态：`name`、`description` 输入。

- 名称 `Input`（必填，trim 后非空才允许确定）+ 描述 `Input`（可选）。
- 「确定」调 `addPreset(name, description)`（来自 `useActionRunner`），成功后 `onClose()` 并清空输入。
- 「取消」/遮罩关闭：直接 `onClose()`，清空输入。

#### 4.3 `ActionRunnerProvider` 加 `addPreset`

```ts
const addPreset = async (name: string, description: string) => {
  if (!currentId) return;
  const res = await AddPreset(currentId, name, description, formValues);
  setActions((res && res.actions) || []);
  setErrors((res && res.errors) || []);
};
```

加入 `RunnerContextValue` 与 context value（与现有 `saveActionYaml` 同模式）。`AddPreset` 从重新生成的 bindings 导入。

#### 4.4 `ParamForm.tsx` 加保存按钮

[ParamForm.tsx:141](../../frontend/src/components/ParamForm.tsx#L141) 现有运行按钮下方追加：

```tsx
<Button disabled={!canRun} onClick={onRun}>{t("main.run")}</Button>
<Button variant="outline" onClick={() => setSaveOpen(true)}>{t("main.save")}</Button>
<SavePresetDialog open={saveOpen} onClose={() => setSaveOpen(false)} />
```

`saveOpen` 为 ParamForm 局部 `useState(false)`。保存按钮**始终 enabled**（保存当前快照，由用户决定存什么）。

#### 4.5 `PresetList.tsx` tooltip 显示 description

[PresetList.tsx:44](../../frontend/src/components/PresetList.tsx#L44) `tooltip={p.name}` 改为：

```tsx
tooltip={p.description || p.name}
```

有描述优先显示描述，无则回退名称。

### 5. 数据流与边界

- **保存值范围**：当前 `formValues` 的全部 param（完整快照，含空串）。
- **重名**：覆盖（`AddPresetToYAML` 内处理，前端无需预查）。
- **名称校验**：dialog「确定」按钮在名称 trim 空时 disabled。
- **i18n**：zh/en 加 `main.save`、`preset.nameLabel`、`preset.descLabel`、`preset.namePlaceholder`、`preset.descPlaceholder`、`preset.confirm`、`preset.cancel`。
- **成功反馈**：YAGNI——保存成功仅关弹窗 + 列表刷新（侧栏新 preset 子项出现即反馈），不加 toast。
- **失败反馈**：`addPreset` 抛错时 dialog 内显示错误文案（参考 `ActionYamlEditor` 的 `setError` 模式）。

## 测试

- **registry（纯 Go，单测）** `internal/registry/registry_test.go` 加 `TestAddPresetToYAML`，覆盖：
  - 新增到无 `presets` 节点的 yaml（自动新建）
  - 新增到已有 `presets`（追加）
  - 同名覆盖（values + description 更新，旧的替换）
  - 保留其他节点注释（round-trip 前后非 preset 节点的 HeadComment 不丢）
  - name 空 → 返回 error
- **api**：依赖 Wails，不单测（靠 registry 单测 + 手动联调）。
- **前端 vitest**：
  - `SavePresetDialog`：名称空时确定 disabled；填名称+确定 → 调 `addPreset(name, desc)` → 成功后 onClose（参考 [ActionYamlEditor.test.tsx](../../frontend/src/components/ActionYamlEditor.test.tsx) mock 模式）
  - `ParamForm`：渲染「保存」按钮，点击打开 dialog

## 涉及文件

- **修改**：
  - `internal/registry/registry.go`（`Preset.Description` + `AddPresetToYAML`）
  - `internal/registry/registry_test.go`（新增单测）
  - `internal/api/api.go`（`AddPreset` 方法）
  - `frontend/src/context/ActionRunnerProvider.tsx`（`addPreset` + bindings 导入）
  - `frontend/src/components/ParamForm.tsx`（保存按钮 + dialog 挂载）
  - `frontend/src/components/PresetList.tsx`（tooltip）
  - `frontend/src/i18n/locales/{zh,en}.json`（新文案）
- **新建**：
  - `frontend/src/components/ui/dialog.tsx`
  - `frontend/src/components/SavePresetDialog.tsx`
  - `frontend/src/components/SavePresetDialog.test.tsx`

## 不在范围（YAGNI）

- 编辑/删除已有 preset（本次仅新增+覆盖）。
- preset 排序、拖拽。
- 保存时校验参数合法性（preset 允许任意值快照）。
- 保存成功的 toast 通知。
