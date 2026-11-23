# 卡片氛围色按分组序循环取色，运行仅边框与流光显 primary

双态卡的视觉签名不是品牌色染色，而是环境取色：氛围色现阶段不逐卡从图标实测取色，而是**按分组显示序在四色板（amber/green/blue/violet，取自既有 chart 色，无新色）中循环**——组内同色（网格按组可辨）、相邻组必然异色（ADB 与 DEMO 不再撞色）、颜色随组序迁移（不做 key 级稳定绑定）。按紧凑 → hover → 展开形成由弱到强的染色梯度。运行不夺氛围：`--amb` 恒为组色（原型中 inline 组色恒胜过运行覆写的层叠语义），运行只在小卡边框（`[data-running]` → primary）与顶沿流光（金色）两处显现，主控读数态同为 primary；展开运行中边框仍是组色 40%，光晕/图标底保持组色。hub 与盖盘取卡面氛围色（盖盘经 `--amb` 动态取色），恒同色无需特判。

## Considered Options

- 统一品牌色染色：一致但单调，网格失去按组可辨性。
- 语义色（按状态染色）：状态与身份互相污染。
- 按 groupKey hash 稳定取色：颜色不随组序漂移，但 hash 可碰撞（ADB 与 DEMO 曾同色），碰撞不可控。

## Consequences

- 分组序循环在 `GridCardParts.ambFor(groupIndex)` 单点实现；视图层以分组位次传 prop，卡内恒注入组色，运行边框规则由 index.css 的 `.dual-card[data-running]` 承担（`--amb` 不覆写）。
- 备忘②已落地：action/workflow YAML 可选 `color` 字段逐卡声明氛围色（白名单即四色板，Go 侧 `registry.ValidAmbColors` 校验、前端 `GridCardParts.ambColorFor` 映射，非法名加载报错）；写了逐卡优先，未写回落 ambFor 组序循环，梯度与回落规则不变。
- 氛围色梯度、回落规则及全部数值以 `.design/workflow-card-mockup.html` token 表为唯一真相源。
- **插值空间一律 `in oklab`（禁 `in oklch` 做 color-mix）**：`transparent` 是透明黑，OKLCH 极坐标插值时 hue 不参与 alpha 预乘、被拉向 0°（红），致图标（纯 `var(--amb)`）与卡面光晕/底色（低透明度混合）系统性红移——amber 70°→~7°、blue 250°→~349°（粉）、violet 310°→~355°（粉）；Safari<18（含 WKWebView）与 Chromium 低饱和中性色（crbug 565837690）更甚，Tailwind v4.1 同因全线改 oklab（PR #15201）。oklab 为笛卡尔坐标，透明混合 = 纯降 alpha，hue 精确保留；与 transparent/中性色（card/border/foreground 等）混合时 oklch 的最短弧插值还会绕道其他色相（amber→card 245° 穿过绿色）。2026-11 已全仓（index.css、各 TSX 任意值类、原型 HTML）统一替换。
