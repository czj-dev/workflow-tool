# 卡片氛围色按分组序循环取色，运行中回落 primary

双态卡的视觉签名不是品牌色染色，而是环境取色：氛围色现阶段不逐卡从图标实测取色，而是**按分组显示序在四色板（amber/green/blue/violet，取自既有 chart 色，无新色）中循环**——组内同色（网格按组可辨）、相邻组必然异色（ADB 与 DEMO 不再撞色）、颜色随组序迁移（不做 key 级稳定绑定）。按紧凑 → hover → 展开形成由弱到强的染色梯度。运行中氛围色整体让位，覆写为 primary 琥珀——运行是全局唯一需要被一眼识别的状态。hub 开环形变与盖盘同样取卡面氛围色（盖盘经 `--amb` 动态取色），运行卡经由同一条覆写规则自动回落，无需特判。

## Considered Options

- 统一品牌色染色：一致但单调，网格失去按组可辨性。
- 语义色（按状态染色）：状态与身份互相污染。
- 按 groupKey hash 稳定取色：颜色不随组序漂移，但 hash 可碰撞（ADB 与 DEMO 曾同色），碰撞不可控。

## Consequences

- 分组序循环在 `GridCardParts.ambFor(groupIndex)` 单点实现；视图层以分组位次传 prop，卡内运行时覆写为 primary。
- 逐卡图标取色（workflow.yaml 的 color 字段）仍是演进位；落地时替换 ambFor 的取色来源即可，梯度与回落规则不变。
- 氛围色梯度、回落规则及全部数值以 `.design/workflow-card-mockup.html` token 表为唯一真相源。
