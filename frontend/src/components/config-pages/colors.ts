// 配置页 / 片段页共享的氛围色词汇（规格 G：色卡五色 = amber / green / cyan / blue / violet）。
// 红、玫红留给 destructive 语义，不进色卡。本文件只放常量与类型（非组件），
// 单独成 .ts 是为了不让组件文件导出非组件（react-refresh/only-export-components）。
//
// 与 Go 侧 registry.ValidAmbColors（五色白名单）保持同步；网格组序循环
// （GridCardParts.AMB_CYCLE）刻意保持原四色不动——cyan 只经逐卡显式 color
// 或色卡选用，不参与自动分配（进循环会改变现有网格的组色）。

/** 色卡五色（ADR-0003 五色板）；顺序即色卡顺序与方向键步进顺序。 */
export const AMB_COLORS = ["amber", "green", "cyan", "blue", "violet"] as const;
export type AmbColor = (typeof AMB_COLORS)[number];

/** 色值：null = 未设置（如片段未选色时跟随分区色）。 */
export type AmbColorValue = AmbColor | null;

/** 色卡盘面：每个色一个写全名的背景 class（Tailwind 只扫描源码里的完整字面量）。 */
export const SWATCH_BG: Record<AmbColor, string> = {
  amber: "bg-[var(--amb-amber)]",
  green: "bg-[var(--amb-green)]",
  cyan: "bg-[var(--amb-cyan)]",
  blue: "bg-[var(--amb-blue)]",
  violet: "bg-[var(--amb-violet)]",
};

/** 分区头的附加动作（改色气泡 / 删除分组）：静止时透明但仍在 Tab 序里，
 * 悬停分区头、键盘聚焦到它、或它开的气泡还没关时出现。
 * 用 opacity 而不是 visibility / display——看不见的按钮仍在 Tab 序里，键盘用户才够得着。
 * focus-within 两条管「气泡关掉、焦点回到触发钮」的窗口：鼠标点的关法下
 * :focus-visible 不一定命中，动作会闪没。 */
export const HEAD_ACTION =
  "pointer-events-none opacity-0 transition-opacity group-hover/head:pointer-events-auto group-hover/head:opacity-100 group-focus-within/head:pointer-events-auto group-focus-within/head:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 aria-expanded:pointer-events-auto aria-expanded:opacity-100";
