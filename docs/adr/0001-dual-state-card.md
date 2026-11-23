# 三类网格卡统一为双态卡

Workflow、Action、LLM Action 三类网格卡原本各自为形（Action 曾是 72px 信息横条，steps/params 读数平铺卡面）。现统一为同一双态卡骨架（紧凑⇄展开）：以同构换取全应用唯一的卡片交互语言，身份信息留在紧凑态，意图表达留给展开态。steps/params 读数移出卡面、单一主控沉于展开态功能行右下，均是渐进披露原则的直接推论。

## Considered Options

- 每类卡按内容各自优化：信息密度更高，Action 横条改动小，但三套交互语言并存。
- 统一双态骨架：交互语言唯一、实现同构，代价是 Action 牺牲横条密度。

## Consequences

- 三卡同构约束此后所有卡面改动，回退等于三处重写。
- 展开态功能行组成：预设 chips（Action/LLM）+ 编辑表单（有参数时）+ 编辑配置（直达 YAML 编辑页：action → edit、workflow → workflow-edit，经 Provider 的 openYamlEditor 统一导航）+ 单一主控。
- 三类页分组次序统一（usage.compareGroupKeys）：业务组按 id 前缀字母序 → 演示组（demo 前缀，显示名「演示」）压轴 → 无前缀杂项恒最后。
- 运行态沿用流光与脉冲读数，不接实时 step（与运行时耦合度高，后置）。
- 叙述区接入运行输出流（替代静态文案）是明确的演进位，本期不做。

视觉与 token 规范以 `.design/workflow-card-mockup.html` 为唯一真相源，本文不复述数值。
