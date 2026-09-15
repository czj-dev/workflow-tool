# logcat 命中高亮（marks 协议 + 面板渲染）设计

> 日期：2026-09-15
> 类型：功能增强（修改 `internal/adb/logcat`、`frontend/src/components/LogcatView.tsx`、`frontend/src/lib/logcatMarks.ts`）
> 状态：定稿（grilling 多轮收敛，后端产区间 + 前端纯渲染）

## 背景与目标

[`2026-08-18-logcat-filter-chips-design.md`](./2026-08-18-logcat-filter-chips-design.md) 落地后，过滤求值全在后端，前端只见命中集。用户看到一行日志被留下，但**不知道是哪个条件、命中在哪个子串**——多条件组合时只能脑内复现匹配。

**目标**：命中处（tag/message 的子串、pid 整格）以 per-token 颜色半透明背景标记；chip 上加同色色点作「颜色↔条件」图例。日志不因高亮改变文本与 level 色。

## 核心决策

| # | 决策 | 内容 |
|---|------|------|
| 1 | 后端产结构化区间 | `CompiledRule.Marks(e)` 在求值侧枚举命中区间；前端零匹配逻辑（不复算、不二次求值） |
| 2 | 协议四元组 | `marks?: number[][]`，每项 `[t, f, s, l]`（见下）；`omitempty`，无命中不下发 |
| 3 | 8 色序位调色板 | CSS `--mark-1..8`（半透明背景）+ `--mark-h-1..8`（实色，chip 色点）；色号 = token 序位 `t % 8 + 1`，超过 8 个条件循环复用 |
| 4 | 全出现处标记 | contains/regex 标全部出现（非重叠、从左到右）；exact 命中即整域 |
| 5 | 重叠后者覆盖 | 多 token 命中重叠区间，按 (t,f,s) 升序后者覆盖（排序即覆盖优先级） |
| 6 | 无截断上限 | marks 数量不封顶：logcat 行文本本身被系统截断（~4k），天然有界 |
| 7 | filterError 熄灭 | 规则被后端拒绝（`logcatFilterError` 非空）时行内高亮整体熄灭（后端已回退旧规则，marks 与所见规则不同源）；chip 色点纯前端，保留 |

## marks 协议

```
LogcatEntry.marks?: number[][]   // 每项 [t, f, s, l]
```

- **t** = token 在下发 `Rule.Tokens` 中的原下标（定色用；草稿 token 同样计数，`toApiRule` 保序故 chip 色点与行内高亮同源）；
- **f** = 域码：`0` message / `1` tag / `2` pid；
- **s, l** = 命中子串在该域字符串内的起点与长度，**单位 UTF-16 code unit**——与 JS string 索引严格一致。Go 侧所有偏移经 `u16Index` 换算（regex 的 RE2 字节偏移亦然）；含中文/emoji 的行用字节偏移必错位；
- 排序：输出按 `(t, f, s)` 升序（= 覆盖优先级，前端后者覆盖）。

**产出域**：正向 token 中 `tag→f=1`、`message→f=0`、`pid→f=2`（整格，值即十进制串）、`any→tag 与 message 双域各标`；`tid` 面板无列不产出，`minLevel/package/取反` 永不产出（取反命中的行不在通过集）。

**语义**：与 `Allow` 对齐但相互独立——无论哪个条件组促成放行，**所有正向 token 的命中都枚举**（高亮回答「哪些条件命中了此行」，非「哪条路径放行」）。

**传输**：随既有 logcat/logcat-replace JSON 通道（`logcatPayload.Marks` → `OutputEventData.line` → `pushLogcatBatch`/`applyLogcatReplace` 逐字段透传），零 Wails 绑定变更。前后端同包原子发布，无版本兼容矩阵。

## 前端渲染

- `frontend/src/lib/logcatMarks.ts`：`splitMarked(text, marks, field)` 按域过滤出命中段（per-code-unit owner 数组，重叠后者覆盖，越界/非法四元组钳制跳过，永不抛错）；`markColorOf(idx)` 序位取色；`fieldMarkColor` 取 pid 整格色。
- `LogcatView.tsx`：message/tag 经 `MarkedText` 切分渲染（命中段 `rounded-[2px] px-px` + `background: var(--mark-N)`，文字色继承父级——level 色不被覆盖）；pid 按钮整格背景；chip 左侧 5px 实色点（`--mark-h-N`）即图例。

## 否决过的方案

- **前端复算匹配**（只传 token，前端 JS 再匹配）：需在前端维护一份影子求值器——contains 大小写折叠、RE2 语法子集、`any` 双域语义都要与 Go 侧保持一致，且 JS 正则回溯语义与 RE2 有漂移风险。弃。
- **哨兵文本包裹**（后端把命中子串用 `[[...]]` 等定界符包好直接给文本）：污染日志文本（复制/搜索全带哨兵），且定界符与日志原文碰撞无解。弃。
- **marks 数量封顶**（防极端行撑爆帧）：logcat 系统本身截断长文本，行有天然上界；先验封顶反而引入「截断后高亮残缺」的暗坑。不设。

## 测试策略

- **Go**（`rule_test.go`）：contains 全出现处；UTF-16 偏移（中文/emoji，regex 字节→UTF-16 换算）；域码与算子矩阵；any 双域；排序与覆盖；取反/nil 无产出；`entryJSON` omitempty。
- **前端**（`logcatMarks.test.ts` + `LogcatView.test.tsx`）：切分（域过滤/重叠/钳制/相邻不合并）；色号循环；三域渲染落位与序位色；chip 色点图例；filterError 熄灭行内高亮、色点保留。

## 涉及文件

- 修改：`internal/adb/logcat/rule.go`（`Marks`/`u16Index`/`regexMarks`/`containsMarks`）、`internal/adb/logcat/logcat.go`（`logcatPayload.Marks`）、`internal/adb/logcat/stream.go`（onLine / buildReplaceFrames 两处接入）、`frontend/src/types/events.ts`（`marks?: number[][]` 镜像注释）、`frontend/src/index.css`（`--mark-*` 双主题）、`frontend/src/components/LogcatView.tsx`（`MarkedText`/chip 色点/pid 整格/filterError 闸门）
- 新增：`frontend/src/lib/logcatMarks.ts`（+ `.test.ts`）
- 不动：Wails 绑定、`UpdateLogcatFilter`、yaml 参数、`logcat-batch`
