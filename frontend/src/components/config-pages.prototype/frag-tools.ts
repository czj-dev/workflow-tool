// PROTOTYPE（一次性）：片段页三套变体共用的行为——搜索 / tag 筛选 / 复制 / 删除二次确认 /
// 新增编辑 / 缺失变量临时值（含拖拽落值）/ 条目颜色（仅变体 A 用，见下方「条目颜色」）。
// 逻辑与正式 FragmentsList 一致，只是抽成 hook 供三种版式复用；版式差异（行卡 / 账本行 / 导览栏）各归各的 Variant 文件。
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { Events } from "@wailsio/runtime";
import type { HugeiconsIcon } from "@hugeicons/react";
import {
  AiChat02Icon,
  AndroidIcon,
  DatabaseIcon,
  Link01Icon,
  Search01Icon,
  SearchList01Icon,
  TagsIcon,
} from "@hugeicons/core-free-icons";
import { expandVars, extractVars } from "@/lib/vars";
import { joinDroppedPaths, type FileDropPayload } from "@/lib/filedrop";
import { useActionRunner } from "../../hooks/useActionRunner";
import type { FragmentRow } from "../FragmentDialog";
import type { Fragment } from "../../../bindings/workflow-tool/internal/registry/models.js";
import type { GroupColor } from "./styles";

// 删除二次确认窗口（ms）：首次点击进入待确认，超时自动复原
export const CONFIRM_WINDOW_MS = 2000;
export const COPIED_FEEDBACK_MS = 1200;

type Icon = ComponentProps<typeof HugeiconsIcon>["icon"];
export type FragHit = { f: Fragment; i: number };

/** tag → 小图标：分组头 / 导览栏用。按关键字猜，猜不到给通用标签图标。 */
export function tagIcon(tag: string): Icon {
  const t = tag.toLowerCase();
  if (/adb|android|device/.test(t)) return AndroidIcon;
  if (/log/.test(t)) return SearchList01Icon;
  if (/link|url|http/.test(t)) return Link01Icon;
  if (/ai|box|agent/.test(t)) return AiChat02Icon;
  if (/rg|grep|find/.test(t)) return Search01Icon;
  if (/lnav|view|data/.test(t)) return DatabaseIcon;
  return TagsIcon;
}

// ─── 条目颜色（仅内存）──────────────────────────────────────────────────────
// 片段本身没有颜色字段（原型不动 schema）：颜色另存一份，按片段下标与 useActionRunner 的 fragments 对齐。
// 对齐认「列表身份」而不认时机——保存是异步的，颜色当帧就到、列表要到下一个微任务才到；若直接按下标取，
// 删除后那一帧里后一张卡会顶上前一张的颜色。所以同时留着「当前对齐的」和「下次保存后的」两份，
// 渲染时按手里的列表是哪一份来取；保存失败则新列表不会到来，旧的那份继续生效。
// 正式落地 = Fragment 增加一个 color 字段，这整段随之删除。
type ColorList = (GroupColor | null)[];

type ColorState = {
  base: { list: Fragment[]; colors: ColorList };
  next: { list: Fragment[]; colors: ColorList } | null;
};

const NO_FRAGS: Fragment[] = [];
let colorState: ColorState = { base: { list: NO_FRAGS, colors: [] }, next: null };
const colorSubs = new Set<() => void>();
const subscribeColors = (cb: () => void) => {
  colorSubs.add(cb);
  return () => {
    colorSubs.delete(cb);
  };
};

/** 与这份 fragments 对齐的颜色表：下标 = 片段下标，null = 没选过（渲染时跟随分组的颜色）。 */
function colorsFor(list: Fragment[]): ColorList {
  const { base, next } = colorState;
  return next?.list === list ? next.colors : base.colors;
}

/** 渲染用：与这份 fragments 对齐的颜色表（引用稳定，可放进 useMemo 依赖）。 */
export function useFragColors(list: Fragment[]): ColorList {
  return useSyncExternalStore(subscribeColors, () => colorsFor(list), () => colorsFor(list));
}

/** 登记一次改动：cur = 改动所依据的列表（此刻的 fragments），next = 即将保存的新列表和它的颜色表。 */
function stageColors(cur: Fragment[], next: Fragment[], colors: ColorList) {
  colorState = { base: { list: cur, colors: colorsFor(cur) }, next: { list: next, colors } };
  colorSubs.forEach((f) => f());
}

export function useFragTools() {
  const { fragments, globalConfig, saveFragments } = useActionRunner();
  const colors = useFragColors(fragments);

  const [q, setQ] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  // null=关闭；-1=新增；>=0 编辑该索引
  const [editing, setEditing] = useState<number | null>(null);
  // 缺失变量的临时填写值：fragment 索引 → 变量名 → 值。仅内存，不落盘。
  const [overrides, setOverrides] = useState<Record<number, Record<string, string>>>({});
  const query = q.trim().toLowerCase();

  const setVarOverride = useCallback((i: number, name: string, value: string) => {
    setOverrides((cur) => ({ ...cur, [i]: { ...(cur[i] ?? {}), [name]: value } }));
  }, []);

  // 片段变量 token 的拖拽赋值：只有「未定义变量」带 data-drop-var（与正式页同一约定）
  useEffect(() => {
    return Events.On("file:dropped", (e: { data: FileDropPayload }) => {
      const { paths, x, y } = e.data ?? {};
      if (!paths?.length || x === undefined || y === undefined) return;
      const token = document.elementFromPoint(x, y)?.closest("[data-drop-var]");
      if (!(token instanceof HTMLElement)) return;
      const name = token.dataset.dropVar;
      const frag = token.dataset.dropFrag;
      if (!name || frag === undefined) return;
      setVarOverride(Number(frag), name, joinDroppedPaths(paths));
    });
  }, [setVarOverride]);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    fragments.forEach((f) => f.tags?.forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1)));
    return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [fragments]);

  // 搜索 + tag 双重过滤：命中标题 / 内容 / 任一 tag
  const filtered = useMemo<FragHit[]>(() => {
    let all = fragments.map((f, i) => ({ f, i }));
    if (activeTag) all = all.filter(({ f }) => (f.tags ?? []).includes(activeTag));
    if (query) {
      all = all.filter(({ f }) =>
        [f.title, f.content, ...(f.tags ?? [])].join(" ").toLowerCase().includes(query),
      );
    }
    return all;
  }, [fragments, activeTag, query]);

  const copyOne = async (i: number) => {
    const vars = { ...globalConfig, ...(overrides[i] ?? {}) };
    await navigator.clipboard.writeText(expandVars(fragments[i].content, vars));
    setCopiedIdx(i);
    setTimeout(
      () => setCopiedIdx((cur) => (cur === i ? null : cur)),
      COPIED_FEEDBACK_MS,
    );
  };

  // 删除二次确认：首次点击标记 pending，窗口内再点才真删
  const clickDelete = (i: number) => {
    if (pendingDelete !== i) {
      setPendingDelete(i);
      setTimeout(
        () => setPendingDelete((cur) => (cur === i ? null : cur)),
        CONFIRM_WINDOW_MS,
      );
      return;
    }
    setPendingDelete(null);
    setOverrides({}); // 索引会整体前移，临时值直接清空避免串值
    const rest = fragments.filter((_, idx) => idx !== i);
    stageColors(fragments, rest, colors.filter((_, idx) => idx !== i));
    void saveFragments(rest);
  };

  // 单条落盘：editing=-1 追加，否则替换该索引。
  // color = 这条卡片的颜色（变体 A 的弹窗传）。不传 = 不动颜色：新增的记 null（跟随分组），编辑的保持原值——
  // 颜色表的下标始终与片段对齐，B / C 两套变体走旧弹窗也不会错位。
  const saveOne = (row: FragmentRow, color?: GroupColor) => {
    // 弹窗只在 editing 非 null 时存在，这里只是把类型收窄
    if (editing === null) return;
    const list = editing === -1 ? [...fragments, row] : fragments.map((f, idx) => (idx === editing ? row : f));
    const nextColors = colors.slice(0, fragments.length);
    if (editing === -1) nextColors.push(color ?? null);
    else if (color !== undefined) nextColors[editing] = color;
    stageColors(fragments, list, nextColors);
    setOverrides({});
    void saveFragments(list);
    setEditing(null);
  };

  const missingOf = (i: number): string[] => {
    const fragOverrides = overrides[i] ?? {};
    return extractVars(fragments[i].content).filter((v) => !(v in globalConfig) && !(v in fragOverrides));
  };

  return {
    fragments,
    /** 与 fragments 按下标对齐的卡片颜色；null = 没选过 */
    colors,
    globalConfig,
    q,
    setQ,
    activeTag,
    setActiveTag,
    copiedIdx,
    pendingDelete,
    editing,
    setEditing,
    overrides,
    setVarOverride,
    tagCounts,
    allTags: tagCounts.map(([tag]) => tag),
    filtered,
    copyOne,
    clickDelete,
    saveOne,
    missingOf,
  };
}

/** 片段按「第一个 tag」归组（多 tag 不重复出现）；选了 tag 则整组归它。保持原列表顺序。 */
export function groupFrags(
  hits: FragHit[],
  activeTag: string | null,
  uncategorized: string,
): Map<string, number[]> {
  const map = new Map<string, number[]>();
  hits.forEach(({ f, i }) => {
    const primary = activeTag ? activeTag : f.tags?.[0] ?? uncategorized;
    const list = map.get(primary) ?? [];
    list.push(i);
    map.set(primary, list);
  });
  return map;
}

export interface FragTab {
  tag: string | null;
  label: string;
  count: number;
}

/** tag 页签数据：首项「全部」，其后各 tag 按字母序（tagCounts 已排好）。 */
export function fragTabs(
  fragments: Fragment[],
  tagCounts: [string, number][],
  allLabel: string,
): FragTab[] {
  return [
    { tag: null, label: allLabel, count: fragments.length },
    ...tagCounts.map(([tag, count]) => ({ tag, label: tag, count })),
  ];
}
