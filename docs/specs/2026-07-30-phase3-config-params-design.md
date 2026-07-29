# Workflow Tool — Phase 3 设计文档：配置与参数系统

- **日期**: 2026-07-30
- **状态**: 设计已确认，待实现
- **技术栈**: Go（Wails v3 alpha2.119）+ React 19 + TS（前端已迁移完成）
- **关联**: Phase 1（`runner`/`registry`/`api`）、前端 React+TS 迁移（已完成）
- **范围**: **仅 Phase 3**（动作参数表单 + 动作级预设 + 全局配置）。Phase 2（多步骤）后续单独设计。

---

## 1. 背景与目标

Phase 1 动作命令里的 `${VAR}` 只能从**环境变量**取值，用户无法在 UI 里输入。典型痛点：`scrape-to-md` 动作依赖 `${URL}`/`${OUTPUT_DIR}`/`${NAME}`，使用者必须先在系统里设好环境变量才能跑——违背"开箱即用"。

Phase 3 让动作：

1. **声明参数**（YAML `params`）：用户运行时在 UI 表单填写（文本/布尔/下拉/路径）；
2. **作者预设**（YAML `presets`）：一个动作定义几套常用参数值，侧边栏列为子项——**双击直接运行、单击进表单微调**；
3. **全局配置**（单独 `config.yaml`）：跨动作共享的变量（如 `OUTPUT_DIR`），侧边栏有独立入口、右侧编辑，所有动作可读。

`Runner` 接口 `Run(ctx, params, emit)` 早在 Phase 1 就为 `params` 预留——Phase 3 让 **params 契约在 Runner 层真正落地：所有 Runner 实现都接收并用 params 做变量替换**（Phase 3 的 `ShellRunner` 是首个实现，Phase 2 的 `WorkflowRunner` 将来同样），接口签名一字不改。

---

## 2. 范围边界

| 类别 | 是否改动 |
|------|----------|
| `Runner` 接口 `Run(ctx, params, emit)` | **不改**（兑现 Phase 1 设计承诺） |
| `registry`（schema、变量替换时机、全局加载） | **扩展** |
| `runner`（`ShellRunner` 用 params 替换） | **扩展** |
| `api`（`RunAction` 加 params、全局配置方法） | **扩展** |
| 前端（Provider 状态 + 新组件 + 视图切换） | **扩展** |
| Phase 2（多步骤）/ Phase 4（条件分支） | **不做**（后续单独设计） |

---

## 3. 数据模型与 YAML Schema

### 3.1 动作 YAML 扩展（`ActionDef` 加 `params` + `presets`）

```yaml
id: scrape-to-md
title: 抓网页转 Markdown
icon: 🌐
params:                          # 参数定义（运行时表单按此渲染）
  - id: URL
    label: 网址
    type: text                   # text | bool | select | path
    required: true
  - id: OUTPUT_DIR
    label: 输出目录
    type: path
    required: true
  - id: NAME
    label: 文件名
    type: text
    default: page
  - id: OPEN_AFTER
    label: 完成后打开
    type: bool
    default: false
  - id: MODE
    label: 模式
    type: select
    options: [fast, full]
    default: fast
presets:                         # 作者定义的预设（每组一整套 params 值）
  - name: 首页
    values: { URL: https://example.com, NAME: homepage }
  - name: 文档站
    values: { URL: https://docs.example.com, OUTPUT_DIR: D:/docs }
command:
  shell: defuddle-cli convert "${URL}" -o "${OUTPUT_DIR}/${NAME}.md"
  cwd: ${OUTPUT_DIR}
  timeout: 90s
```

### 3.2 结构体字段

**`ParamSpec`**：

| 字段 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `id` | string | ✅ | 参数标识，`${id}` 引用；`^[a-zA-Z_][a-zA-Z0-9_]*$` |
| `label` | string | ✅ | 表单显示名 |
| `type` | enum | ✅ | `text` / `bool` / `select` / `path` |
| `required` | bool | ❌ | 默认 `false` |
| `default` | string | ❌ | 默认值（bool 类型为 `"true"`/`"false"`） |
| `options` | []string | select 必填 | 下拉可选项 |

**`Preset`**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 侧边栏显示名 |
| `values` | map[string]string | `{参数id: 值}`，不必全填（缺的用 `default` 或表单补） |

### 3.3 全局配置 `config.yaml`

与 `actions/` 同级的单独文件，**简单 key-value**（值均为字符串）：

```yaml
OUTPUT_DIR: D:/pages
PROJECT_DIR: D:/myproject
```

动作用 `${OUTPUT_DIR}` 引用。侧边栏有独立入口、右侧编辑（增删改行 + 保存写回）。

---

## 4. 变量替换语义

**关键变化**：Phase 1 的 `expandVars` 发生在 **Load 阶段**（从 env）；Phase 3 把它**移到运行时**，让 params/全局能参与。

- **替换时机**：`RunAction` 调用时（不再在启动加载时）。
- **取值优先级**：`params`（表单/预设值）> **全局 `config.yaml`** > **环境变量**。
- **未定义**：三者都无的 `${VAR}` 保留原样 + 记一条 warning（不报错）。
- **适用范围**：`shell` / `script` / `cwd` / `env` 的值都走同一替换。
- **向后兼容**：旧动作无 `params`/`presets`，`RunAction(id, {})` 等价 Phase 1 行为（env 替换仍在，只是改到运行时做）。

---

## 5. 后端架构

### 5.1 `registry` 改动

- `ActionDef` 加 `Params []ParamSpec` + `Presets []Preset`。
- `expandVars` **从 Load 移除**——Load 只存 raw 字段、不再做 `${VAR}` 替换（替换逻辑移到 runner 包）。
- 新增 `LoadGlobal(path) (map[string]string, error)` / `SaveGlobal(path, kv) error`——读写 `config.yaml`。
- 校验补充：`select` 必须有 `options`；`type` 在合法枚举内；`ParamSpec.id` 唯一。
- 原有校验（`id` 正则、`title` 必填、`shell`/`script` 互斥）保留。

### 5.2 `runner` 改动

- `Expand` 逻辑移入 runner 包（**共享工具函数**，供所有 Runner 实现调用）。
- **所有 Runner 实现都接收并用 `params`**：`ShellRunner.Run(ctx, params, emit)` 对 `shell`/`script`/`cwd`/`env` 做 `${VAR}` 替换（来源 `params`，回退 `env`），再 `exec`。这是 Runner 层的通用契约——Phase 2 的 `WorkflowRunner` 将来对其每个步骤同样调用 `Expand`。
- `Runner` 接口 `Run(ctx, params, emit)` **签名不变**。

### 5.3 `api` 改动（改后需 `wails3 generate bindings`）

- `RunAction(id)` → **`RunAction(id, params map[string]any) error`**。
  - 内部：`merged = globalConfig` 浅拷贝 → 用 `params` 覆盖（参数优先）→ `ShellRunner.Run(ctx, merged, emit)`。
- 新增 `GetGlobalConfig() map[string]string`（返回内存中的全局配置）。
- 新增 `SetGlobalConfig(kv map[string]string) error`（写回 `config.yaml` + 刷新内存）。
- `ListActions()` 的 `ActionItem` 扩展，带回 `Params` + `Presets`（前端据此渲染表单与预设子项）。
- `running` 仍按 `actionID` 单实例锁（Phase 3 不引入并发；Phase 2 再升级 `runID`）。

### 5.4 运行时数据流

```
前端 runAction(id, params)
  → api.RunAction(id, params)
  → merged = globalConfig 合并 params（参数覆盖全局）
  → ShellRunner.Run(ctx, merged, emit)
  → ShellRunner 用 merged 替换 ${VAR}（回退 env）→ exec
  → 事件流 action:{id}:output / done（不变）
```

替换优先级等价 **params > 全局 > env**（合并时参数已覆盖全局，runner 再回退 env）。

---

## 6. 前端架构

### 6.1 `ActionRunnerProvider` 状态扩展

| 新增状态 | 类型 | 说明 |
|----------|------|------|
| `globalConfig` | `map<string,string>` | 全局配置 kv（启动 `GetGlobalConfig` 拉取） |
| `formValues` | `map<string,string>` | 当前表单值（点动作/预设时填充） |
| `view` | `"output" \| "form" \| "global"` | 右侧当前视图 |

方法扩展：

- `runAction(id)` → **`runAction(id, params)`**；
- `selectPreset(actionId, presetName)`：把预设 `values` 填入 `formValues` + 切 `view="form"`；
- `saveGlobalConfig(kv)`：调 `SetGlobalConfig` + 更新 `globalConfig`。

### 6.2 新组件

| 组件 | 职责 |
|------|------|
| `ParamForm` | 按当前动作 `ParamSpec` 渲染：text 输入框、bool 开关、select 下拉、path（输入框 + 「选择」按钮调 Wails 文件对话框 + 拖拽区）；底部「运行」按钮 |
| `PresetList` | sidebar 动作项展开后的预设子项（单击=进表单、双击=直接运行） |
| `GlobalConfigEditor` | 右侧 key-value 表格（增/删/改行）+「保存」按钮 |

### 6.3 sidebar 改造

- 动作项带 chevron，可展开 → `PresetList`（预设子项）。
- 底部加「⚙ 全局配置」入口 → 切 `view="global"`。

### 6.4 右侧视图切换（`OutputPanel` 按 `view` 条件渲染）

- `output`：Phase 1 的工具栏 + 终端区（现状）。
- `form`：`ParamForm`（当前动作，预填 `formValues`）。
- `global`：`GlobalConfigEditor`。

### 6.5 交互流程

| 操作 | 行为 |
|------|------|
| 点**无 params** 动作 | 直接 `runAction(id, {})` → `view=output` |
| 点**有 params** 动作 | `view=form`，空表单（`default` 预填） |
| **单击**预设 | `selectPreset` → `view=form`，`formValues` 填该预设值，可改后运行 |
| **双击**预设 | `runAction(id, preset.values)` → `view=output` |
| 点「⚙ 全局配置」 | `view=global`，编辑保存（写回 `config.yaml`） |
| 路径参数 | 输入 + 「选择」按钮（Wails 对话框）+ 拖拽文件到输入框 |

---

## 7. 路径选择器与拖拽

- **「选择」按钮**：调用 Wails v3 文件对话框（`alpha2.119` 的对话框 API，实现时核对具体调用方式），**选目录** → 填入输入框（覆盖 `OUTPUT_DIR` 类场景；"选文件"需求后续按需扩展为 `path` + 方向选项）。
- **拖拽**：HTML5 拖拽——把文件拖到 path 输入框，取 `file.path` 填入。
- 两者都只是"填值"，最终仍走 `${VAR}` 替换注入命令。

---

## 8. 校验

- `required` 参数未填：「运行」按钮禁用 + 字段标红。
- `select` 值必须在 `options` 内。
- `path` 不做强存在性校验（交给运行时命令自身处理）。
- 校验在前端表单层做（提交前），后端信任前端传来的 params。

---

## 9. 测试策略

| 层 | 测什么 | 怎么测 |
|----|--------|--------|
| registry | `ParamSpec`/`Preset` 解析与校验（`select` 必须有 `options`、`type` 合法、`id` 唯一）；`LoadGlobal`/`SaveGlobal` 读写；Load 存 raw 不再替换 | 临时目录造测试 YAML |
| runner | `ShellRunner.Run` **用 params 替换** `${VAR}`（params 优先、回退 env、未定义保留+warning） | emit 写 slice 断言 |
| api | `RunAction(id, params)` 合并 global+params；`ListActions` 带回 params/presets；`GetGlobalConfig`/`SetGlobalConfig` | 事件 recorder + 临时 config.yaml |
| 前端 | `ParamForm` 四类型渲染 + required 校验；`PresetList` 单击/双击；`GlobalConfigEditor` 保存；Provider 新状态 | Vitest + Testing Library（jsdom mock 已就绪） |

---

## 10. 明确不做（YAGNI）

- 用户运行时另存预设（预设**仅 YAML 作者定义**）。
- 全局配置的多套预设/切换（全局就是单个 `config.yaml`）。
- 复杂参数类型（日期/颜色/多选/富文本）。
- 参数运行历史记忆（不存上次值，只认 `default`）。
- 路径存在性强校验。
- 多步骤编排（Phase 2）、条件分支（Phase 4）。
- 动作热重载（改 YAML 仍需重启）。

---

## 11. 验收标准

- [ ] 旧动作 `hello`/`deploy`（无 params）行为完全不变（向后兼容）
- [ ] `scrape-to-md` 加 `params` 后：点动作弹表单 → 填 URL/目录/名称 → 运行，值正确注入命令
- [ ] 预设：单击进表单预填、双击直接运行
- [ ] 全局 `config.yaml` 的 `OUTPUT_DIR` 被动作 `${OUTPUT_DIR}` 读到；右侧编辑保存写回文件
- [ ] 路径参数：选择按钮（Wails 对话框）+ 拖拽均可用
- [ ] `required` 未填时「运行」禁用
- [ ] 替换优先级 params > 全局 > env 正确（三者同名时 params 生效）
- [ ] 四层单测全绿；`npm run build` + `go build` + exe 联调通过
- [ ] 改 `api.go` 后 `wails3 generate bindings` 重跑，前端类型同步

---

## 12. 向后兼容与风险

| 项 | 说明 |
|----|------|
| 向后兼容 | `yaml.Unmarshal` 不拒绝未知字段，加 `params`/`presets` 不破坏旧动作；旧动作 `RunAction(id,{})` 等价 Phase 1 |
| 替换时机迁移 | `expandVars` 从 Load 移到运行时是行为变更：旧动作的 `${VAR}` 现在运行时（而非启动时）解析——结果一致（仍 env），但错误暴露时机延后到运行 |
| Wails alpha2 对话框 | 文件对话框 API 需在实现时核对 `alpha2.119` 的具体调用（alpha 版可能变动） |
| `ActionItem` 扩展 | 改 `api.go` 的返回结构 → 必须 `wails3 generate bindings`，否则前端类型不同步 |
| `Runner` 接口 | 真的不改；**所有 Runner 实现都用 params**（ShellRunner 首个，后续 WorkflowRunner 同样），为 Phase 2/4 守住稳定根基 |
