# logcat 过滤强化（统一规则 + chip 面板 + 后端重放）设计

> 日期：2026-08-18
> 类型：功能增强（修改 `internal/adb/logcat`、`internal/api`、`frontend/src/components/LogcatView.tsx`）
> 状态：定稿（grilling 四轮收敛 + 三变体原型验证，变体 A「控制甲板」胜出）

## 背景与目标

现有 [`actions/adb-logcat-stream.yaml`](../../../actions/adb-logcat-stream.yaml) 的过滤分两层：

1. **后端启动预过滤**（PACKAGE/LEVEL/TAG/INCLUDE/EXCLUDE，运行期不可变，改了要重启动作）；
2. **前端运行时过滤**（[`LogcatView.tsx`](../../../frontend/src/components/LogcatView.tsx)：minLevel 下拉 + tag 子串框 + message 子串框）。

前端层只有「子串包含」，无排除、正则、精确匹配、pid/tid 维度、取反、补全建议，交互表达力远弱于 Android Studio Logcat。

**目标**：参考 AS Logcat，把过滤表达力与交互全面强化，并把两层收敛为——

- **一套规则模型**（TS 类型与 Go struct 对齐的结构化 token 数组）；
- **一个求值器**（Go 后端，前端零过滤逻辑）;
- **一个编辑器**（前端 labels/chip 面板，运行期随时向后端下发规则变更）。

## 核心架构决策

| # | 决策 | 内容 |
|---|------|------|
| 1 | 统一规则 + 运行期下发 | 过滤规则为结构化 token 数组；后端是唯一求值器；前端随时下发变更 |
| 2 | 后端 raw ring + 重放 | 后端保留 10k 条原始环形缓冲；规则变更时重筛整个 ring，整体重发（放宽条件可找回 ring 内历史） |
| 3 | 下发通道 | 新增 Wails 绑定 `UpdateLogcatFilter(actionId, rule)`，按动作 id 寻址（同 `CancelAction`）；未运行/非 logcat 动作返回 error；发送侧 300ms 防抖 |
| 4 | 重放帧协议 | 新 stream 值 `"logcat-replace"`：首帧即前端清空替换；帧附 `matched/total` 计数 + top-N(~200) tag 直方图；大结果集按 ~500/批分 chunk |
| 5 | 清空联动 | 「清空」同时清前端缓冲与后端 ring，否则重放会让已清行复活 |
| 6 | 容量 | 后端 ring 10k，前端缓冲 4000→10000，渲染窗口仍 1500 |
| 7 | 启动兼容 | yaml 5 参数原样保留；启动时映射为规则初始值，preset values 语法不变 |

## 规则模型

```go
// token：一条过滤原子（TS 端结构完全对齐）
type Token struct {
    Key     string // "tag" | "message" | "pid" | "tid" | "any"
    Op      string // "contains" | "exact" | "regex"
    Negated bool
    Value   string
}
type Rule struct {
    Tokens   []Token
    MinLevel string // V/D/I/W/E/F 阈值，下拉唯一入口
    Package  string // 运行期可切换（后端换 pid 集），非 chip 可编辑项
}
```

**输入语法**（面板内）：

- `key:value` 子串、`key=:value` 精确、`key~:value` 正则、`-key:value` 取反；
- 裸词 = `any:`（tag 或 message 子串命中即通过）；
- `message` 别名 `msg`；值含空格用引号（`message:"foo bar"`）；
- `pid` / `tid` 只支持精确整数值（`pid:1234`，无子串语义）；
- **大小写**（原型定稿）：contains 不区分大小写；exact 区分；regex 区分（Go/JS 均不传 `(?i)`，需要不区分时用户写 `(?i)`）；
- 空格/回车/Tab 固化；Backspace 于空输入时删除末位 chip。

**布尔语义**：同 key 多个正向 token OR；跨 key AND；取反 token 独立排除（多个取反 = 全部规避）。不做括号分组（AS 同款，YAGNI）。

**level**：不进 chip 面板——下拉仍是唯一入口，但阈值并入统一规则对象随后端一起下发（后端预筛，减少重放噪音）。

**package**：启动参数 + 运行期 preset 整体替换时切入（复用现有 5s 周期 pid 重解析，不用重启流）；过滤栏显示**只读 `pkg:` chip**（preset 带入，点 × 移除 = 回全量进程），不可手动编辑。

## 交互设计（两行式控制甲板，原型变体 A 定稿）

整体视觉延用「精密控制台」体系，不新增主题色；全部 mono。**第一行·场景层**放「人起名的」东西，**第二行·查询控制台**放语法——这是两行的信息架构分工：

### 第一行 · 场景层
- level 下拉（保留 level 色，唯一入口，读写 Rule.MinLevel）；
- 只读 `pkg:` chip（preset 带入，点 × 移除 = 回全量进程）；
- preset 分段条：键面背面「点+名」行语言横排化（size-[5px] primary/45 点 + mono 名，hover `bg-primary/10`）；运行期点击 = **整体替换**（映射见下）+「⟲ 重置」按钮；仅运行中可用；
- 右对齐 **matched/total 仪表读数**：tabular-nums，重放落帧 240ms 单次脉冲；0 命中时转 destructive 并附「删除一个条件放宽，或点 ⟲ 重置」提示。

### 第二行 · 查询控制台（签名元素：chips 即语法）
- chips 按算子语义着色，控制台边用边教自己的语言：**精确 `=:`=success 绿（锁定）、正则 `~:`=chart-4 蓝（模式机械）、子串 `:`=中性 muted（默认，安静）、取反 `−`=destructive 红前缀符**；key 名 muted / 值 foreground（复刻 logcat 行自身 `LEVEL TAG: message` 语法）；
- **草稿态**：未固化文本以虚线边框 chip 形态呈现（看得见它已参与过滤、也看得见未定稿），随防抖即时生效；
- chip 点击弹小菜单：**取反 / 转正则 / 删除**；× 直接删；
- 空规则时占位文案教语法：`tag: pid: message: 裸词 · 空格固化 · =:精确 ~:正则 -:排除`；
- 控制台右端常驻 top-4 tag 直方图快捷条（tabular-nums 计数），点击 toggle 精确 tag chip——tag 补全的高频路径不进下拉；
- 输入焦点弹补全层：key 补全（输 `ta` 提示 `tag:`）+ tag 值补全（重放帧直方图，频次排序，右对齐计数，Tab/点击接受，选中项 `bg-primary/10`）；message 值不补全。

### 行内交互（日志区）
- time 与 level 之间常驻 **dim tabular pid 列**（行内点 pid 的前提；tid 不渲染，仅手打）；
- tag 列 / pid hover 虚线下划线，点击 toggle 对应精确 chip（`tag=:值` / `pid:1234`），已命中时转 primary 高亮。

## 原型验证记录（mockup）

- 位置：`frontend/src/mockup/`（MockupPage + 三变体 + 共享 mock 引擎），`#mockup-logcat?variant=A|B|C` hash 门控，←/→ 切换、深浅主题可切；
- 结论：**变体 A「控制甲板」胜出**；B（AS 单行查询栏）的 preset-注入文本与 `ƒ` 前缀、C（面板块控台）的直方图快捷条作为局部想法已吸收进 A（A 的控制台右端快捷条即来自 C）；
- mock 引擎（`mockLogcat.ts`）的解析/求值语义与大小写约定按本 spec 定稿，实施时可直接作为 Go 求值器与 TS 解析器的对照参考；
- 处置：真实实现合入 LogcatView 后，`frontend/src/mockup/` 整体删除（throwaway，不留在 main）。

## 启动参数映射（向后兼容）

| yaml 参数 | 映射 |
|-----------|------|
| LEVEL | MinLevel（下拉初值） |
| TAG（空格分隔） | 每值一个 `tag contains` token |
| INCLUDE | `message contains` token |
| EXCLUDE | `-message contains` token |
| PACKAGE | Package 字段（只读 chip 显示） |

## 错误处理

- **非法正则**：chip 固化瞬间前端 JS RegExp 试编译，拒绝固化 + 输入框红字提示；后端收到非法规则防御性拒绝（返回 error），沿用旧规则继续跑。不静默降级为字面量（避免误导排查）。

## 条件组（link 机制，2026-08-19 增补）

组合过滤需表达「Tag + Message 同时满足」以及「组合之间任选其一」。Token 增加 `link` 字段（json `link,omitempty`，TS `link?: "and" | "or"`）作为组间连接符：

- `"or"`：此 token **另起条件组（combo）**；组间 OR：任一组完全命中即通过；
- `"and"` / 缺省：并入当前组（默认，追加行为与旧版一致）。

组内语义不变：同 key OR、跨 key AND（每组建 per-key 桶）；取反 token 仍是全局排除（link 忽略、不校验）；首个正向 token 的 link 无前组可切、等同并入。**无任何 or-link 的规则 = 单组 = 旧语义，向后兼容**（旧 preset / 手写 FILTER 不受影响）。未知 link 值由 CompileRule 硬失败（不静默降级）。

UI（mockup `?mockup=logcat-link` 定稿）：控制台分段渲染——条件组为主题色虚线框（`border-dashed border-primary/50`），组间主色加粗 ∨（点击 toggle 为 ∧ 并入前组），组内弱 ∧（点击另起一组；同 key 并入时 tooltip 说明「桶内任一命中」）；取反 chip 裸渲染在框外。chip 菜单也提供「∨ 另起一组 / ∧ 并入前组」。序列化仅 `link:"or"` 写出（and/缺省省略，减 yaml 噪音）。

局限（接受）：组内同 key 仍为 OR（`tag:A ∧ tag:B` 需正则表达）；括号任意嵌套仍不做。

## 不在范围（YAGNI）

- 括号嵌套分组（条件组一层 ∨ 切分已覆盖主场景）；查询历史 / 命名过滤器（用启动 preset 覆盖，可后续强化 preset）；
- `logcat-batch` 落盘动作不动（仍用旧 filter 入口）；
- 设备端历史回溯（`-T 1` 语义不变，ring 只含本次启动后的行）；
- 性能专项优化（10k ring + 防抖重筛已够；后续有需要再做预索引）。

## 测试策略

- **Go 单测**：token 语义矩阵（同 key OR / 跨 key AND / 取反 / 正则 / 精确 / pid / tid / 裸词）；非法正则拒绝；重放分 chunk 与 matched/total；ring 截断。
- **前端测试**：语法解析（`key:` / `=:` / `~:` / `-` 前缀 / 引号 / 裸词）、params→规则映射、`logcat-replace` 帧处理、防抖下发。
- **手动矩阵**：preset 运行期整体替换（含切包）、行内点击 toggle、收窄→放宽恢复历史、清空联动、非法正则提示、补全层。

## 涉及文件

- 修改：`internal/adb/logcat/filter.go`（规则模型+求值器）、`internal/adb/logcat/logcat.go`（ring/重放/规则通道）、`internal/api/`（`UpdateLogcatFilter` 绑定）、`frontend/src/components/LogcatView.tsx`（labels 面板）、`frontend/src/context/ActionRunnerProvider.tsx`（规则状态/帧处理/防抖）、`frontend/src/types/events.ts`、`frontend/src/i18n/locales/{zh,en}.json`
- 不动：`actions/adb-logcat-stream.yaml`（含现有 preset）、`logcat-batch`、`scripts/adb-logcat.*`
