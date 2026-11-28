// PROTOTYPE（一次性）变体 C「双栏导览」。
// 左栏 = 分组导航，右栏 = 一次只读一组。
// 左栏沿用侧栏「配置」段的条目原子（32px 行 / 16px 图标 / 14px 字；选中项 amber 12% 底 + amber 图标），
// 右栏是细线分隔的「定义块」：键 / 标题一行，值 / 命令另起一行整行铺开、不再截断；关系与动作用纯文字写出。
// 分组不靠颜色区分，靠「位置」：组是左栏里一个个可点的条目，右栏标题写明当前在哪一组。
// 它要回答的问题是：主区要不要像侧栏那样常驻一栏导航——换来每组独占整幅宽度、值与命令不必截断，
// 代价是少一栏横向空间，且一次只能看一组。
import { useMemo, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Alert02Icon, TagsIcon } from "@hugeicons/core-free-icons";
import { Input } from "@/components/ui/input";
import { IconButton } from "../IconButton";
import { cn } from "@/lib/utils";
import {
  AddSave,
  CommandText,
  FragmentDialogHost,
  GroupMoveSelect,
  MissingDefs,
  MissingNote,
  PageFrame,
  SearchBox,
  TextButton,
} from "./parts";
import { BARE_INPUT, EYEBROW } from "./styles";
import { groupFrags, tagIcon, useFragTools, type FragHit } from "./frag-tools";
import {
  assignManual,
  createManualGroup,
  groupVars,
  modeHint,
  relations,
  removeManualGroup,
  toKV,
  useManualGroups,
  useRefMeta,
  useVarGroups,
  varGroupIcon,
  type VarRow,
} from "./var-state";
import { setProtoState, type GroupMode, type VariantProps } from "./url-state";
import { useCopy } from "./copy";
import { requestReturnFocus, useReturnFocus } from "./row-state";

type Icon = ComponentProps<typeof HugeiconsIcon>["icon"];

export default function VariantC({ page, inSheet }: VariantProps) {
  return page === "global" ? <GlobalC /> : <FragmentsC inSheet={inSheet} />;
}

// ─── 左栏（导览栏）─────────────────────────────────────────────────────────
// 尺寸与 sidebarMenuButtonVariants 的 base 同一组值，但不复用 SidebarMenuButton：
// [data-sidebar=menu-button] 的侧栏专用规则（active 强调条 / 分组色）不该跟着进主区。
const RAIL =
  "flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0";
const RAIL_ON = "bg-sidebar-accent font-medium text-sidebar-accent-foreground [&_svg]:text-sidebar-primary";

function Rail({ label, narrow, children }: { label: string; narrow: boolean; children: ReactNode }) {
  return (
    <nav
      aria-label={label}
      className={cn(
        "flex shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-sidebar-border bg-sidebar px-2 pt-3 pb-12",
        narrow ? "w-40" : "w-52",
      )}
    >
      {children}
    </nav>
  );
}

function RailItem({
  icon,
  label,
  count,
  active,
  onClick,
  className,
}: {
  icon: Icon;
  label: string;
  count?: number;
  active?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={onClick}
      className={cn(RAIL, className, active && RAIL_ON)}
    >
      <HugeiconsIcon icon={icon} strokeWidth={1.75} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span className="shrink-0 font-mono text-[11px] opacity-60 tabular-nums">{count}</span>
      )}
    </button>
  );
}

/** 右栏标题：眉标（这是哪一栏）+ 组名 + 一句说明 + ·计数；底下一条细线。 */
function PaneHead({ eyebrow, name, hint, count }: { eyebrow: string; name: string; hint?: string; count: number }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border pb-2.5">
      <span className={cn(EYEBROW, "w-full")}>{eyebrow}</span>
      <h2 className="text-[15px] leading-6 font-semibold text-foreground">{name}</h2>
      {hint && <span className="min-w-0 text-xs text-muted-foreground">{hint}</span>}
      <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground/60 tabular-nums">
        ·{count}
      </span>
    </div>
  );
}

// ─── 全局配置 ───────────────────────────────────────────────────────────────

const MISSING_ID = "__missing";

/** 一条变量的两种形态：定义块（读）/ 编辑框（写）。合成一个组件是为了共用「关闭后把焦点还回来」。 */
function VarItem({ index, row, editing, onEdit, onDone }: {
  index: number;
  row: VarRow;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { rows, dupKeys, varRefCounts, mode, c, update, remove } = useVarGroups();
  const mg = useManualGroups();
  const meta = useRefMeta();
  const back = useReturnFocus();
  const key = row.key.trim();
  const dup = key !== "" && dupKeys.has(key);
  const ref = key ? (varRefCounts[key] ?? 0) : 0;
  const { from, by } = relations(row, rows);
  const metaCls = cn(
    "shrink-0 font-mono text-[11px] tabular-nums",
    dup ? "text-destructive" : "text-muted-foreground/70",
  );

  if (editing) {
    const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        requestReturnFocus(back);
        onDone();
      }
    };
    return (
      <div
        tabIndex={-1}
        // 已有行只把焦点交给编辑框容器：免得一进来就选中键名、随手一个退格把键改掉
        autoFocus={row.key !== ""}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            onDone();
          }
        }}
        className="rounded-md border border-border bg-muted/30 p-2 outline-none"
      >
        <div className="flex items-center gap-2">
          <Input
            autoFocus={row.key === ""}
            aria-label={t("global.keyPlaceholder")}
            value={row.key}
            onChange={(e) => update(index, "key", e.target.value)}
            placeholder={t("global.keyPlaceholder")}
            onKeyDown={onInputKey}
            className={cn(
              BARE_INPUT,
              "w-[28ch] flex-none font-semibold uppercase tracking-wide",
              dup && "text-destructive",
            )}
          />
          <span className="shrink-0 font-mono text-xs text-muted-foreground/45" aria-hidden="true">
            =
          </span>
          <Input
            aria-label={t("global.valuePlaceholder")}
            value={row.value}
            onChange={(e) => update(index, "value", e.target.value)}
            placeholder={t("global.valuePlaceholder")}
            onKeyDown={onInputKey}
            className={cn(BARE_INPUT, "min-w-0 flex-1")}
          />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-4 text-muted-foreground">
          <span className="font-mono">
            {dup ? t("global.dup") : ref > 0 ? c.fill("refsAt", { n: ref }) : c.noRefs}
          </span>
          {mode === "manual" && (
            <GroupMoveSelect
              value={mg.assign[key] ?? null}
              groups={mg.order}
              onSelect={(g) => assignManual(key, g)}
              label={c.moveToGroup}
              ungroupedLabel={c.ungrouped}
            />
          )}
          <span className="ml-auto flex items-center gap-1">
            <TextButton
              tone="danger"
              onClick={() => {
                remove(index);
                onDone();
              }}
            >
              {t("global.remove")}
            </TextButton>
            <TextButton onClick={onDone}>{c.done}</TextButton>
          </span>
        </div>
      </div>
    );
  }

  return (
    // tabIndex=-1：键盘关掉编辑框后焦点落回这一块（接着 Tab 就是它的「编辑」）
    <div ref={back} tabIndex={-1} className="group/row py-2.5 outline-none">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "min-w-0 truncate font-mono text-[13px] leading-5 font-semibold uppercase tracking-wide",
            dup ? "text-destructive" : "text-foreground",
          )}
        >
          {key || (
            <span className="font-normal tracking-normal text-muted-foreground/40">
              {t("global.keyPlaceholder")}
            </span>
          )}
        </span>
        <span className={metaCls}>{meta(ref, dup)}</span>
        <TextButton
          className="invisible ml-auto group-hover/row:visible focus-visible:visible"
          onClick={onEdit}
        >
          {c.edit}
        </TextButton>
      </div>
      {/* 值整行铺开：点一下即全选，方便直接拷走 */}
      <p className="mt-0.5 font-mono text-[13px] leading-5 break-all whitespace-pre-wrap text-foreground/85 select-all">
        {row.value ? (
          <CommandText content={row.value} vars={toKV(rows)} interactive={false} />
        ) : (
          <span className="text-muted-foreground/40">{t("global.valuePlaceholder")}</span>
        )}
      </p>
      {(from.length > 0 || by.length > 0) && (
        <div className="mt-0.5 flex flex-col gap-0.5 font-mono text-[11px] leading-4 text-muted-foreground/80">
          {from.length > 0 && (
            <span>
              <span className="opacity-60">↳ {c.derivedFrom}</span> {from.join(" ")}
            </span>
          )}
          {by.length > 0 && (
            <span>
              <span className="opacity-60">↳ {c.usedBy}</span> {by.join(" ")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function GlobalC() {
  const { t } = useTranslation();
  const { rows, dirty, dupKeys, groups, mode, c, missing, varRefCounts, add, save } =
    useVarGroups();
  const mg = useManualGroups();
  // 导览栏选中项：null = 第一组；选中项失效（组被删 / 换了分组依据）时也回落到第一组
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const group = groups.find((g) => g.id === sel) ?? groups[0];
  const onMissing = sel === MISSING_ID && missing.length > 0;
  const modes: { key: GroupMode; label: string }[] = [
    { key: "prefix", label: c.gmPrefix },
    { key: "usage", label: c.gmUsage },
    { key: "manual", label: c.gmManual },
  ];

  // 新增（或补定义）一行：左栏跳到它所在的组，右栏直接开编辑框
  const addRow = (key = "") => {
    const idx = add(key);
    const target = groupVars([...rows, { key, value: "" }], mode, varRefCounts, mg, c).find((g) =>
      g.rows.some((r) => r.index === idx),
    );
    if (target) setSel(target.id);
    setEditing(idx);
  };

  return (
    <PageFrame inSheet={false} title={t("global.title")} tools={<AddSave dirty={dirty} onAdd={() => addRow()} onSave={save} />}>
      <div className="flex min-h-0 flex-1">
        <Rail label={c.variables} narrow={false}>
          <div className={cn(EYEBROW, "px-2 pb-1.5")}>{c.variables}</div>
          {groups.map((g) => (
            <RailItem
              key={g.id}
              icon={varGroupIcon(g.kind)}
              label={g.name}
              count={g.rows.length}
              active={!onMissing && group?.id === g.id}
              onClick={() => setSel(g.id)}
            />
          ))}
          {missing.length > 0 && (
            <RailItem
              icon={Alert02Icon}
              label={c.missingDefs}
              count={missing.length}
              active={onMissing}
              onClick={() => setSel(MISSING_ID)}
              className="[&_svg]:text-destructive/70"
            />
          )}
          <div className="mx-2 my-2 h-px shrink-0 bg-sidebar-border" aria-hidden="true" />
          <div className={cn(EYEBROW, "px-2 pb-1.5")}>{c.groupBy}</div>
          <div role="radiogroup" aria-label={c.groupBy} className="flex flex-col gap-0.5">
            {modes.map((m) => {
              const on = m.key === mode;
              return (
                <button
                  key={m.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setProtoState({ group: m.key })}
                  className={cn(
                    RAIL,
                    "pl-2.5",
                    on
                      ? "font-medium text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/80",
                  )}
                >
                  <span className="grid size-4 shrink-0 place-items-center" aria-hidden="true">
                    <span
                      className={cn(
                        "size-1.5 rounded-full transition-colors",
                        on ? "bg-sidebar-primary" : "ring-1 ring-muted-foreground/50",
                      )}
                    />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{m.label}</span>
                </button>
              );
            })}
          </div>
          {mode === "manual" && (
            <RailItem
              icon={Add01Icon}
              label={c.newGroup}
              onClick={() => createManualGroup(window.prompt(c.newGroupPrompt) ?? "")}
            />
          )}
          <p className="px-2 pt-2 text-[11px] leading-4 text-muted-foreground/70">
            {modeHint(c, mode)}
          </p>
        </Rail>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[880px] px-8 pt-4 pb-24">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pb-3 font-mono text-[11px] leading-4 text-muted-foreground/80">
              <span>{t("global.desc")}</span>
              <span className="shrink-0 tabular-nums">
                {c.fill("stateVars", { n: rows.length, g: groups.length })}
              </span>
            </div>

            {onMissing ? (
              <>
                <PaneHead
                  eyebrow={c.variables}
                  name={c.missingDefs}
                  hint={c.missingDefsHint}
                  count={missing.length}
                />
                <MissingDefs missing={missing} onDefine={addRow} className="pt-3" bare />
              </>
            ) : group ? (
              <>
                <PaneHead
                  eyebrow={c.variables}
                  name={group.name}
                  hint={group.hint}
                  count={group.rows.length}
                />
                <div className="divide-y divide-border">
                  {group.rows.map(({ row, index }) => (
                    <VarItem
                      key={index}
                      index={index}
                      row={row}
                      editing={editing === index}
                      onEdit={() => setEditing(index)}
                      onDone={() => setEditing(null)}
                    />
                  ))}
                  {group.rows.length === 0 && (
                    <p className="py-3 text-xs text-muted-foreground/60">{c.emptyGroup}</p>
                  )}
                </div>
                {group.kind === "manual" && (
                  <div className="pt-4">
                    <TextButton tone="danger" onClick={() => removeManualGroup(group.name)}>
                      {c.removeGroup}
                    </TextButton>
                  </div>
                )}
              </>
            ) : null}

            {dupKeys.size > 0 && (
              <p className="pt-3 font-mono text-[11px] text-destructive">{t("global.dupHint")}</p>
            )}
            {mode === "manual" && (
              <p className="pt-1 font-mono text-[11px] text-muted-foreground/60">
                {c.manualEphemeral}
              </p>
            )}
          </div>
        </div>
      </div>
    </PageFrame>
  );
}

// ─── 指令片段 ───────────────────────────────────────────────────────────────

// 导览项「未分类」的哨兵：片段没有 tag 时在左栏也占一项（与 A / B 的「未分类」组对齐）
const UNTAGGED = "__untagged__";
const primaryTag = (tags?: string[]) => tags?.[0] ?? UNTAGGED;

/** 「全部片段」视图里的小节头：眉标 + ·计数 + 细线（不吸顶——吸顶是变体 B 的语法）。 */
function SubHead({ name, count }: { name: string; count: number }) {
  return (
    <div className="flex h-9 items-center gap-1 border-b border-border">
      <span className={EYEBROW}>{name}</span>
      <span className="font-mono text-[11px] text-muted-foreground/50 tabular-nums">·{count}</span>
    </div>
  );
}

/** 片段定义块：标题 + tag 文字 + 行数 / 完整命令 / 缺失变量 / 文字动作。 */
function FragBlock({ ft, i }: { ft: ReturnType<typeof useFragTools>; i: number }) {
  const { t } = useTranslation();
  const c = useCopy();
  const f = ft.fragments[i];
  if (!f) return null;
  const tags = f.tags ?? [];
  const copied = ft.copiedIdx === i;
  const armed = ft.pendingDelete === i;

  return (
    <article className="py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-[13px] leading-[18px] font-medium text-foreground">
          {f.title || t("fragments.untitled")}
        </span>
        {tags.length > 0 && (
          <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground/70 sm:inline">
            {tags.join(" · ")}
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground/60 tabular-nums">
          {c.fill("lines", { n: f.content.split("\n").length })}
        </span>
      </div>
      {/* 完整命令，不截断；点一下即全选 */}
      <pre className="mt-1 font-mono text-xs leading-5 break-all whitespace-pre-wrap text-foreground/85 select-all">
        <CommandText
          content={f.content}
          vars={ft.globalConfig}
          overrides={ft.overrides[i]}
          fragIndex={i}
          onSetVar={(name, value) => ft.setVarOverride(i, name, value)}
        />
      </pre>
      <MissingNote missing={ft.missingOf(i)} />
      <div className="mt-1 flex items-center gap-1">
        <TextButton
          tone={copied ? "success" : undefined}
          onClick={() => void ft.copyOne(i)}
        >
          {copied ? t("fragments.copied") : t("fragments.copy")}
        </TextButton>
        <TextButton onClick={() => ft.setEditing(i)}>{t("fragments.edit")}</TextButton>
        <TextButton
          tone={armed ? "confirm" : "danger"}
          onClick={() => ft.clickDelete(i)}
        >
          {armed ? t("fragments.confirmDelete") : t("fragments.remove")}
        </TextButton>
      </div>
    </article>
  );
}

function FragmentsC({ inSheet }: { inSheet: boolean }) {
  const { t } = useTranslation();
  const c = useCopy();
  const ft = useFragTools();
  // 导览栏选中项是 C 自己的状态（不写 ft.activeTag）：null = 全部；UNTAGGED = 没有 tag 的片段
  const [sel, setSel] = useState<string | null>(null);
  const hasUntagged = ft.fragments.some((f) => !f.tags?.length);

  // 各 tag 在当前搜索下的命中数：搜索词变了，左栏计数跟着变（0 的置灰）
  const hits = useMemo(() => {
    const m = new Map<string, number>();
    let untagged = 0;
    ft.filtered.forEach(({ f }) => {
      if (f.tags?.length) f.tags.forEach((tag) => m.set(tag, (m.get(tag) ?? 0) + 1));
      else untagged += 1;
    });
    return { m, untagged };
  }, [ft.filtered]);

  // 当前导览项下的片段：搜索照常生效
  const list = useMemo<FragHit[]>(() => {
    if (sel === null) {
      // 「全部」按首个 tag 归拢（同 tag 相邻才好插小节头），组内保持原顺序
      return [...ft.filtered].sort((a, b) =>
        primaryTag(a.f.tags).localeCompare(primaryTag(b.f.tags)),
      );
    }
    if (sel === UNTAGGED) return ft.filtered.filter(({ f }) => !f.tags?.length);
    return ft.filtered.filter(({ f }) => f.tags?.includes(sel));
  }, [ft.filtered, sel]);
  // 「全部」视图的小节：tag → 片段下标（Map 保持首次出现顺序，即已排好的 tag 序）
  const runs = useMemo(
    () => groupFrags(list, null, t("fragments.uncategorized")),
    [list, t],
  );
  const selName =
    sel === null ? c.allFrags : sel === UNTAGGED ? t("fragments.uncategorized") : sel;

  const search = (
    <SearchBox
      value={ft.q}
      onChange={ft.setQ}
      placeholder={t("fragments.searchPlaceholder")}
      className={inSheet ? "min-w-0 flex-1" : "w-72"}
    />
  );
  const add = (
    <IconButton
      icon={Add01Icon}
      label={t("fragments.add")}
      variant="outline"
      onClick={() => ft.setEditing(-1)}
    />
  );

  return (
    <PageFrame
      inSheet={inSheet}
      title={t("fragments.title")}
      tools={
        inSheet ? undefined : (
          <div className="flex items-center gap-2">
            {search}
            {add}
            <span className="ml-2 font-mono text-[11px] text-muted-foreground/70 tabular-nums">
              {c.fill("stateFrags", { n: ft.fragments.length, g: ft.tagCounts.length })}
            </span>
          </div>
        )
      }
    >
      {inSheet && (
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          {search}
          {add}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <Rail label={c.tags} narrow={inSheet}>
          <div className={cn(EYEBROW, "px-2 pb-1.5")}>{c.tags}</div>
          <RailItem
            icon={TagsIcon}
            label={c.allFrags}
            count={ft.filtered.length}
            active={sel === null}
            onClick={() => setSel(null)}
          />
          {ft.tagCounts.map(([tag]) => {
            const n = hits.m.get(tag) ?? 0;
            return (
              <RailItem
                key={tag}
                icon={tagIcon(tag)}
                label={tag}
                count={n}
                active={sel === tag}
                onClick={() => setSel(tag)}
                className={n === 0 ? "opacity-50" : undefined}
              />
            );
          })}
          {hasUntagged && (
            <RailItem
              icon={TagsIcon}
              label={t("fragments.uncategorized")}
              count={hits.untagged}
              active={sel === UNTAGGED}
              onClick={() => setSel(UNTAGGED)}
              className={hits.untagged === 0 ? "opacity-50" : undefined}
            />
          )}
          <p className="px-2 pt-2 text-[11px] leading-4 text-muted-foreground/70">{c.tagsHint}</p>
        </Rail>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className={cn("mx-auto w-full", inSheet ? "px-4 pt-3 pb-12" : "max-w-[880px] px-8 pt-4 pb-24")}>
            {ft.fragments.length === 0 ? (
              <p className="py-10 text-center text-xs text-muted-foreground">{t("fragments.empty")}</p>
            ) : list.length === 0 ? (
              <>
                <PaneHead eyebrow={c.tags} name={selName} count={0} />
                <p className="py-10 text-center text-xs text-muted-foreground">
                  {t("fragments.noResults")}
                </p>
              </>
            ) : sel === null ? (
              <>
                <PaneHead
                  eyebrow={c.tags}
                  name={selName}
                  hint={c.byFirstTag}
                  count={list.length}
                />
                <div className="divide-y divide-border">
                  {[...runs.entries()].map(([tag, idxs]) => (
                    <section key={tag}>
                      <SubHead
                        name={tag === UNTAGGED ? t("fragments.uncategorized") : tag}
                        count={idxs.length}
                      />
                      <div className="divide-y divide-border/60">
                        {idxs.map((i) => (
                          <FragBlock key={i} ft={ft} i={i} />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </>
            ) : (
              <>
                <PaneHead eyebrow={c.tags} name={selName} count={list.length} />
                <div className="divide-y divide-border">
                  {list.map(({ i }) => (
                    <FragBlock key={i} ft={ft} i={i} />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <FragmentDialogHost
        editing={ft.editing}
        fragments={ft.fragments}
        allTags={ft.allTags}
        globalConfig={ft.globalConfig}
        onSave={ft.saveOne}
        onClose={() => ft.setEditing(null)}
      />
    </PageFrame>
  );
}
