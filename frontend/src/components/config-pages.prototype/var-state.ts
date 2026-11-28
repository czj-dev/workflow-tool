// PROTOTYPE（一次性）：全局配置页三套变体共用的「草稿 + 分组」模型。
// 草稿放在模块级 store 而非组件 state：切变体比较的是版式，不应丢掉未保存的编辑，
// 三套变体读到的是同一份 rows / dirty，比较才公平。
import { useMemo, useSyncExternalStore, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import type { HugeiconsIcon } from "@hugeicons/react";
import {
  Folder01Icon,
  InboxUnreadIcon,
  Link01Icon,
  MoreHorizontalIcon,
  TagsIcon,
  Unlink01Icon,
} from "@hugeicons/core-free-icons";
import { extractVars } from "@/lib/vars";
import { useActionRunner } from "../../hooks/useActionRunner";
import { useCopy, type Copy } from "./copy";
import { AMBS, GROUP_COLORS, type GroupColor } from "./styles";
import { useProtoState, type GroupMode } from "./url-state";

export interface VarRow {
  key: string;
  value: string;
}

export type GroupKind = "prefix" | "used" | "unused" | "manual" | "other" | "ungrouped";

export interface VarGroup {
  id: string;
  kind: GroupKind;
  name: string;
  /** 手动分组的卡片颜色（见 styles.GROUP_COLORS）；其它分组方式不设 */
  color?: GroupColor;
  /** 分组规则的一句话说明（分组头副行 / 眉标右侧），让「为什么它在这一组」可读 */
  hint: string;
  /** index = rows 里的下标，编辑 / 删除按它回写 */
  rows: { row: VarRow; index: number }[];
}

type RefCounts = Record<string, number | undefined>;

// ─── 草稿 store ────────────────────────────────────────────────────────────
interface Draft {
  rows: VarRow[];
  dirty: boolean;
  /** 刚用「新增 / 补定义」加进来的那一行（下标）；草稿再有别的改动就清空。变体据此给它的键输入框 autoFocus。 */
  fresh: number | null;
  /** 草稿基于的那份 globalConfig（引用相等即同步） */
  source: Record<string, string>;
}

let draft: Draft | null = null;
const draftSubs = new Set<() => void>();
const notifyDraft = () => draftSubs.forEach((f) => f());
const rowsOf = (config: Record<string, string>): VarRow[] =>
  Object.entries(config).map(([key, value]) => ({ key, value }));

function draftSnapshot(config: Record<string, string>): Draft {
  // 正式页同款语义：后端数据到位 / 变化时同步 rows，但未保存的编辑不被覆盖
  if (!draft || (!draft.dirty && draft.source !== config)) {
    draft = { rows: rowsOf(config), dirty: false, fresh: null, source: config };
  }
  return draft;
}

const subscribeDraft = (cb: () => void) => {
  draftSubs.add(cb);
  return () => {
    draftSubs.delete(cb);
  };
};

export function toKV(rows: VarRow[]): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const r of rows) if (r.key.trim()) kv[r.key.trim()] = r.value;
  return kv;
}

export function dupKeysOf(rows: VarRow[]): Set<string> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = r.key.trim();
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, c]) => c > 1).map(([k]) => k));
}

export function useVarDraft() {
  const { globalConfig, varRefCounts, saveGlobalConfig } = useActionRunner();
  const snap = useSyncExternalStore(
    subscribeDraft,
    () => draftSnapshot(globalConfig),
    () => draftSnapshot(globalConfig),
  );
  const dupKeys = useMemo(() => dupKeysOf(snap.rows), [snap.rows]);

  return {
    rows: snap.rows,
    dirty: snap.dirty,
    dupKeys,
    varRefCounts,
    fresh: snap.fresh,
    update: (index: number, field: "key" | "value", v: string) => {
      draft = {
        ...draft!,
        dirty: true,
        fresh: null,
        rows: snap.rows.map((r, i) => (i === index ? { ...r, [field]: v } : r)),
      };
      notifyDraft();
    },
    remove: (index: number) => {
      draft = { ...draft!, dirty: true, fresh: null, rows: snap.rows.filter((_, i) => i !== index) };
      notifyDraft();
    },
    /** 追加一行（key 可预填，用于「补定义」），返回它的下标；它同时成为 fresh 行 */
    add: (key = ""): number => {
      const rows = [...snap.rows, { key, value: "" }];
      draft = { ...draft!, dirty: true, fresh: rows.length - 1, rows };
      notifyDraft();
      return rows.length - 1;
    },
    save: async () => {
      const kv = toKV(snap.rows);
      await saveGlobalConfig(kv);
      draft = { rows: rowsOf(kv), dirty: false, fresh: null, source: kv };
      notifyDraft();
    },
  };
}

// ─── 手动分组（仅内存）─────────────────────────────────────────────────────
// 正式落地需要在 config.yaml 增加 schema 支持（变量 → 分组的归属无法从键名推断）。
export interface ManualGroups {
  order: string[];
  assign: Record<string, string>;
  /** 组名 → 卡片颜色（五色色卡之一）。没记录的组按 blue（见 colorOf）。 */
  color: Record<string, GroupColor | undefined>;
}

let manual: ManualGroups = {
  // 预置几组，打开「手动」就能看到成品样子，不必先手动归 8 个变量
  order: ["路径", "XDZS 项目", "账号"],
  assign: {
    DOCS: "路径",
    LOGS_DIR: "路径",
    OUTPUT_DIR: "路径",
    XDZS_RESROUCE_DIR: "XDZS 项目",
    XDZS_SPEECH_DIR: "XDZS 项目",
    VOICE_DEBUG_OUTPUT: "XDZS 项目",
    VOICE_RELEASE_OUTPUT: "XDZS 项目",
    USER: "账号",
  },
  color: { "路径": "blue", "XDZS 项目": "green", "账号": "violet" },
};
const manualSubs = new Set<() => void>();
const notifyManual = () => manualSubs.forEach((f) => f());
const subscribeManual = (cb: () => void) => {
  manualSubs.add(cb);
  return () => {
    manualSubs.delete(cb);
  };
};

export function setManualGroups(next: (cur: ManualGroups) => ManualGroups) {
  manual = next(manual);
  notifyManual();
}

export function useManualGroups(): ManualGroups {
  return useSyncExternalStore(subscribeManual, () => manual, () => manual);
}

export function colorOf(m: ManualGroups, name: string): GroupColor {
  return m.color[name] ?? "blue";
}

/** 给新组挑色：五色里第一个还没被占用的；都占用了就取「最久没用过的那色」，让新组和邻近组尽量不撞色。 */
function pickColor(m: ManualGroups): GroupColor {
  const lastUsedAt = (color: GroupColor) => {
    let at = -1;
    m.order.forEach((g, i) => {
      if (colorOf(m, g) === color) at = i;
    });
    return at;
  };
  let best: GroupColor = GROUP_COLORS[0];
  for (const color of GROUP_COLORS) {
    if (lastUsedAt(color) < lastUsedAt(best)) best = color;
  }
  return best;
}

/** 新建分组对话框的初始色：接着已有分组往下排。 */
export function nextGroupColor(): GroupColor {
  return pickColor(manual);
}

/** 新建分组。color 省略时自动挑（见 pickColor）；重名直接忽略。 */
export function createManualGroup(name: string, color?: GroupColor) {
  const n = name.trim();
  if (!n) return;
  setManualGroups((m) =>
    m.order.includes(n)
      ? m
      : { ...m, order: [...m.order, n], color: { ...m.color, [n]: color ?? pickColor(m) } },
  );
}

/** 改某个手动分组的卡片颜色。 */
export function setManualGroupColor(name: string, color: GroupColor) {
  setManualGroups((m) =>
    m.color[name] === color ? m : { ...m, color: { ...m.color, [name]: color } },
  );
}

/** group = null 表示移回「未分组」。 */
export function assignManual(key: string, group: string | null) {
  const k = key.trim();
  if (!k) return;
  setManualGroups((m) => {
    const assign = { ...m.assign };
    if (group) assign[k] = group;
    else delete assign[k];
    return { ...m, assign };
  });
}

export function removeManualGroup(name: string) {
  setManualGroups((m) => ({
    order: m.order.filter((g) => g !== name),
    assign: Object.fromEntries(Object.entries(m.assign).filter(([, g]) => g !== name)),
    color: Object.fromEntries(Object.entries(m.color).filter(([g]) => g !== name)),
  }));
}

// ─── 分组 ──────────────────────────────────────────────────────────────────
const prefixOf = (key: string): string => {
  const k = key.trim();
  const i = k.indexOf("_");
  return i > 0 ? k.slice(0, i) : "";
};
const byKey = (a: { row: VarRow }, b: { row: VarRow }) => a.row.key.localeCompare(b.row.key);
const refOf = (refCounts: RefCounts, row: VarRow) => refCounts[row.key.trim()] ?? 0;

export function groupVars(
  rows: VarRow[],
  mode: GroupMode,
  refCounts: RefCounts,
  mg: ManualGroups,
  c: Copy,
): VarGroup[] {
  const items = rows.map((row, index) => ({ row, index }));

  if (mode === "usage") {
    const used = items
      .filter(({ row }) => refOf(refCounts, row) > 0)
      .sort((a, b) => refOf(refCounts, b.row) - refOf(refCounts, a.row) || byKey(a, b));
    const rest = items.filter(({ row }) => refOf(refCounts, row) <= 0).sort(byKey);
    return [
      { id: "used", kind: "used", name: c.used, hint: c.usedHint, rows: used },
      { id: "unused", kind: "unused", name: c.unused, hint: c.unusedHint, rows: rest },
    ];
  }

  if (mode === "manual") {
    const taken = new Set<number>();
    const named = mg.order.map((name) => {
      const members = items.filter(
        ({ row }) => row.key.trim() !== "" && mg.assign[row.key.trim()] === name,
      );
      members.forEach((m) => taken.add(m.index));
      return {
        id: `m:${name}`,
        kind: "manual" as const,
        name,
        color: colorOf(mg, name),
        hint: c.gmManualHint,
        rows: members,
      };
    });
    const rest = items.filter(({ index }) => !taken.has(index));
    return [
      ...named,
      { id: "ungrouped", kind: "ungrouped", name: c.ungrouped, hint: c.ungroupedHint, rows: rest },
    ];
  }

  // 按前缀：同前缀 ≥2 个才独立成组，其余并入「其它」
  const counts = new Map<string, number>();
  for (const { row } of items) {
    const p = prefixOf(row.key);
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const named = [...counts.keys()]
    .filter((p) => (counts.get(p) ?? 0) >= 2)
    .sort()
    .map((name) => ({
      id: `p:${name}`,
      kind: "prefix" as const,
      name,
      hint: c.gmPrefixHint,
      rows: items.filter(({ row }) => prefixOf(row.key) === name).sort(byKey),
    }));
  const inNamed = new Set(named.flatMap((g) => g.rows.map((r) => r.index)));
  return [
    ...named,
    {
      id: "other",
      kind: "other",
      name: c.other,
      hint: c.otherHint,
      rows: items.filter(({ index }) => !inNamed.has(index)).sort(byKey),
    },
  ];
}

/** 反向依赖：哪些变量的值引用了 key（含未保存的草稿行）。 */
export function usedByVars(key: string, rows: VarRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const k = r.key.trim();
    if (k && k !== key && extractVars(r.value).includes(key)) out.push(k);
  }
  return out;
}

// ─── 变体共用的派生数据 ─────────────────────────────────────────────────────
type Icon = ComponentProps<typeof HugeiconsIcon>["icon"];

const GROUP_ICON: Record<GroupKind, Icon> = {
  prefix: TagsIcon,
  used: Link01Icon,
  unused: Unlink01Icon,
  manual: Folder01Icon,
  other: MoreHorizontalIcon,
  ungrouped: InboxUnreadIcon,
};

/** 分组 → 小图标（分区头色块 / 导览栏用）。 */
export function varGroupIcon(kind: GroupKind): Icon {
  return GROUP_ICON[kind];
}

/** 分组 → 分区染色（变体 A 的 data-amb）：手动组用它自己的卡片颜色；「未分组」是兜底桶，走中性灰；
 * 其余分组方式按组序轮换蓝 / 绿 / 紫。 */
export function ambOfGroup(g: VarGroup, index: number): GroupColor | "none" {
  if (g.kind === "manual") return g.color ?? "blue";
  if (g.kind === "ungrouped") return "none";
  return AMBS[index % AMBS.length];
}

/** 一行的两条关系线：它的值引用了谁（from），谁又引用了它（by）。只列已定义的变量。 */
export function relations(row: VarRow, rows: VarRow[]): { from: string[]; by: string[] } {
  const key = row.key.trim();
  const defined = new Set(rows.map((r) => r.key.trim()).filter(Boolean));
  return {
    from: extractVars(row.value).filter((v) => defined.has(v)),
    by: key ? usedByVars(key, rows) : [],
  };
}

/** 被引用、却没有定义的变量（如片段里的 ${PATH}），按引用数降序。 */
export function missingDefs(
  refCounts: RefCounts,
  rows: VarRow[],
): { name: string; count: number }[] {
  const defined = new Set(rows.map((r) => r.key.trim()));
  return Object.entries(refCounts)
    .filter(([name, n]) => !defined.has(name) && (n ?? 0) > 0)
    .map(([name, n]) => ({ name, count: n ?? 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** 引用计数 / 未用 / 重复 → 一段纯文字（三套变体同一口径：重复 > 引用数 > 未用）。 */
export function useRefMeta() {
  const { t } = useTranslation();
  return (ref: number, dup: boolean) =>
    dup
      ? t("global.dup")
      : ref > 0
        ? t("global.refCount", { count: ref })
        : t("global.unused");
}

/** 分组头副行：常规组列成员名当索引（收起时也读得出内容）；兜底组改读规则说明。 */
export function groupSub(g: VarGroup, max = 3): string {
  if (g.kind === "used" || g.kind === "unused" || g.kind === "other" || g.kind === "ungrouped") {
    return g.hint;
  }
  const keys = g.rows.map(({ row }) => row.key.trim()).filter(Boolean);
  return keys.length === 0 ? g.hint : `${keys.slice(0, max).join(" · ")}${keys.length > max ? " …" : ""}`;
}

export function useVarGroups() {
  const d = useVarDraft();
  const mg = useManualGroups();
  const { group: mode } = useProtoState();
  const c = useCopy();
  const { rows, varRefCounts } = d;
  const groups = useMemo(
    () => groupVars(rows, mode, varRefCounts, mg, c),
    [rows, mode, varRefCounts, mg, c],
  );
  const missing = useMemo(() => missingDefs(varRefCounts, rows), [varRefCounts, rows]);
  return { ...d, groups, mode, c, missing };
}

/** 当前分组依据的一句话说明（页顶说明行 / 导览栏提示用）。 */
export function modeHint(c: Copy, mode: GroupMode): string {
  return mode === "prefix" ? c.gmPrefixHint : mode === "usage" ? c.gmUsageHint : c.gmManualHint;
}
