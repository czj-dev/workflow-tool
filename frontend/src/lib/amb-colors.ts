// 配置页 / 片段页共享的氛围色词汇（规格 G：色卡五色 = amber / green / cyan / blue / violet）。
// 红、玫红留给 destructive 语义，不进色卡。本文件只放常量、类型与纯函数（非组件），
// 单独成 .ts 是为了不让组件文件导出非组件（react-refresh/only-export-components）。
// 放 lib/ 而非 components/：hooks（useVariableGroups）也消费这份词汇，
// hooks 反向依赖 components/ 是分层倒置。
//
// 与 Go 侧 registry.ValidAmbColors（五色白名单）保持同步；网格组序循环
// （GridCardParts.AMB_CYCLE）刻意保持原四色不动——cyan 只经逐卡显式 color
// 或色卡选用，不参与自动分配（进循环会改变现有网格的组色）。

/** 色卡五色（ADR-0003 五色板）；顺序即色卡顺序与方向键步进顺序。 */
export const AMB_COLORS = ["amber", "green", "cyan", "blue", "violet"] as const;
export type AmbColor = (typeof AMB_COLORS)[number];

/** 色值：null = 未设置（如片段未选色时跟随分区色）。 */
export type AmbColorValue = AmbColor | null;

/** 片段分区的固定色（规格 F）：分区一律琥珀，颜色下放给条目——每条片段自己选；
 *  未选色的片段跟随它（列表渲染与弹窗预览的兜底）。 */
export const GROUP_AMB: AmbColor = "amber";

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

/** 值是否在色卡五色内（与 Go 白名单同口径；后端读时已规整，这里兜住手改文件的残留）。 */
export function isAmbColor(value: string | undefined | null): value is AmbColor {
  return (AMB_COLORS as readonly string[]).includes(value ?? "");
}

/** 存档颜色 → 色卡五色：未设置 / 越界回落到调用方给的兜底色。两页口径不同——
 *  变量分组按蓝（规格 E）、片段按分区固定琥珀（规格 F）——回落由各调用点自带。 */
export function normalizeAmbColor(
  color: string | undefined,
  fallback: AmbColor,
): AmbColor {
  return isAmbColor(color) ? color : fallback;
}

/** 存档颜色 → 色卡色：未设置 / 越界保持未设置（undefined）。与 normalizeAmbColor
 *  的固定回落相对，这是「保留未设置语义」的口径——编辑既有片段时用（未设置 =
 *  跟随分区色，保存时载荷不写 color 键）。 */
export function asAmbColor(color: string | undefined): AmbColor | undefined {
  return isAmbColor(color) ? color : undefined;
}
