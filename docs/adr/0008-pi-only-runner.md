# pi 是唯一 AI 运行器：一步替换外部 Agent CLI

AI 任务的执行器此前是外部安装的 Agent CLI（ducc，或 Claude Code headless 的 stream-json 形态）：仓外安装、版本不可控、协议为一家私有，权限与 skill 机制都按 CLI 各自的约定凑合。本决定改为以 [pi](https://github.com/earendil-works/pi)（v1.6.1）为**唯一** AI 运行器，一步替换、不留双协议与运行时回退。验证先行：阶段 0 先在仓库外用真实端点做一次性 spike，把关键风险逐个验证后才动仓内代码。2026-11-27 五项验收全部通过：

1. **真实端点往返**：pi v1.6.1 对 OpenAI 兼容网关（GLM-5.3-Flash）完整走通 `--mode json` 事件流，事件形状与官方文档一致。
2. **密钥不落盘**：models.json 的 `apiKey` 写 `${AI_AUTH_KEY}` 环境插值字面量，请求时从 pi 子进程 env 解析；负向对照（撤掉密钥）下 pi 启动即失败。
3. **失败语义**：错误模型 id 下 pi 仍 exit 0，失败信息在流内（`stopReason=error` + 网关文案）——成败判定必须看事件流，不能看退出码。
4. **hermetic 成立**：`PI_CODING_AGENT_DIR` + `--session-dir` 注入应用目录后运行，用户自己的 `~/.pi` 零改动、无信任提示。
5. **可分发**：发行二进制为 bun 编译单文件，无 node 运行时依赖，可随应用包分发（`resolvePiBin` 预留 `<BaseDir>/pi/pi` 探测位）。

## Considered Options

- **双协议并行过渡**：新任务用 pi、旧任务留在 ducc/CC。风险最低，但两套事件解析、两套配置、两套 skill 同步要同时长期维护——恰是本次要消灭的技术债。
- **运行时回退**（pi 不可用时回落旧 CLI）：表面平滑；但失败面变成「同一任务在不同机器上跑不同引擎」，行为不可复现、问题不可归因。
- **一步替换 + spike 先行验证**（选定）：把协议解析、密钥注入、失败语义、hermetic、分发五个风险在仓外一次性验证掉，然后整体切换；任一验收不过就整体放弃，仓内零残留。

## Consequences

- **argv 与 hermetic 布局固定**：`pi --mode json --offline --no-approve --session-dir <应用目录>/pi-sessions --no-skills [--skill <src> ...] --model workflow-tool/<AI_MODEL>`；agent 目录经 `PI_CODING_AGENT_DIR` 指到应用目录 `pi-agent/`，其中 `models.json` 由构造层原子写（provider 固定 `workflow-tool`、模型即 `AI_MODEL`）。`config.yaml` 相应改为 `AI_BASE_URL` / `AI_AUTH_KEY` / `AI_MODEL` 三键，可选 `AI_PI_BIN` 覆盖可执行路径；残留 `AI_CLI` 只警告不生效。（修订 2026-11-27：三键改存用户级 `~/.workflow-tool/auth.json`——设置页「Agent」分类编辑，0600 原子写、不随包分发；运行时非空值覆盖 `config.yaml` 同名键、残留仅作回退并附迁移警告；`AI_PI_BIN` 留在 `config.yaml`。）
- **失败判定以事件流为准**：exit 0 但流内 `stopReason` 为 error/aborted → 判失败（ExitCode -1，文案推 stderr）；进程自身错误（启动失败/超时/取消）优先于流内判定；pi 内部最多 3 次重试不影响判定。
- **skills 改零拷贝**：`--skill` 直传源目录，按 CLI 路由的复制同步机器删除，`skills.synced.json` 停写（历史文件可手动删除）。
- **对外契约不变**：emit 的 `ai` / `ai-thinking` / `ai-tool` 流与 outputs 键（`text` / `thinking` / `session_id` / `cost_usd` / token 读数）维持原形，前端零改动。
- **审批语义**：pi 没有审批机制，`--no-approve` 让它忽略信任门控的项目本地配置与资源——[ADR-0007](0007-unattended-ai-runs.md)「无人值守无审批」的前提不变。
- **协议演进风险**：pi 事件流若变，由 `internal/runner` 的解析测试（含真实流样本 `testdata/pi_stream.jsonl`）作为回归门挡住；升级 pi 前先跑该包测试。
