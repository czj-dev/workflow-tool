// PROTOTYPE（一次性）：三套变体共用的 class 常量与原型专属 CSS。单独成 .ts 是为了不让组件文件导出非组件
// （react-refresh/only-export-components）。class 一律写全名——Tailwind 只扫描源码里的完整字面量。
// 分区染色（变体 A）依赖 .side-sec[data-amb] 定义的 --amb / --tintc / --ink（见 index.css 侧栏分组段）；
// 条目卡自带颜色（片段页每条自选）依赖下面的 .frag-card[data-amb]，在卡上重定义 --amb / --tintc。

/** 融入行的裸输入：去掉 Input 默认的卡片面 / 阴影 / hover 琥珀边，焦点才亮 1px ring。 */
export const BARE_INPUT =
  "h-7 rounded-sm border-0 bg-transparent px-1 font-mono text-xs text-foreground shadow-none outline-none hover:shadow-none focus-visible:border-transparent focus-visible:shadow-none focus-visible:ring-1 focus-visible:ring-ring/50";

/** 眉标：与 AppSidebar 的分组标签同一支排版。 */
export const EYEBROW =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

/** 变体 A 的条目卡：同色浅染 8%（侧栏条目是 12%，主区面积大、行数多，压淡一档），hover 15% + 1px 板块色内描边。 */
export const TINT_CARD =
  "bg-[color-mix(in_oklab,var(--tintc)_8%,transparent)] transition-[background-color,box-shadow] duration-150 hover:bg-[color-mix(in_oklab,var(--tintc)_15%,transparent)] hover:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--amb)_40%,transparent)]";

/** 自动分组（按前缀 / 按引用，仅 ?group= 可达）的分区板块色，按组序轮换：蓝 / 绿 / 紫，amber 留给 primary。 */
export const AMBS = ["blue", "green", "violet"] as const;

/** 五色色卡 = 手动分组可选的全部「卡片颜色」。amber / green / blue / violet 即 ADR-0003 卡片氛围色的四源；
 * 第五色补青——取 logcat 标记板 --mark-h-5（同侧栏蓝组借 --mark-h-6 的做法，不引入新色值）。
 * 红 / 玫瑰留给 destructive 语义，不进色卡。 */
export const GROUP_COLORS = ["amber", "green", "cyan", "blue", "violet"] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

/** 色卡盘面：每个色一个写全名的背景 class。 */
export const SWATCH_BG: Record<GroupColor, string> = {
  amber: "bg-[var(--amb-amber)]",
  green: "bg-[var(--amb-green)]",
  cyan: "bg-[var(--amb-cyan)]",
  blue: "bg-[var(--amb-blue)]",
  violet: "bg-[var(--amb-violet)]",
};

/** 分组头的附加动作（改色 / 删除）：静止时不画；悬停分组头、键盘聚焦到它、或它开的气泡还没关时才出现。
 * 用 opacity 而不是 visibility——看不见的按钮仍在 Tab 序里，键盘用户才够得着。
 * focus-within 那两条管「气泡关掉、焦点回到触发钮」：鼠标点的关法下 :focus-visible 不一定命中，动作会闪没。 */
export const HEAD_ACTION =
  "pointer-events-none opacity-0 transition-opacity group-hover/head:pointer-events-auto group-hover/head:opacity-100 group-focus-within/head:pointer-events-auto group-focus-within/head:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 aria-expanded:pointer-events-auto aria-expanded:opacity-100";

/** 条目卡自带颜色时的染色源：与 .side-sec[data-amb] 逐色相同——蓝同样不直接用 --amb-blue 而借 --mark-h-6，
 * 深色再提色度（见 index.css 侧栏分组段的说明）；其余四色就是各自的板块色。 */
const CARD_TINT: Record<GroupColor, { light: string; dark?: string }> = {
  amber: { light: "var(--amb-amber)" },
  green: { light: "var(--amb-green)" },
  cyan: { light: "var(--amb-cyan)" },
  blue: { light: "var(--mark-h-6)", dark: "oklch(0.7 0.17 255)" },
  violet: { light: "var(--amb-violet)" },
};

const CARD_RULES = GROUP_COLORS.map((k) => {
  const tint = CARD_TINT[k];
  return [
    `.frag-card[data-amb="${k}"] {`,
    `  --amb: var(--amb-${k});`,
    `  --tintc: ${tint.light};`,
    `}`,
    tint.dark ? `.dark .frag-card[data-amb="${k}"] {\n  --tintc: ${tint.dark};\n}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}).join("\n");

// 原型专属 CSS：青色 token、amber / cyan / none 三档分区色、条目卡自带颜色（.frag-card）是这一轮新增的。
// 正式 index.css 一行不改，由 installStub() 在原型会话开头注入一次；定稿落地时再决定这几条进不进 index.css。
// 浅色墨色沿用 index.css 的公式（amb l−0.10 / c×1.15）；深色墨色另写两条选择级更高的显式规则，
// 不依赖「本段晚于 index.css」这个注入顺序。
const PROTO_CSS = `
:root {
  --amb-cyan: var(--mark-h-5);
}
.side-sec[data-amb="amber"] {
  --amb: var(--amb-amber);
  --tintc: var(--amb-amber);
  --ink: oklch(0.52 0.184 68);
}
.side-sec[data-amb="cyan"] {
  --amb: var(--amb-cyan);
  --tintc: var(--amb-cyan);
  --ink: oklch(0.52 0.138 200);
}
/* 「未分组」是兜底桶而不是真正的组：中性灰，和已归类的彩色组拉开 */
.side-sec[data-amb="none"] {
  --amb: color-mix(in oklab, var(--foreground) 45%, transparent);
  --tintc: var(--foreground);
  --ink: var(--muted-foreground);
}
.dark .side-sec[data-amb="amber"],
.dark .side-sec[data-amb="cyan"] {
  --ink: color-mix(in oklab, var(--amb) 85%, var(--foreground));
}
.dark .side-sec[data-amb="none"] {
  --ink: var(--muted-foreground);
}
/* 条目卡自带颜色：在卡片上重定义 --amb / --tintc，盖过所在分区继承下来的值（声明值胜过继承值）。
   不定义 --ink——卡上的文字 / 图标不吃板块墨色，颜色只落在底色和 hover 内描边。 */
${CARD_RULES}
`;

export function ensureProtoStyles() {
  if (document.getElementById("config-pages-proto-css")) return;
  const el = document.createElement("style");
  el.id = "config-pages-proto-css";
  el.textContent = PROTO_CSS;
  document.head.append(el);
}
