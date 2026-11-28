import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
} from "react";
import { useTranslation } from "react-i18next";
import { Events } from "@wailsio/runtime";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  AiChat02Icon,
  AndroidIcon,
  CheckmarkCircle02Icon,
  Copy02Icon,
  DatabaseIcon,
  Delete02Icon,
  Edit02Icon,
  Link01Icon,
  Search01Icon,
  SearchList01Icon,
  TagsIcon,
} from "@hugeicons/core-free-icons";
import { IconButton } from "./IconButton";
import { useActionRunner } from "../hooks/useActionRunner";
import { expandVars, extractVars, resolveGlobalConfig } from "@/lib/vars";
import { joinDroppedPaths, type FileDropPayload } from "@/lib/filedrop";
import { FragmentDialog, type FragmentRow } from "./FragmentDialog";
import { SectionHead } from "@/components/config-pages/section-head";
import { TokenText } from "@/components/config-pages/token-text";
import { AMB_COLORS, type AmbColor } from "@/components/config-pages/colors";
import type { Fragment } from "../../bindings/workflow-tool/internal/registry/models.js";
import { cn } from "@/lib/utils";

// 删除二次确认窗口（ms）：首次点击进入待确认，超时自动复原
const CONFIRM_WINDOW_MS = 2000;
const COPIED_FEEDBACK_MS = 1200;

// 片段分区的固定色（规格 F）：分区一律琥珀，颜色下放给条目——每条片段自己选
const GROUP_AMB = "amber";

// Tab 键值：「全部」用裸 "all"，tag 加 t: 前缀，不与真实 tag 同名冲突
const ALL_KEY = "all";
const tabKey = (tag: string | null) => (tag === null ? ALL_KEY : `t:${tag}`);

// 行内附加动作（编辑 / 删除）：静止时透明但仍在 Tab 序里，悬停本行、键盘聚焦到
// 本行、或它自己获得焦点时出现。opacity 而非 visibility（规格 G：看不见的按钮
// 键盘用户也够得着）；待确认删除刻意常显。
const ROW_ACTION =
  "pointer-events-none opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100";

type Icon = ComponentProps<typeof HugeiconsIcon>["icon"];

/** tag → 小图标（分区头用）：按关键字猜，猜不到给通用标签图标。 */
function tagIcon(tag: string): Icon {
  const t = tag.toLowerCase();
  if (/adb|android|device/.test(t)) return AndroidIcon;
  if (/log/.test(t)) return SearchList01Icon;
  if (/link|url|http/.test(t)) return Link01Icon;
  if (/ai|box|agent/.test(t)) return AiChat02Icon;
  if (/rg|grep|find/.test(t)) return Search01Icon;
  if (/lnav|view|data/.test(t)) return DatabaseIcon;
  return TagsIcon;
}

/** 存档里的颜色 → 五色值：未设置或越界回落分区固定琥珀（后端本就按白名单规整）。 */
function normalizeColor(color: string | undefined): AmbColor {
  return (AMB_COLORS as readonly string[]).includes(color ?? "")
    ? (color as AmbColor)
    : "amber";
}

// FragCard：一条片段卡（#10 方案 A）。标题即复制——片段页的主操作给最大点击面；
// 编辑 / 删除是悬停 / 键盘聚焦本行才出现的附加动作；底色吃 .tint-card，自带颜色的
// 卡用 .frag-card[data-amb] 在自己身上重定义 --amb/--tintc（没选过的不写 data-amb，
// 继承所在分区的琥珀）；命令预览走 TokenText（${VAR} token 原样渲染，缺失可点就地
// 填写 / 拖拽落值）。others 提示这条还带的其它标签（+tag），容器 ≥ md 才显示。
function FragCard({
  f,
  i,
  groupTag,
  copied,
  armed,
  overrides,
  vars,
  onCopy,
  onEdit,
  onDelete,
  onSetVar,
}: {
  f: Fragment;
  i: number;
  groupTag: string;
  copied: boolean;
  armed: boolean;
  overrides: Record<string, string>;
  vars: Record<string, string>;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSetVar: (name: string, value: string) => void;
}) {
  const { t } = useTranslation();
  const others = (f.tags ?? []).filter((tag) => tag !== groupTag);
  const missing = extractVars(f.content).filter(
    (v) => !(v in vars) && !(v in overrides),
  );

  return (
    <article
      data-amb={f.color ? normalizeColor(f.color) : undefined}
      className="frag-card tint-card group/row @container rounded-md px-2 py-1.5"
    >
      <div className="flex items-center gap-2">
        {/* 标题即「复制」：这是片段页的主操作，给它最大的点击面 */}
        <button
          type="button"
          onClick={onCopy}
          title={t("fragments.clickToCopy")}
          className="min-w-0 flex-1 cursor-copy truncate text-left text-[13px] leading-[18px] font-medium text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
        >
          {f.title || t("fragments.untitled")}
        </button>
        {others.length > 0 && (
          <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground/70 @md:inline">
            +{others.join(" +")}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            icon={copied ? CheckmarkCircle02Icon : Copy02Icon}
            label={copied ? t("fragments.copied") : t("fragments.copy")}
            className={cn(
              "text-muted-foreground/70 hover:text-foreground",
              copied && "text-success hover:text-success",
            )}
            onClick={onCopy}
          />
          <IconButton
            icon={Edit02Icon}
            label={t("fragments.edit")}
            className={cn("text-muted-foreground/70 hover:text-foreground", ROW_ACTION)}
            onClick={onEdit}
          />
          <IconButton
            icon={Delete02Icon}
            label={armed ? t("fragments.confirmDelete") : t("fragments.remove")}
            className={cn(
              "hover:text-destructive",
              armed
                ? "bg-destructive/10 text-destructive"
                : cn("text-muted-foreground/70", ROW_ACTION),
            )}
            onClick={onDelete}
          />
        </div>
      </div>
      {/* 命令预览：两行截断，悬停展开全文；token 原样 ${VAR} 写法 */}
      <div className="mt-0.5 font-mono text-xs leading-5 break-all whitespace-pre-wrap text-foreground/85 line-clamp-2 group-hover/row:line-clamp-none">
        <TokenText
          content={f.content}
          vars={vars}
          overrides={overrides}
          fragIndex={i}
          onSetVar={onSetVar}
        />
      </div>
      {missing.length > 0 && (
        <p className="mt-1 font-mono text-[10px] leading-4 text-destructive">
          {t("fragments.missingVars")} · {missing.join(" ")}
        </p>
      )}
    </article>
  );
}

// ─── 片段列表核心：页头 / 工具行 + 标签页签 + 琥珀分区 + 卡片 + 复制 + CRUD ────
// 全页视图（FragmentsView）与非模态抽屉（FragmentsSheet）共用同一份；数据来自
// Provider（fragments/globalConfig/saveFragments），两处天然同步。页头（标题 /
// 搜索 / 新增 / 统计）只属于全页，抽屉模式（inSheet）只画搜索 + 新增一行——
// 抽屉自己的 SheetHeader 已有标题与关闭钮，统计行刻意不进抽屉（窄空间信息密度）。
// overrides 等临时态随组件实例各持一份——语义是「本次浏览会话」，无需跨实例同步。
// 注意：根节点是 fragment，要求父容器是 flex-col（工具行 / 页签 / 列表区依次
// border-b 流式排布，列表区 flex-1 min-h-0 overflow-auto 撑满剩余高度）。
export function FragmentsList({ inSheet = false }: { inSheet?: boolean }) {
  const { t } = useTranslation();
  const { fragments, globalConfig, saveFragments } = useActionRunner();

  const [q, setQ] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  // null=关闭；-1=新增；>=0 编辑该索引
  const [editing, setEditing] = useState<number | null>(null);
  // 缺失变量的临时填写值：fragment 索引 → 变量名 → 值。仅内存，不落盘，
  // 编辑/删除片段后索引可能错位，此时整体清空（见 saveOne/clickDelete）。
  const [overrides, setOverrides] = useState<Record<number, Record<string, string>>>({});
  // 分区折叠集合（内存态，默认全展开）与焦点所在分区（data-lit 提亮）
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [lit, setLit] = useState<string | null>(null);
  const query = q.trim().toLowerCase();

  // useCallback：拖拽订阅 effect 要拿它做依赖又不能每次渲染重新订阅（只用到稳定的 setOverrides）
  const setVarOverride = useCallback((i: number, name: string, value: string) => {
    setOverrides((cur) => ({
      ...cur,
      [i]: { ...(cur[i] ?? {}), [name]: value },
    }));
  }, []);

  // 片段变量 token 的拖拽赋值：token 是 <button> 且不在任何 Field 内，Provider 那条通用落点
  // 管道对它必然落空静默，故这里独立订阅同一事件，两条路径互不干扰、无需额外通道。
  // 落下即写入 overrides（不经编辑态）——编辑态存在的目的就是输入值，拖拽已经把值给了。
  useEffect(() => {
    return Events.On("file:dropped", (e: { data: FileDropPayload }) => {
      const { paths, x, y } = e.data ?? {};
      if (!paths?.length || x === undefined || y === undefined) return;
      // 只有「未定义变量」的 token 带 data-drop-var；全局配置已定义的是只读 span，不接收
      const pill = document.elementFromPoint(x, y)?.closest("[data-drop-var]");
      if (!(pill instanceof HTMLElement)) return;
      const name = pill.dataset.dropVar;
      const frag = pill.dataset.dropFrag;
      if (!name || frag === undefined) return;
      setVarOverride(Number(frag), name, joinDroppedPaths(paths));
    });
  }, [setVarOverride]);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    fragments.forEach((f) =>
      f.tags?.forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1)),
    );
    return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [fragments]);

  const allTags = useMemo(() => tagCounts.map(([tag]) => tag), [tagCounts]);

  // 选中的标签被删光后回到「全部」：render-time 对照（同 GlobalConfigEditor 的
  // prev 同步模式），避免 effect 里 setState 的级联渲染
  const [prevAllTags, setPrevAllTags] = useState(allTags);
  if (allTags !== prevAllTags) {
    setPrevAllTags(allTags);
    if (activeTag !== null && !allTags.includes(activeTag)) {
      setActiveTag(null);
    }
  }

  // 搜索 + 标签页签双重过滤：命中标题 / 内容 / 任一 tag
  const filtered = useMemo(() => {
    let all = fragments.map((f, i) => ({ f, i }));
    if (activeTag) {
      all = all.filter(({ f }) => (f.tags ?? []).includes(activeTag));
    }
    if (query) {
      all = all.filter(({ f }) =>
        [f.title, f.content, ...(f.tags ?? [])]
          .join(" ")
          .toLowerCase()
          .includes(query),
      );
    }
    return all;
  }, [fragments, activeTag, query]);

  // 分组：选了 tag 归该 tag 一组；未选时按「第一个 tag」归组，避免多 tag 片段重复显示。
  // 分区键即 data-sec 值（未选标签时无 tag 片段进「未分类」）。
  const groups = useMemo(() => {
    const map = new Map<string, number[]>();
    filtered.forEach(({ f, i }) => {
      const primary = activeTag
        ? activeTag
        : f.tags?.[0] ?? t("fragments.uncategorized");
      const list = map.get(primary) ?? [];
      list.push(i);
      map.set(primary, list);
    });
    return map;
  }, [filtered, activeTag, t]);

  const copyOne = async (i: number) => {
    // config 层先解到终值再与临时填写合并（用户填写的值是数据，单遍替换不传递展开）。
    const vars = { ...resolveGlobalConfig(globalConfig), ...(overrides[i] ?? {}) };
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
    void saveFragments(fragments.filter((_, idx) => idx !== i));
  };

  // 单条落盘：editing=-1 追加，否则替换该索引。载荷按 Fragment 模型字段显式构造，
  // color 由弹窗保证有值（新增 / 未选过 = 分区固定琥珀），其余行对象原样引用不动。
  const saveOne = (row: FragmentRow) => {
    const frag: Fragment = {
      title: row.title,
      content: row.content,
      tags: row.tags,
      color: row.color,
    };
    const list =
      editing === -1
        ? [...fragments, frag]
        : fragments.map((f, idx) => (idx === editing ? frag : f));
    setOverrides({}); // 内容可能变了，旧的临时变量值不再适用
    void saveFragments(list);
    setEditing(null);
  };

  const search = (
    <InputGroup className={inSheet ? "min-w-0 flex-1" : "w-64"}>
      <InputGroupAddon>
        <HugeiconsIcon
          icon={Search01Icon}
          className="size-4 text-muted-foreground"
        />
      </InputGroupAddon>
      <InputGroupInput
        placeholder={t("fragments.searchPlaceholder")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
    </InputGroup>
  );
  const add = (
    <IconButton
      icon={Add01Icon}
      label={t("fragments.add")}
      variant="outline"
      onClick={() => setEditing(-1)}
    />
  );

  return (
    <>
      {/* 工具行：全页 = 页头（标题 / 搜索 / 新增 / 统计）；抽屉 = 搜索 + 新增独占一行 */}
      {inSheet ? (
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          {search}
          {add}
        </div>
      ) : (
        <header className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <SidebarTrigger />
          <span className="font-semibold">{t("fragments.title")}</span>
          <span className="min-w-0 flex-1" />
          {search}
          {add}
          <span className="shrink-0 font-mono text-[11px] tabular-nums whitespace-nowrap text-muted-foreground/70">
            {t("fragments.stats", { n: fragments.length, g: tagCounts.length })}
          </span>
        </header>
      )}

      {/* 标签页签（有标签才渲染）：「全部」+ 各标签（字母序），计数取全部片段的
          统计、不受搜索影响；底槽放不下时内部横向滚动（no-scrollbar）。 */}
      {tagCounts.length > 0 && (
        <div className="flex shrink-0 border-b px-4 py-1.5">
          <Tabs
            value={tabKey(activeTag)}
            onValueChange={(v) =>
              setActiveTag(v === ALL_KEY ? null : String(v).slice(2))
            }
            className="min-w-0 max-w-full"
          >
            <TabsList className="h-8 max-w-full gap-0.5 overflow-x-auto no-scrollbar">
              <TabsTrigger
                value={ALL_KEY}
                className="flex-none gap-1 px-2.5 py-0 text-xs"
              >
                {t("fragments.all")}
                <span className="font-mono text-[11px] font-normal tabular-nums text-muted-foreground">
                  {fragments.length}
                </span>
              </TabsTrigger>
              {tagCounts.map(([tag, count]) => (
                <TabsTrigger
                  key={tag}
                  value={tabKey(tag)}
                  className="flex-none gap-1 px-2.5 py-0 text-xs"
                >
                  {tag}
                  <span className="font-mono text-[11px] font-normal tabular-nums text-muted-foreground">
                    {count}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      )}

      {fragments.length === 0 ? (
        <Empty className="m-4 flex-none">
          <EmptyDescription>{t("fragments.empty")}</EmptyDescription>
        </Empty>
      ) : filtered.length === 0 ? (
        <Empty className="m-4 flex-none">
          <EmptyDescription>{t("fragments.noResults")}</EmptyDescription>
        </Empty>
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4"
          onFocusCapture={(e) => {
            // 焦点落在哪个分区，哪个分区整段提亮（data-lit）
            const sec =
              e.target instanceof Element ? e.target.closest("[data-sec]") : null;
            setLit(sec?.getAttribute("data-sec") ?? null);
          }}
          onBlurCapture={() => setLit(null)}
        >
          {Array.from(groups.entries()).map(([tag, idxs]) => {
            const secCollapsed = collapsed.has(tag);
            // 分区头副行：前三个非空标题，超出加省略号（空标题不进副行）
            const titles = idxs
              .map((i) => fragments[i].title)
              .filter(Boolean);
            const sub = `${titles.slice(0, 3).join(" · ")}${titles.length > 3 ? " …" : ""}`;
            return (
              <section
                key={tag}
                data-sec={tag}
                data-amb={GROUP_AMB}
                data-lit={lit === tag ? "" : undefined}
                className="side-sec rounded-lg border-t border-sidebar-border px-2 pt-2 pb-3"
              >
                <SectionHead
                  icon={tagIcon(tag)}
                  name={tag}
                  sub={sub}
                  count={idxs.length}
                  collapsed={secCollapsed}
                  onToggle={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (!next.delete(tag)) next.add(tag);
                      return next;
                    })
                  }
                />
                {!secCollapsed && (
                  <div className="flex flex-col gap-1">
                    {idxs.map((i) => (
                      <FragCard
                        key={i}
                        f={fragments[i]}
                        i={i}
                        groupTag={tag}
                        copied={copiedIdx === i}
                        armed={pendingDelete === i}
                        overrides={overrides[i] ?? {}}
                        vars={globalConfig}
                        onCopy={() => void copyOne(i)}
                        onEdit={() => setEditing(i)}
                        onDelete={() => clickDelete(i)}
                        onSetVar={(name, value) => setVarOverride(i, name, value)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {/* key 让每次开弹窗都重挂载，草稿状态天然重置，无需 useEffect 同步 */}
      {editing !== null && (
        <FragmentDialog
          key={editing}
          open
          initial={
            editing >= 0
              ? {
                  title: fragments[editing].title,
                  content: fragments[editing].content,
                  tags: fragments[editing].tags ?? [],
                  color: normalizeColor(fragments[editing].color),
                }
              : null
          }
          allTags={allTags}
          definedVars={globalConfig}
          onSave={saveOne}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
