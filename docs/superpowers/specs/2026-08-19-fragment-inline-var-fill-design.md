# Fragments 缺失变量就地填写

## 背景

片段（`fragments.yaml`）的内容里可以写 `${VAR}` 引用全局配置（`config.yaml`）的变量。当前 `copyOne` 只用 `globalConfig` 展开，**未定义的变量原样保留 `${VAR}` 进剪贴板**——粘到终端/IDE 后还得手动改。

典型场景：片段里带一个临时文件路径 `${APK_PATH}`，每次都不一样，不值得写进全局配置，但每次复制后都要手改。

## 目标

点击内容预览里的缺失变量 pill，就地变成输入框，输入的文本作为该变量的临时值参与复制展开。

## 非目标（YAGNI）

- 不持久化临时值（不写 localStorage、不写 YAML）。刷新/切视图即失。
- 不允许覆盖已定义的变量（琥珀 pill 保持只读，想改去全局配置改）。
- 不提供「记住这些值」写回 `config.yaml` 的开关。
- 不做弹窗式集中填写表单。

## 交互

`ContentPreview` 中的变量 pill 有三种状态：

| 状态 | 判定 | 样式 | 可点击 |
|------|------|------|--------|
| 已定义 | `globalConfig` 中存在 | 琥珀实底（现状 `bg-primary/12 text-primary`），hover Tooltip 显示全局值 | 否 |
| 已临时填写 | `overrides` 中存在 | 琥珀实底 + 虚线下边框（暗示临时/可改），**显示填入的值**而非变量名，hover Tooltip 显示变量名 | 是（重新编辑） |
| 缺失 | 两者都无 | 红框（现状 `border-destructive/50 text-destructive`），显示变量名 | 是 |

点击可编辑的 pill → 原地渲染为内联 `<input>`：
- 等宽字体、宽度按内容自适应（`size` 属性或 `field-sizing: content`）
- 挂载即 focus 并全选已有值
- **Enter** 或 **失焦** → 提交（空字符串视为取消，pill 回退到缺失态）
- **Esc** → 取消，pill 复原

## 状态

`FragmentsView` 内新增会话态：

```ts
// 临时变量覆盖：fragment 索引 → { 变量名 → 值 }。仅内存，不落盘。
const [overrides, setOverrides] = useState<Record<number, Record<string, string>>>({});
```

- 按 **变量名** 存而非按出现位置 → 同一变量在一条片段里出现多次时，填一次全部生效。
- 按 fragment 索引分桶 → 不同片段的同名变量互不干扰。
- 编辑/删除片段（`saveOne` / `clickDelete`）会改变索引语义，此时清空 `overrides`（简单正确，避免索引错位串值）。

## 复制

`copyOne` 改为：

```ts
const vars = { ...globalConfig, ...(overrides[i] ?? {}) };
await navigator.clipboard.writeText(expandVars(fragments[i].content, vars));
```

仍未填的缺失变量保持 `${VAR}` 原样——与 `internal/runner.Expand` 行为一致。

底部「缺失变量」提示行的统计口径同步收窄为「既无全局定义、也无临时填写」：

```ts
const missing = extractVars(f.content).filter(
  (v) => !(v in globalConfig) && !(v in (overrides[i] ?? {})),
);
```

填完即消失。

## 改动范围

单文件：`frontend/src/components/FragmentsView.tsx`

- `ContentPreview` 新增 props：`overrides: Record<string, string>`、`onSetVar: (name: string, value: string) => void`
- 新增同文件内组件 `EditableVarPill`（pill ↔ input 两态切换、键盘处理）
- `copyOne` 合并 overrides
- `missing` 计算合并 overrides
- `saveOne` / `clickDelete` 清空 overrides

不动：`lib/vars.ts`（`extractVars`/`expandVars` 直接复用）、后端、YAML schema、`FragmentDialog`。

## 测试

补充 `FragmentsView.test.tsx`：

1. 点击缺失变量 pill → 出现 input
2. 输入值 + Enter → pill 显示填入的值，红色提示行消失
3. 点复制 → 剪贴板内容含填入的值
4. 未填的缺失变量 → 剪贴板仍是 `${VAR}` 原样
5. Esc → pill 复原为变量名，剪贴板不受影响
6. 已定义的琥珀 pill 点击无反应（不出现 input）
7. 删除某片段后 → overrides 清空
