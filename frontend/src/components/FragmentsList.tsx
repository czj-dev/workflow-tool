import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  CheckmarkCircle02Icon,
  Copy02Icon,
  Delete02Icon,
  Edit02Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { IconButton } from "./IconButton";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { useActionRunner } from "../hooks/useActionRunner";
import { expandVars, extractVars } from "@/lib/vars";
import { FragmentDialog, type FragmentRow } from "./FragmentDialog";
import { cn } from "@/lib/utils";

// 删除二次确认窗口（ms）：首次点击进入待确认，超时自动复原
const CONFIRM_WINDOW_MS = 2000;
const COPIED_FEEDBACK_MS = 1200;

const VAR_SPLIT_RE = /(\$\{[A-Za-z0-9_]+\})/g;

// EditableVarPill：缺失变量的可点击 pill。未填时显示变量名（红框），
// 点击后原地变 input，Enter/失焦提交，Esc 取消。已填时显示填入的值
// （琥珀 + 虚线下边框，区别于全局定义的实心琥珀），仍可再点重新编辑。
function EditableVarPill({
  name,
  value,
  onSubmit,
}: {
  name: string;
  value?: string;
  onSubmit: (name: string, value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  if (editing) {
    return (
      <input
        aria-label={name}
        autoFocus
        // 预览段落宽度有限（卡片右侧被操作按钮占走），故占满整行而非按比例，
        // 编辑态本身是临时的，独占一行不影响浏览。
        className="my-px inline-block w-full rounded-sm border border-primary/50 bg-background px-1 py-px font-mono text-[11px] outline-none"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setDraft(value ?? "");
            setEditing(false);
          }
        }}
        onBlur={() => {
          if (draft.trim()) onSubmit(name, draft);
          setEditing(false);
        }}
      />
    );
  }

  const filled = value !== undefined;
  return (
    <button
      type="button"
      onClick={() => {
        setDraft(value ?? "");
        setEditing(true);
      }}
      className={cn(
        "mx-px rounded-sm px-1 py-px font-mono text-[11px]",
        filled
          ? "border-b border-dashed border-primary/50 bg-primary/12 text-primary"
          : "border border-destructive/50 text-destructive",
      )}
      title={filled ? name : undefined}
    >
      {filled ? value : name}
    </button>
  );
}

// 内容预览：把 ${VAR} 渲染成内联 pill，其余原样。琥珀=已定义（hover 显实际值），
// 红框=全局配置缺失（可点击就地填临时值）。复制走 expandVars 输出纯文本。
function ContentPreview({
  content,
  vars,
  overrides,
  onSetVar,
}: {
  content: string;
  vars: Record<string, string>;
  overrides: Record<string, string>;
  onSetVar: (name: string, value: string) => void;
}) {
  const parts = content.split(VAR_SPLIT_RE);
  return (
    <>
      {parts.map((part, i) => {
        const m = /^\$\{([A-Za-z0-9_]+)\}$/.exec(part);
        if (!m) return part;
        const name = m[1];
        const value = vars[name];
        const defined = value !== undefined;
        // 已定义（全局配置）：只读 pill，hover 看值
        if (defined) {
          const pill = (
            <span className="mx-px rounded-sm bg-primary/12 px-1 py-px font-mono text-[11px] text-primary">
              {name}
            </span>
          );
          return (
            <Tooltip key={i}>
              <TooltipTrigger render={pill} />
              <TooltipContent className="font-mono text-xs">{value}</TooltipContent>
            </Tooltip>
          );
        }
        // 未定义：可点击就地填写，临时值只在本会话生效
        return (
          <EditableVarPill
            key={i}
            name={name}
            value={overrides[name]}
            onSubmit={onSetVar}
          />
        );
      })}
    </>
  );
}

// TagChip：Tag 筛选按钮。active 高亮 primary；label 后跟计数，
// 计数让按钮 textContent ≠ tag 名，避免与分组标题的 getByText 冲突。
function TagChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Badge
      variant={active ? "default" : "secondary"}
      className="cursor-pointer font-mono text-[11px] uppercase tracking-wide"
      render={<button type="button" onClick={onClick} aria-pressed={active} />}
    >
      {label}
      <span className={active ? "opacity-70" : "opacity-50"}>{count}</span>
    </Badge>
  );
}

// ─── 片段列表核心：搜索 + Tag 筛选 + 分组浏览 + 复制 + CRUD ────────────────
// 全页视图（FragmentsView）与非模态抽屉（FragmentsSheet）共用同一份；
// 数据来自 Provider（fragments/globalConfig/saveFragments），两处天然同步。
// overrides 等临时态随组件实例各持一份——语义是「本次浏览会话」，无需跨实例同步。
// 注意：根节点是 fragment，要求父容器是 flex-col（三段各自 border-b 流式排布，
// 列表区 flex-1 overflow-auto 撑满剩余高度）。
export function FragmentsList() {
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
  const query = q.trim().toLowerCase();

  const setVarOverride = (i: number, name: string, value: string) => {
    setOverrides((cur) => ({
      ...cur,
      [i]: { ...(cur[i] ?? {}), [name]: value },
    }));
  };

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    fragments.forEach((f) =>
      f.tags?.forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1)),
    );
    return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [fragments]);

  const allTags = useMemo(() => tagCounts.map(([tag]) => tag), [tagCounts]);

  // 搜索 + Tag 双重过滤：命中标题 / 内容 / 任一 tag
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

  // 分组：选了 tag 归该 tag 一组；未选时按「第一个 tag」归组，避免多 tag 片段重复显示
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
    void saveFragments(fragments.filter((_, idx) => idx !== i));
  };

  // 单条落盘：editing=-1 追加，否则替换该索引
  const saveOne = (row: FragmentRow) => {
    const list =
      editing === -1
        ? [...fragments, row]
        : fragments.map((f, idx) => (idx === editing ? row : f));
    setOverrides({}); // 内容可能变了，旧的临时变量值不再适用
    void saveFragments(list);
    setEditing(null);
  };

  return (
    <>
      {/* 搜索行：搜索框 + 新增（两个容器共用的工具行，新增入口随核心走） */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <InputGroup className="flex-1">
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
        <IconButton
          icon={Add01Icon}
          label={t("fragments.add")}
          variant="outline"
          onClick={() => setEditing(-1)}
        />
      </div>

      {/* TagList：点击筛选，active 高亮；再点同一个或点「全部」取消 */}
      {tagCounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2">
          <TagChip
            label={t("fragments.all")}
            count={fragments.length}
            active={activeTag === null}
            onClick={() => setActiveTag(null)}
          />
          {tagCounts.map(([tag, count]) => (
            <TagChip
              key={tag}
              label={tag}
              count={count}
              active={activeTag === tag}
              onClick={() => setActiveTag((cur) => (cur === tag ? null : tag))}
            />
          ))}
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
        <div className="flex flex-1 flex-col gap-6 overflow-auto p-4">
          {Array.from(groups.entries()).map(([tag, idxs]) => (
            <section key={tag} className="flex flex-col gap-2">
              <h3 className="flex items-baseline gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
                {/* tag 名单独成节点，计数分隔，便于检索与无障碍 */}
                <span>{tag}</span>
                <span className="text-muted-foreground/40">· {idxs.length}</span>
              </h3>
              <ItemGroup>
                {idxs.map((i) => {
                  const f = fragments[i];
                  const fragOverrides = overrides[i] ?? {};
                  const missing = extractVars(f.content).filter(
                    (v) => !(v in globalConfig) && !(v in fragOverrides),
                  );
                  const armed = pendingDelete === i;
                  return (
                    <Item
                      key={i}
                      variant="outline"
                      className="transition-colors hover:bg-muted/40"
                    >
                      <ItemContent>
                        <ItemTitle>
                          {f.title || t("fragments.untitled")}
                        </ItemTitle>
                        <ItemDescription className="line-clamp-3 whitespace-pre-wrap break-all font-mono text-xs leading-relaxed group-hover/item:line-clamp-none">
                          <ContentPreview
                            content={f.content}
                            vars={globalConfig}
                            overrides={overrides[i] ?? {}}
                            onSetVar={(name, value) => setVarOverride(i, name, value)}
                          />
                        </ItemDescription>
                        {missing.length > 0 && (
                          <p className="mt-1 font-mono text-[10px] text-destructive">
                            {t("fragments.missingVars")} · {missing.join(" ")}
                          </p>
                        )}
                      </ItemContent>
                      <ItemActions>
                        <IconButton
                          icon={
                            copiedIdx === i
                              ? CheckmarkCircle02Icon
                              : Copy02Icon
                          }
                          label={
                            copiedIdx === i
                              ? t("fragments.copied")
                              : t("fragments.copy")
                          }
                          variant="outline"
                          className={
                            copiedIdx === i ? "text-success" : undefined
                          }
                          onClick={() => copyOne(i)}
                        />
                        <IconButton
                          icon={Edit02Icon}
                          label={t("fragments.edit")}
                          className="text-muted-foreground/60 hover:text-foreground"
                          onClick={() => setEditing(i)}
                        />
                        <IconButton
                          icon={Delete02Icon}
                          label={
                            armed
                              ? t("fragments.confirmDelete")
                              : t("fragments.remove")
                          }
                          className={cn(
                            "transition-colors",
                            armed
                              ? "bg-destructive/10 text-destructive"
                              : "text-muted-foreground/50 hover:text-destructive",
                          )}
                          onClick={() => clickDelete(i)}
                        />
                      </ItemActions>
                    </Item>
                  );
                })}
              </ItemGroup>
            </section>
          ))}
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
