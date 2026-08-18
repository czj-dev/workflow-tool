# 设计：xdzs-verify-fix — 协议验证修复 action

日期：2026-08-18

## 背景与动机

对 ~/.claude/projects 下 xdzs-speech 的 119 个会话做高频操作分析，用户手动高频请求之一是「验证修复 test_case.json」（约 15 次/月，另含 32 次手动触发 `/protocol-verify-tool` 技能）。该请求语义完全一致：对协议转换用例跑完整验证，失败则修复映射规则后复验。

现状排查：

- protocol-verify-tool 技能的脚本族（diff_result / quick_verify / query_mapping / edit_mapping / da-nlu / iops_fetch）**已被 skill 完整承接**，不再重复封装。
- Gradle 单测/编译（~500 次/月）是 **agent 自调**操作，非用户手动高频，不做 action。
- `claude-bug-analyze`（LLM headless 形态）已为 iCafe bug 分析提供先例：workflow-tool 一键触发后台 ducc headless 跑技能流水线。本 action 沿用同一形态。

**因此唯一值得固化的手动高频操作是「验证修复 test_case」**，产出为 LLM 形态 action `xdzs-verify-fix`。

## 输入模型（用户已确认）

- **只允许 test_case 输入**：单一形态，无 ASR 双路 NLU 分支，无 reverse_lookup 分支。
- **test_case 预期明确，必须修复**：不设「只读报告」模式，验证不一致必须修到通过。
- **Params 输入文本，直接覆盖 assets/test_case.json**：用户在表单粘贴 case 内容，action 将其规整后写入 `.claude/skills/protocol-verify-tool/assets/test_case.json`，验证闭环结束后恢复原文件。

## Action 定义

文件：`workflow-tool/actions/xdzs-verify-fix.yaml`

```yaml
id: xdzs-verify-fix
title: 验证修复协议测试用例
icon: hi:test  # 或选用既有图标
description: 覆盖 test_case.json → diff_result 验证 → 修复映射 → 复验归零 → 报告
params:
  - id: CASE_INPUT
    label: test_case 内容
    type: textarea
    required: true
    description: 单条或多条 NLU 信封 JSON（也可粘贴 asr/domain/intent/slots 文本，由 agent 规整为信封）
  - id: CONTEXT
    label: 补充上下文（可选）
    type: textarea
command:
  llm:
    system: ROLE
    prompt: TASK
  timeout: 30m
```

说明：`command.llm` 形态与 `claude-bug-analyze` 一致，`ROLE`/`TASK` 为 Prompt 片段占位（实际以最终 yaml 内嵌文本为准，硬约束见下）。

### ROLE（system prompt）硬约束

1. 加载 `protocol-verify-tool` skill 按 SKILL.md 执行；本任务输入只能是 cases 文件，**不走 ASR 双路 / reverse_lookup 分支**
2. 入口唯一：`diff_result.py --cases-file <test_case.json>`，禁止拆分为 quick_verify + 手工拼 actual 的分步
3. headless：无法 ASK；test_case 预期明确，分析后直接修复，无需等用户确认（区别于 skill 通用交互流程）
4. 修复纪律（skill 硬规则全保留）：只经 `edit_mapping.py`；字段值以车机实绩为准，禁止猜测；TextList 与车机完全对齐；`$@Key$` 占位符补 Param；不可修复类（NLU 语义歧义）不硬修，如实列入报告
5. 复验至差异归零（豁免项除外），通过后清理 `*.bak.*`，并恢复 test_case.json 原文件
6. 车机取数失败/离线 → 报告「无法对账」并退出，不得伪造通过

### 参数约束

- `CASE_INPUT` 必填。允许输入：
  - 完整 NLU 信封 JSON 数组（直接落盘）；
  - 单条信封 JSON 对象（自动包为数组）；
  - asr/domain/intent/slots 文本（由 agent 规整为信封，缺少 header 字段时自动补默认 header）。
- `CONTEXT` 可选，拼入 TASK 尾部，帮助 agent 定位差异根因。

## LLM 内部执行链（TASK 提示内容）

1. 备份：`cp .claude/skills/protocol-verify-tool/assets/test_case.json test_case.json.bak`
2. 规整 `CASE_INPUT` 为 case 数组，覆盖写入 `assets/test_case.json`
3. 加载 protocol-verify-tool skill，按决策链执行：
   - 入口唯一：`diff_result.py --cases-file assets/test_case.json`（本地转换 + 车机实绩 + 字段级比对）
   - 禁止拆分为 quick_verify + 手工拼 actual 的分步
4. 分析 diff：
   - 按 skill 速查表分类（Command.Name 不同 / Param 缺多 / TextList 对齐 / 占位符未替换…）
   - 豁免项不计差异：`TextList.Succeed.Text` 随机文案、NLU 语义歧义（Command.Name 不同 + slots 相同）
5. 修复（可修项）：
   - 只经 `edit_mapping.py`（自动 bak + 结构校验），禁止手编 mapping JSON
   - 字段值以车机实绩为准，禁止猜测；Param Key/TextList 与车机完全对齐；优先 custom 后再 base
   - 需要重生成 base 时切换 protocol-config-generator 技能（skill 硬约束）
6. 复验：重跑 `diff_result.py --cases-file` 直至差异归零（豁免项除外）
7. 清理：确认通过后删除 mapping 的 `*.bak.*`；**恢复 test_case.json 原文件**（从步骤 1 备份）
8. 输出报告（见下）

## 报告格式

```
## 验证修复报告
- 用例数 / 通过数 / 修复数 / 豁免数
- 修复明细：domain.intent + 差异字段 + edit_mapping 改动摘要
- 豁免项：分类 + 原因（不可修 / 随机文案）
- 残留差异（如有）：待人工裁决
```

## 纪律与异常处理

- 车机在线取实绩失败 / 网络不可用 → 报告「无法对账」并退出，**不得伪造通过**
- edit_mapping 的 .bak 与 git 双保险作为回滚兜底；test_case.json 经备份恢复
- 不覆盖既有 claude-bug-analyze / protocol-verify-tool skill 能力边界：ASR 双路校验、reverse_lookup 等仍在 Claude Code 会话中交互使用

## 风险

| 风险 | 缓解 |
|---|---|
| 车机不在线无法取实绩 | 失败即报错，不降级 |
| LLM 生成的规则与实体不一致 | headless 降低：规则全走 edit_mapping + 实绩对齐纪律，报告列明细 |
| case 输入规整出错（覆盖坏 test_case.json） | 步骤 1 备份；命令失败仍恢复 |