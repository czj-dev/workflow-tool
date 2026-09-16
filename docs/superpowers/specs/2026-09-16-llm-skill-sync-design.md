# LLM 动作 Skill 同步机制设计

> 日期：2026-09-16
> 类型：功能增强（修改 `internal/registry`、`internal/actionrun`、`docs/action.md`）
> 状态：定稿（brainstorming 收敛，文件即注册，本期纯后端无 UI）

## 背景与目标

LLM 动作（`command.llm` 形态）经 LLMRunner 以 headless 模式调 CLI（默认 `ducc`，Claude Code 兼容：`-p --output-format=stream-json` 那套 flags）。这类 CLI 会**自动扫描工作目录的 `.claude/skills/`** 并加载其中的 SKILL.md——与 Claudian 的「文件即注册」同一机制。

**目标**：workflow-tool 管理 skill 源文件，动作声明绑定，运行前把绑定的 skill 同步到 Agent 工作目录，由 CLI 自行发现加载。**不做 prompt 拼接、不管 token 预算、零 prompt 层协议**。

## 核心决策

| # | 决策 | 内容 |
|---|------|------|
| 1 | 文件即注册 | skill 同步成 `.claude/skills/<id>/` 文件，CLI 自己发现；不在 prompt/system 层注入任何内容 |
| 2 | 动作声明绑定 | YAML 写 `command.llm.skills: [id...]`，运行前只同步绑定的这几个；名单外的目标文件永不触碰 |
| 3 | 源目录 = 目标格式 | exe 同级新建 `skills/<name>/SKILL.md`（Claude Code 原生格式，可带附属文件）；源=目标格式，同步是纯文件拷贝零转换 |
| 4 | 作用域目录分区，按 CLI 路由表 + agent 运行位置路由 | `skills/` 根 = project 级，`skills/user/` = user 级（全局一次生效）；**SkillRouter 内置「CLI → skill 目录约定」路由表**（claude/ducc → `.claude/skills`，codex → `.codex/skills` + `.agents/skills` 双根）；agent-cwd = 展开后 Cwd，空则 exeDir() 兜底。一次运行的绑定集合按 (作用域, CLI) 分流到多个目标根（一对多：同一 skill 随动作不同 cwd / CLI 多根落到不同目录） |
| 5 | 源为准，比对覆盖 | 绑定名单内：逐「相对路径+内容」比对，不一致覆盖写，目标多余文件删除；一致跳过（幂等） |
| 6 | 路径映射集中在 SkillRouter 类 | 后端单独建 `SkillRouter` 类型维护「绑定 ids → 源/目标路径」映射与同步足迹（持久化账本）；Build 只调用不散落路径拼接；路径全部硬编码约定，**不做配置化**（无 CLAUDE_CONFIG_DIR 适配、无 config.yaml 覆盖） |
| 7 | 同步执行在 actionrun.Build | Build 调 `router.Route()` 算映射、执行同步；api 直跑与 workflow step 两条路径天然一致；runner 保持纯执行单元不被文件 IO 污染 |
| 8 | 失败即动作失败 | skill 是声明的依赖：源缺失（加载时校验拦截）、目标 IO 失败 → 动作直接报错，不静默降级 |
| 9 | 本期无 UI / 无生成 | 纯后端机制，skill 文件手写；前端视图与 AI 生成入口下期再议 |

## 目录布局与作用域路由

```
workflow-tool.exe
├── actions/claude-bug-analyze.yaml   # command.llm.skills: [bug-analyze, git-style]
├── skills/
│   ├── bug-analyze/                  # project 级（根目录即 project 分区）
│   │   ├── SKILL.md                  # frontmatter(name/description) + 正文
│   │   └── references/*.md           # 可选附属文件，整目录同步
│   └── user/
│       └── git-style/                # user 级分区
│           └── SKILL.md
└── workflows/…
```

**位置即作用域**（与 Claude Code 原生「~/.claude/skills vs ./.claude/skills 位置定作用域」同一语义，零 frontmatter 扩展）。两级合并为**单一 id 命名空间**：跨级同名 id 视为冲突，加载时报错（与 action id 冲突同风格）。

**路由表**（同步目标 = f(skill 作用域, CLI, agent 运行位置)，全部集中在 SkillRouter）：

**第一维：CLI → skill 目录约定**（键为 CLI 名小写归一，取 `LLMConfig.CLI`，空则 `defaultLLMCLI`）：

| CLI | project 级目录 | user 级目录 |
|-----|---------------|------------|
| `claude` | `<agent-cwd>/.claude/skills/<id>/` | `~/.claude/skills/<id>/` |
| `ducc`（默认） | 同 claude（CC 兼容） | 同 claude |
| `codex` | `<agent-cwd>/.codex/skills/<id>/` **和** `<agent-cwd>/.agents/skills/<id>/`（双根） | `~/.codex/skills/<id>/` 和 `~/.agents/skills/<id>/` |
| 未知 CLI | **回退 `.claude/skills` + stderr 警告一行** | 同左 |

未知 CLI 回退的理由：能配进 LLM 形态的 CLI 必须兼容 Claude Code headless 协议（`llmFixedArgs` 即 CC 协议），这类生态大概率也沿用其目录约定；回退保证路由永不因表缺失而失败，警告保持可见性。

**第二维：作用域**（源目录位置决定）：

| skill 分区 | 语义 |
|-----------|------|
| `skills/<id>/`（project 级） | 跟随 agent 实际运行目录；动作 cwd 随参数变化时同一 skill 落到不同项目目录（一对多） |
| `skills/user/<id>/`（user 级） | 与 cwd 无关，agent 在任何目录运行都能读到；同步一次全局生效，后续运行比对一致即跳过 |

**agent-cwd 的确定**：`LoadedAction.Cwd` 展开后的终值，非空即用它；为空则**显式用 `exeDir()` 兜底**（与 registry 扫描同源，不依赖子进程「继承父进程 cwd」的隐式语义）——agent 实际在 exe 同级目录运行，skill 落点与之一致。

```
RunAction / workflow step
  → actionrun.Build（解析 llm.skills，cwd 已是展开终值）
  → SkillRouter.Route(ids, agentCwd, cli)（查 registry 元数据 + CLI 路由表，算 SrcDir/DstDir）
  → SyncSkills(items)（比对/覆盖，Build 的副作用）
     └─ 成功后 SkillRouter.Record(items) 更新足迹账本
  → 返回 report 注入 LLMConfig
  → 构造 LLMRunner
  → Run 开头最先 emit report 行 → CLI 自行发现两级 skills 加载
```

## 路径映射维护（`SkillRouter` 类）

后端单独建类集中维护全部路径映射，`actionrun.Build` 只调用不拼接：

```go
// internal/actionrun/skillrouter.go
type SkillRouter struct { /* registry 元数据引用 + 账本 + homeDir 注入 */ }

// cliSkillDirs 是「CLI → skill 目录约定」路由表（包级数据，键小写归一）。
// project 级目标 = <agentCwd>/<dir>/<id>/；user 级目标 = <home>/<dir>/<id>/。
// 同一 CLI 可配多个目录（codex 双根），一个 skill 产出多条 SyncItem。
var cliSkillDirs = map[string][]string{
    "claude": {".claude/skills"},
    "ducc":   {".claude/skills"},          // CC 兼容，与 claude 同约定
    "codex":  {".codex/skills", ".agents/skills"},
}

func (r *SkillRouter) Route(ids []string, agentCwd, cli string) ([]SyncItem, error)
//   cli 取 LLMConfig.CLI（空则 defaultLLMCLI），查表未命中回退 {".claude/skills"} + stderr 警告
//   源路径来自 registry 扫描结果（scope/srcDir），agentCwd 由 Build 传入（空则 exeDir）
func (r *SkillRouter) Record(items []SyncItem) // 同步成功后更新账本并落盘
```

- **路由表是数据不是配置**：新增 CLI 支持只改 `cliSkillDirs` 一处；**不做** config.yaml 覆盖、**不做** `CLAUDE_CONFIG_DIR` 适配（暂不考虑配置化）；
- **LLMRunner 的 CLI 协议不在路由表管辖**：`llmFixedArgs` 仍是 CC headless 协议，`LLM_CLI=codex` 时 skill 能同步但 CLI 调起协议的适配（codex flags 不同）是另一个课题，本期不动；
- **足迹账本**：`skills.synced.json` 落 exe 同级（dev 时项目根，加入 .gitignore），结构 `map[目标根绝对路径][]skillId`，`Record` 时合并去重、路径统一为绝对路径（分隔符归一，Windows 反斜杠）；**Load 时自洁**——丢弃 id 已不存在于源目录的陈旧条目；
- **孤儿策略（本期仅记录不清理）**：账本能识别「目标根同步过、但 id 已不在任何动作绑定集」的孤儿，本期不做自动删除（cwd 动态使跨动作误删风险不可静态排除），清理入口（后端命令或 UI）下期定。

`exeDir()` 扫描约定新增 `skills/` 目录（与 actions/workflows/config.yaml/fragments.yaml 并列）；dev 时回退当前工作目录，规则不变。

## YAML Schema

```yaml
command:
  llm:
    prompt: user_prompt    # 必填，param id
    system: sys_prompt     # 可选，param id
    skills:                # 可选，string[]，skill 目录名
      - bug-analyze
```

校验规则（`registry.validate`，加载时报错风格与 action id 冲突一致）：

- skill id 命名 `^[a-z0-9-]+$`（与 action id 同规则，也是 Claude Code skill 名约定）；
- 每个 id 必须存在对应分区的 `SKILL.md`（project 级 `skills/<id>/SKILL.md`，user 级 `skills/user/<id>/SKILL.md`），缺失即该动作加载失败；
- registry 新增 skills 目录扫描：**两级分区（根 + user/）合并为单一 id 命名空间**，目录名即 id，frontmatter 宽松解析（name/description 可缺，坏 frontmatter 跳过该条不计入可用集）；跨级同名 id 加载时报冲突（与 action id 冲突同风格）。

`skills` 字段位于 `command.llm` 内部，天然不与 run/script/adb 形态混用；四选一互斥校验不受影响。

## 同步算法（`actionrun.SyncSkills`）

```
type SyncItem struct {
    ID, Scope, SrcDir, DstDir string  // Scope: "project" | "user"，仅用于报告行展示
}
SyncSkills(items []SyncItem) (report SyncReport, err error)
// items 由 SkillRouter.Route 产出（路径映射全部集中在 SkillRouter 类）。
// report 含 synced / skipped 两个列表（各带 scope 标注）。
```

对 items 内每个条目（一次运行可含两个目标根的条目，即一对多分流）：

**输出行协议**：Build 层没有 emit 回调，report 不在 Build 时直接推送——注入 `LLMConfig.SkillSyncReport`，由 `LLMRunner.Run` 开头（CLI 子进程启动前）最先逐行 emit 为普通 `stdout` 流。好处：输出协议仍集中在 runner 一处，api 直跑与 workflow 两条路径自动一致，且报告行天然成为 LLM 会话的第一条可见输出。

1. **比对**：walk `srcRoot/<id>/`，按「相对路径 + 文件内容」与 `dstRoot/<id>/` 对应文件比对；
2. **一致** → 跳过（重试/重复运行幂等）；
3. **不一致或缺失** → 逐文件覆盖写（MkdirAll 递归建目录）；目标里源没有的多余文件删除；
4. **名单外** → 永不触碰。用户手写的非绑定 skill 不会被删；但**绑定名单内的同名 skill 会被源覆盖**——绑定即声明所有权。

**不做目录级先删后拷**：中途失败最多留旧文件，不留空目录（Windows 下目录级原子 rename 不可靠，不做）。符号链接/二进制文件按普通文件字节读写作比对，不特殊处理。

报告行格式（Runner 自发，不经 CLI 输出解析，因此**不进 `Result.Stdout`**——保持其纯 assistant text 语义供 workflow `if` 引用；作用域随行标注）：

```
[skill-sync] bug-analyze(project) → D:\proj\.claude\skills\bug-analyze
[skill-sync] git-style(user) → C:\Users\ASUS\.claude\skills\git-style
[skill-sync] card-convert(project) 已是最新，跳过
```

**并发**：同一动作并发运行已被现有机制拒绝；不同动作同步同一目标目录属跨动作并发写文件，文件级覆盖写在最坏情况下后写者胜，可接受，不加锁。

## 错误处理

| 场景 | 行为 |
|------|------|
| `llm.skills` 引用的 id 在 skills/ 两级分区均不存在 | registry 加载时校验失败，动作不可运行 |
| 跨级同名 id（`skills/<id>/` 与 `skills/user/<id>/` 并存） | registry 加载时报 id 冲突 |
| SKILL.md 运行时被外部删除（加载时存在） | Build 时 SyncSkills 报错，动作失败 |
| 目标目录写失败（权限/占用） | SyncSkills 报错，动作失败，stderr 带路径 |
| user 级目标 `~/.claude/skills/` 不可写 | 同上，动作失败（user 级 skill 同样是声明的依赖） |
| 坏 frontmatter | 加载时跳过该 skill；若被动作引用则按「id 不存在」报错 |

## 测试

- `internal/registry`：skills 两级分区扫描（正常/缺失/坏 frontmatter/跨级同名冲突）；validate 对 `llm.skills` 引用存在性、id 命名规则的正反用例；
- `internal/actionrun`：SkillRouter 路由计算（project 级随 agent-cwd、空则 exeDir 兜底；user 级落 UserHomeDir——homeDir 以注入方式测试，不依赖真实用户目录）；CLI 路由表（ducc/claude 单根、codex 双根、未知 CLI 回退+警告、CLI 名大小写归一）；账本 Record/Load 自洁/路径归一；`t.TempDir()` 造 src/dst，覆盖四种情况——全新同步 / 一致跳过 / 内容变更覆盖 / 目标多余文件清除；混合绑定（project+user、单/双根 CLI）分流用例；
- `internal/runner`：LLMRunner 收到非空 SkillSyncReport 时，Run 开头最先 emit `[skill-sync]` 行且不进 `Result.Stdout`。

## 文档同步（CLAUDE.md 硬性要求）

- `docs/action.md`：`command.llm` 章节新增 `skills` 可选字段说明（语义、命名规则、同步行为、目标路径）；
- `CLAUDE.md` 架构小节：LLM 域提一句 skill 同步机制与 `skills/` 目录约定。

## 本期明确不做

前端 Skill 视图、AI 生成 skill 动作、路径配置化（`CLAUDE_CONFIG_DIR` 适配、config.yaml 覆盖路由表——路由表是代码内数据）、孤儿 skill 自动清理（账本已可识别，清理入口下期定）、LLMRunner 的 CLI 协议适配（`LLM_CLI=codex` 时 skill 按 codex 双根同步，但 CLI 仍按 CC headless 协议调起，协议分派是另一课题）、prompt 层注入（context-saving 式 @mention）。
