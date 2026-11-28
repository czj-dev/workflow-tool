// PROTOTYPE（一次性，定稿即删）：「全局配置 / 指令片段」三套版式变体的共享状态。
// URL 即原型状态——?variant=A|B|C&view=global|fragments[&group=prefix|usage|manual][&theme=dark|light]。
// 全局配置默认手动分组（定稿方向）；group 参数只留给「按前缀 / 按引用」两种自动分组的对照。
// 没有 variant 参数 = 原型关闭，正式页面照常渲染（见 slot.tsx；测试与默认路径不经过本文件）。
// replaceState 不留历史：切变体 / 翻页是「比较」动作，不应把后退键塞满。
import { useSyncExternalStore } from "react";
import { isVariant, type VariantKey } from "./session";

export type { VariantKey };
export type ProtoPageId = "global" | "fragments";
export type GroupMode = "prefix" | "usage" | "manual";

/** 三套变体组件的统一入参。 */
export interface VariantProps {
  page: ProtoPageId;
  /** true = 渲染在片段抽屉里（只有 fragments 会用到） */
  inSheet: boolean;
}

export interface ProtoState {
  /** null = 原型关闭 */
  variant: VariantKey | null;
  page: ProtoPageId;
  group: GroupMode;
  theme: "dark" | "light" | null;
}

export const VARIANTS: { key: VariantKey; name: string; idea: string }[] = [
  {
    key: "A",
    name: "分区镜像",
    idea: "沿用侧栏「板块」语法：顶线分区 + 两行分组头 + 浅染条目；手动分组，每组可从五色色卡选卡片色，颜色只落在色块与条目底色",
  },
  {
    key: "B",
    name: "索引账本",
    idea: "纯文字索引：等宽眉标 + 细线 + 单行密排，零分组色；点行原地展开",
  },
  {
    key: "C",
    name: "双栏导览",
    idea: "左栏分组导航（同侧栏「配置」段，amber 标选中）+ 右栏逐组细读",
  },
];

const isGroupMode = (v: string | null): v is GroupMode =>
  v === "prefix" || v === "usage" || v === "manual";
const isTheme = (v: string | null): v is "dark" | "light" => v === "dark" || v === "light";

let cache: { search: string; state: ProtoState } | null = null;

export function readProtoState(): ProtoState {
  const search = window.location.search;
  if (cache && cache.search === search) return cache.state;
  const p = new URLSearchParams(search);
  const rawVariant = p.get("variant")?.toUpperCase() ?? null;
  const rawGroup = p.get("group");
  const rawTheme = p.get("theme");
  const state: ProtoState = {
    variant: isVariant(rawVariant) ? rawVariant : null,
    page: p.get("view") === "fragments" ? "fragments" : "global",
    group: isGroupMode(rawGroup) ? rawGroup : "manual",
    theme: isTheme(rawTheme) ? rawTheme : null,
  };
  cache = { search, state };
  return state;
}

const ORDER: VariantKey[] = ["A", "B", "C"];

/** 上一个 / 下一个变体（循环）。当前是「现行版」（null）时：向右进 A，向左进 C。 */
export function stepVariant(cur: VariantKey | null, dir: 1 | -1): VariantKey {
  if (cur === null) return dir === 1 ? "A" : "C";
  return ORDER[(ORDER.indexOf(cur) + dir + ORDER.length) % ORDER.length];
}

const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onPop = () => {
    cache = null;
    cb();
  };
  window.addEventListener("popstate", onPop);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("popstate", onPop);
  };
}

export function setProtoState(patch: Partial<ProtoState>) {
  const cur = readProtoState();
  const next: ProtoState = {
    variant: patch.variant === undefined ? cur.variant : patch.variant,
    page: patch.page ?? cur.page,
    group: patch.group ?? cur.group,
    theme: patch.theme === undefined ? cur.theme : patch.theme,
  };
  if (
    next.variant === cur.variant &&
    next.page === cur.page &&
    next.group === cur.group &&
    next.theme === cur.theme
  ) {
    return;
  }
  const p = new URLSearchParams(window.location.search);
  const put = (k: string, v: string | null) => (v === null ? p.delete(k) : p.set(k, v));
  put("variant", next.variant);
  put("view", next.variant ? next.page : null);
  put("group", next.variant ? next.group : null);
  put("theme", next.theme);
  const qs = p.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`,
  );
  cache = null;
  listeners.forEach((l) => l());
}

export function useProtoState(): ProtoState {
  return useSyncExternalStore(subscribe, readProtoState, readProtoState);
}
