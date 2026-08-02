# Action.yaml 原文编辑器设计

日期：2026-08-02
状态：已确认，待实现

## 目标

点击右栏顶部标题栏，在 `OutputPanel` 区域直接编辑某个 Action 的 `actions/*.yaml` 原文；通过 `Select` 下拉切换编辑不同的 Action。保存即写盘并热重载，下次运行生效。

## 非目标（YAGNI）

- 不支持新建 Action（`Select` 只列已有动作）。
- 不允许修改 yaml 里的 `id` 字段（id 是文件名锚点）。
- 不做语法高亮 / 行号编辑器（用等宽 `Textarea` 即可）。

## 交互入口

- `OutputToolbar`（右栏顶部 `<header>`）的「当前动作标题」区改为可点击按钮：hover 高亮 + tooltip「编辑 yaml」。点击 → `setView("edit")`。
- output 与 form 视图都挂了 `OutputToolbar`，这两个主视图都能进入编辑。
- 退出编辑：依赖侧边栏 Action 点击切换 view（与现有 global / fragments 视图一致），不在编辑视图加专门返回按钮。

## 编辑视图布局

`OutputPanel` 新增 `view === "edit"` 分支，渲染独立组件 `ActionYamlEditor`（不复用 `OutputToolbar`，顶栏内容不同）：

```
┌─────────────────────────────────────────────────┐
│ [SidebarTrigger] [<Select 选 Action ▾>] [重置] [保存] │  顶栏
├─────────────────────────────────────────────────┤
│  <Textarea font-mono，yaml 原文，flex-1 撑满>        │
│                                                      │
├─────────────────────────────────────────────────┤
│  <Alert variant=destructive 校验错误（仅出错时）>    │
└─────────────────────────────────────────────────┘
```

- **Select**：`actions.map(a => ({ value: a.id, label: a.title }))`。切换即换编辑目标，**自动丢弃当前未保存改动，不弹确认**。
- **Textarea**：基于 `ui/textarea`，`font-mono`，受控 `value=text`。
- **进入时默认编辑**：`currentId ?? actions[0]?.id`。
- **加载态**：进入 / 切换后异步拉取 yaml 原文，期间 Textarea 显示「加载中…」（简单文案或 `Skeleton`）。

## 后端改动（`internal/registry` + `internal/api`）

当前缺口：`LoadedAction` 不存源文件路径；无读写 yaml 原文的方法。

1. **`registry.LoadedAction` 增 `File string`**（源文件绝对路径）。`Load` 遍历文件时记录 `filepath.Join(dir, base)`。
2. **`Service` 新增方法**：
   - `GetActionYaml(id string) (string, error)`：从 `s.reg.Actions[id].File` 读原文返回。id 不存在返回错误。
   - `SetActionYaml(id string, text string) (ListResult, error)`：
     1. `yaml.Unmarshal` 解析；解析失败 → 返回错误，不写盘。
     2. 校验解析后 `def.ID == id`（禁止改 id）；不等 → 返回错误「id 不可修改」。
     3. `registry.validate(def)`（复用现有校验：id 格式、title、command 互斥、params/stream 合法性）；不通过 → 返回错误。
     4. 写回 `s.reg.Actions[id].File`（权限不足等写盘错误 → 返回错误）。
     5. `Reload()`：`s.reg = registry.Load(filepath.Join(s.baseDir, "actions"), s.baseDir)`，整体重扫（文件少，简单可靠）。
     6. 返回新的 `ListResult`（用现有 `ListActions` 同样的构造），前端省一次 `ListActions` 往返。
3. **`Reload()` 可与 `ListActions` 共享构造逻辑**：抽一个 `buildListResult()` 内部方法返回 `ListResult`，`ListActions` 与 `SetActionYaml` 末尾都调它。

## 前端改动（`frontend/src`）

1. **`ActionRunnerProvider`**：
   - `view` 类型加 `"edit"`（联合类型扩展为 `"output" | "form" | "global" | "llm" | "fragments" | "edit"`），`setView` 签名同步。
   - 新增封装方法（与现有 IPC 封装风格一致，全部走 context）：
     - `getActionYaml(id: string): Promise<string>`
     - `saveActionYaml(id: string, text: string): Promise<{ actions: ActionItem[]; errors: string[] }>`（成功后内部 `setActions` / `setErrors` 刷新列表）。
2. **`OutputPanel`**：新增 `view === "edit"` 分支 → `<main><ActionYamlEditor /></main>`。
3. **`OutputToolbar`**：标题 `<span>` 改为 `<button>`（或加 `onClick`），点击 `setView("edit")`；加 hover 态 + tooltip。仅样式变化，不动右侧停止/清空/复制/语言按钮。
4. **新组件 `ActionYamlEditor`**（局部 state，不进 context）：
   - state：`editingId`、`text`、`dirty`、`loading`、`saving`、`error`。
   - mount / `editingId` 变化时调 `getActionYaml(editingId)` → set text、清 dirty、清 error、set loading。
   - `editingId` 初始值：`currentId ?? actions[0]?.id ?? null`。切换 Select 直接 set editingId（自动丢弃，无确认）。
   - Textarea `onChange` → set text + dirty=true。
   - 保存按钮 `disabled={!dirty || saving || loading}` → 调 `saveActionYaml(editingId, text)`：成功清 dirty/error、提示「下次运行生效」；失败 set error（Alert 展示），保留 text 供继续修改。
   - 重置按钮：重新 `getActionYaml(editingId)` 覆盖 text、清 dirty/error。
   - `actions` 为空：Select 空、Textarea 禁用、显示「无 action」空态。
5. **Select** 用 `ui/select`（base-ui）。

## 数据流

```
点击 OutputToolbar 标题 → setView("edit")
  → ActionYamlEditor mount，editingId = currentId ?? actions[0].id
  → getActionYaml(editingId) → 渲染原文
用户编辑 Textarea → dirty=true
点保存 → saveActionYaml(id, text)
  → 后端 解析 → 校验 id 不变 → validate → 写盘 → Reload → 返回新 ListResult
  → 前端 setActions/setErrors 刷新侧栏列表，清 dirty
点 Select 切换 → editingId 改变 → 自动丢弃旧改动 → getActionYaml(新 id) → 渲染
```

## 错误处理与边界

| 场景 | 行为 |
|---|---|
| yaml 语法错 | 后端返错误，前端 Alert 显示，不写盘、不清 dirty |
| `validate` 校验失败（如缺 title、stream 非法） | 同上 |
| 用户改了 id 字段 | 后端拒绝：「id 不可修改」 |
| action 正在运行时编辑保存 | 安全：运行用内存副本；重载 registry 不影响在跑的 cancel ctx；提示「下次运行生效」 |
| `actions` 为空进入编辑 | Select 空、Textarea 禁用、空态提示 |
| 切换 Select 有未保存改动 | 自动丢弃，不提示 |

## 文案（i18n）

新增 key 进 `frontend/src/i18n/locales/{zh,en}.json`：

- `edit.title`「编辑 Action」
- `edit.placeholder`「选择 Action」
- `edit.save`「保存」/ `edit.reset`「重置」
- `edit.loading`「加载中…」
- `edit.empty`「无 Action，可在 actions 目录添加 yaml」
- `edit.runAfterSave`「已保存，下次运行生效」
- `edit.tooltip`「编辑 yaml」（OutputToolbar 标题 hover）

action 的 title/description 与后端 stdout/stderr 不参与 i18n（遵循项目约定）。

## 构建链

改 `internal/api/api.go` Service 方法后必须：

```bash
wails3 generate bindings
cd frontend && npm run build && cd ..
go build -ldflags "-H windowsgui" -o workflow-tool.exe .
```

否则前端调用报「method ID not found」。

## 测试

- **Go 单测**（`internal/registry`、`internal/api` 不依赖 Wails 的部分）：
  - `GetActionYaml` 读原文（含注释保留）。
  - `SetActionYaml`：合法保存 → 文件更新 + 重载后新内容可见；语法错 / 校验错 / 改 id → 返回错误且文件不变。
- **前端 vitest**（遵循项目「查中文文案」模式，参考 `GlobalConfigEditor.test.tsx`）：
  - `ActionYamlEditor` 渲染、Select 切换加载、保存成功刷新列表、校验失败显示错误文案。
