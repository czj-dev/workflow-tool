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
| 4 | 源为准，比对覆盖 | 绑定名单内：逐「相对路径+内容」比对，不一致覆盖写，目标多余文件删除；一致跳过（幂等） |
| 5 | 同步放 actionrun.Build | cwd 终值已算好（空则 exeDir 兜底）；api 直跑与 workflow step 两条路径天然一致；runner 保持纯执行单元不被文件 IO 污染 |
| 6 | 失败即动作失败 | skill 是声明的依赖：源缺失（加载时校验拦截）、目标 IO 失败 → 动作直接报错，不静默降级 |
| 7 | 本期无 UI / 无生成 | 纯后端机制，skill 文件手写；前端视图与 AI 生成入口下期再议 |

## 目录布局与数据流

```
workflow-tool.exe
├── actions/claude-bug-analyze.yaml   # command.llm.skills: [bug-analyze]
├── skills/
│   └── bug-analyze/
│       ├── SKILL.md                  # frontmatter(name/description) + 正文
│       └── references/*.md           # 可选附属文件，整目录同步
└── workflows/…
```

```
RunAction / workflow step
  → actionrun.Build（解析 llm.skills，cwd 已是展开终值）
  → SyncSkills(源=exeDir/skills, 目标=<cwd>/.claude/skills, ids)
     ├─ 比对/覆盖（Build 的副作用）
     └─ 返回 report（synced/skipped 列表）注入 LLMConfig
  → 构造 LLMRunner
  → Run 开头最先 emit report 行 → ducc 自行发现 .claude/skills/ 加载
```

**cwd 兜底语义**：同步目标不依赖子进程继承语义——`LoadedAction.Cwd` 展开后为空时，同步目标**显式用 `exeDir()` 兜底**（与 registry 扫描同源、对齐 exe 同级约定），而非子进程的「继承父进程 cwd」。正常启动方式下两者一致，但显式兜底让 skill 落点可预期。

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
- 每个 id 必须存在 `skills/<id>/SKILL.md`，缺失即该动作加载失败；
- registry 新增 skills 目录扫描：目录名即 id，frontmatter 宽松解析（name/description 可缺，坏 frontmatter 跳过该条不计入可用集——与 Claudian「malformed skip」哲学一致）。

`skills` 字段位于 `command.llm` 内部，天然不与 run/script/adb 形态混用；四选一互斥校验不受影响。

## 同步算法（`actionrun.SyncSkills`）

```
SyncSkills(srcRoot, dstRoot string, ids []string) (report SyncReport, err error)
// dstRoot 由调用方（Build）拼好传入 = <cwd>/.claude/skills；
// ".claude/skills" 子路径定义为常量，便于将来扩展 Codex 目标目录。
// report 含 synced / skipped 两个列表。
```

**输出行协议**：Build 层没有 emit 回调，report 不在 Build 时直接推送——注入 `LLMConfig.SkillSyncReport`，由 `LLMRunner.Run` 开头（CLI 子进程启动前）最先逐行 emit 为普通 `stdout` 流。好处：输出协议仍集中在 runner 一处，api 直跑与 workflow 两条路径自动一致，且报告行天然成为 LLM 会话的第一条可见输出。

1. **比对**：walk `srcRoot/<id>/`，按「相对路径 + 文件内容」与 `dstRoot/<id>/` 对应文件比对；
2. **一致** → 跳过（重试/重复运行幂等）；
3. **不一致或缺失** → 逐文件覆盖写（MkdirAll 递归建目录）；目标里源没有的多余文件删除；
4. **名单外** → 永不触碰。用户手写的非绑定 skill 不会被删；但**绑定名单内的同名 skill 会被源覆盖**——绑定即声明所有权。

**不做目录级先删后拷**：中途失败最多留旧文件，不留空目录（Windows 下目录级原子 rename 不可靠，不做）。符号链接/二进制文件按普通文件字节读写作比对，不特殊处理。

报告行格式（Runner 自发，不经 CLI 输出解析，因此**不进 `Result.Stdout`**——保持其纯 assistant text 语义供 workflow `if` 引用）：

```
[skill-sync] bug-analyze → D:\proj\.claude\skills\bug-analyze
[skill-sync] card-convert 已是最新，跳过
```

**并发**：同一动作并发运行已被现有机制拒绝；不同动作同步同一目标目录属跨动作并发写文件，文件级覆盖写在最坏情况下后写者胜，可接受，不加锁。

## 错误处理

| 场景 | 行为 |
|------|------|
| `llm.skills` 引用的 id 在 skills/ 目录不存在 | registry 加载时校验失败，动作不可运行 |
| skills/<id>/SKILL.md 运行时被外部删除（加载时存在） | Build 时 SyncSkills 报错，动作失败 |
| 目标目录写失败（权限/占用） | SyncSkills 报错，动作失败，stderr 带路径 |
| 坏 frontmatter | 加载时跳过该 skill；若被动作引用则按「id 不存在」报错 |

## 测试

- `internal/registry`：skills 目录扫描（正常/缺失/坏 frontmatter）；validate 对 `llm.skills` 引用存在性、id 命名规则的正反用例；
- `internal/actionrun`：`t.TempDir()` 造 src/dst，覆盖四种情况——全新同步 / 一致跳过 / 内容变更覆盖 / 目标多余文件清除；
- `internal/runner`：LLMRunner 收到非空 SkillSyncReport 时，Run 开头最先 emit `[skill-sync]` 行且不进 `Result.Stdout`。

## 文档同步（CLAUDE.md 硬性要求）

- `docs/action.md`：`command.llm` 章节新增 `skills` 可选字段说明（语义、命名规则、同步行为、目标路径）；
- `CLAUDE.md` 架构小节：LLM 域提一句 skill 同步机制与 `skills/` 目录约定。

## 本期明确不做

前端 Skill 视图、AI 生成 skill 动作、Codex 目标目录（`.codex/skills`，目标子路径留常量便于扩展）、用户级 `~/.claude/skills` 同步、prompt 层注入（context-saving 式 @mention）。
