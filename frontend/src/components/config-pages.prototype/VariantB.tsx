// PROTOTYPE（一次性）变体 B「索引账本」。
// 纯文字的密排索引，零分组色：分组 = 吸顶的等宽眉标 + 细线 + ·计数；条目 = 28px 单行三栏
//（键 / 值 / 引用数逐栏对齐），点行原地展开成编辑器（左侧 2px 竖线标出展开范围，Enter/Esc 收起）。
// 整页只有前景 / 次要前景两档灰；颜色仍只出现在 ${VAR} token、重复（红）、已复制（绿）。
// 它要回答的问题是：分组一定需要「面」（色块 / 底色 / 分区间隔）吗？只用眉标 + 细线能不能读出层级。
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, ArrowDown01Icon } from "@hugeicons/core-free-icons";
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
  ModeTabs,
  PageFrame,
  SearchBox,
  TagTabs,
  TextButton,
} from "./parts";
import { BARE_INPUT, EYEBROW } from "./styles";
import { fragTabs, groupFrags, useFragTools } from "./frag-tools";
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
  type VarGroup,
  type VarRow,
} from "./var-state";
import type { VariantProps } from "./url-state";
import { useCopy } from "./copy";
import { requestReturnFocus, useCollapsed, useReturnFocus } from "./row-state";

export default function VariantB({ page, inSheet }: VariantProps) {
  return page === "global" ? <GlobalB /> : <FragmentsB inSheet={inSheet} />;
}

/** 单行账本行：悬停 / 键盘聚焦时左缘亮 2px 竖线——不给底色也能看出「这一行」。 */
const LEDGER_ROW =
  "grid h-7 cursor-pointer items-center gap-3 rounded-sm border-l-2 border-transparent px-2 outline-none select-none transition-colors hover:border-l-border hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring/50";
const META = "font-mono text-[11px] tabular-nums";
const META_DIM = "text-muted-foreground/50";

/** 吸顶分组头：眉标 +（兜底组才有）规则说明 + ·计数 + 折叠箭头；底下一条细线。 */
function LedgerHead({
  name,
  hint,
  count,
  collapsed,
  onToggle,
  action,
}: {
  name: string;
  hint?: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  action?: ReactNode;
}) {
  return (
    // group/head 放在外层：悬停整条分组头（含右侧「删除分组」自身）都要能显示出附加动作
    <div className="group/head sticky top-0 z-10 flex h-9 items-center gap-1 border-b bg-background px-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
      >
        <span className={cn(EYEBROW, "shrink-0 transition-colors group-hover/head:text-foreground")}>
          {name}
        </span>
        {hint && (
          <span className="hidden min-w-0 truncate text-[11px] text-muted-foreground/70 sm:inline">
            {hint}
          </span>
        )}
        <span className={cn("shrink-0", META, META_DIM)}>·{count}</span>
      </button>
      {action}
      <HugeiconsIcon
        icon={ArrowDown01Icon}
        strokeWidth={2}
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground/50 transition-transform",
          collapsed && "-rotate-90",
        )}
      />
    </div>
  );
}

// ─── 全局配置 ───────────────────────────────────────────────────────────────

function VarLedgerRow({
  index,
  row,
  open,
  onToggle,
}: {
  index: number;
  row: VarRow;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { rows, dupKeys, varRefCounts, mode, c, update, remove } = useVarGroups();
  const mg = useManualGroups();
  const meta = useRefMeta();
  // 折叠态那一行的 ref：键盘收起编辑器后把焦点还回去
  const back = useReturnFocus();
  const key = row.key.trim();
  const dup = key !== "" && dupKeys.has(key);
  const ref = key ? (varRefCounts[key] ?? 0) : 0;
  const { from, by } = relations(row, rows);
  const metaCls = cn(META, dup ? "text-destructive" : ref > 0 ? "text-muted-foreground" : META_DIM);

  if (open) {
    const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        requestReturnFocus(back);
        onToggle();
      }
    };
    return (
      <div
        tabIndex={-1}
        autoFocus
        onKeyDown={(e) => {
          // 只处理焦点落在容器自身时的按键：输入框 / 下拉自己处理，不在这里抢
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            onToggle();
          }
        }}
        className="my-1 ml-1 border-l-2 border-border py-1.5 pl-3 outline-none"
      >
        <div className="grid grid-cols-[21ch_minmax(0,1fr)] items-center gap-2">
          {/* 新加的行（键为空）直接落到键输入框；已有行只把焦点交给编辑器容器，
              免得一点开就选中键名、随手一个退格把键改掉 */}
          <Input
            autoFocus={row.key === ""}
            aria-label={t("global.keyPlaceholder")}
            value={row.key}
            onChange={(e) => update(index, "key", e.target.value)}
            placeholder={t("global.keyPlaceholder")}
            onKeyDown={onInputKey}
            className={cn(
              BARE_INPUT,
              "h-8 rounded-md bg-muted/50 font-semibold uppercase tracking-wide",
              dup && "text-destructive",
            )}
          />
          <Input
            aria-label={t("global.valuePlaceholder")}
            value={row.value}
            onChange={(e) => update(index, "value", e.target.value)}
            placeholder={t("global.valuePlaceholder")}
            onKeyDown={onInputKey}
            className={cn(BARE_INPUT, "h-8 rounded-md bg-muted/50")}
          />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-4 text-muted-foreground">
          <span className="font-mono">
            {dup ? t("global.dup") : ref > 0 ? c.fill("refsAt", { n: ref }) : c.noRefs}
          </span>
          {from.length > 0 && (
            <span className="font-mono">
              <span className="opacity-60">{c.derivedFrom}</span> {from.join(" ")}
            </span>
          )}
          {by.length > 0 && (
            <span className="font-mono">
              <span className="opacity-60">{c.usedBy}</span> {by.join(" ")}
            </span>
          )}
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
                onToggle();
              }}
            >
              {t("global.remove")}
            </TextButton>
            <TextButton onClick={onToggle}>{c.done}</TextButton>
          </span>
        </div>
      </div>
    );
  }

  const kv = toKV(rows);
  return (
    <div
      ref={back}
      role="button"
      tabIndex={0}
      aria-expanded={false}
      title={c.expandHint}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      className={cn(LEDGER_ROW, "grid-cols-[21ch_minmax(0,1fr)_auto]")}
    >
      <span
        className={cn(
          "truncate font-mono text-xs font-semibold uppercase tracking-wide",
          dup ? "text-destructive" : "text-foreground",
        )}
      >
        {key || (
          <span className="font-normal tracking-normal text-muted-foreground/40">
            {t("global.keyPlaceholder")}
          </span>
        )}
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground">
        {row.value ? (
          <CommandText content={row.value} vars={kv} interactive={false} />
        ) : (
          <span className="text-muted-foreground/40">{t("global.valuePlaceholder")}</span>
        )}
      </span>
      <span className={cn("w-9 text-right", metaCls)}>{meta(ref, dup)}</span>
    </div>
  );
}

function GlobalB() {
  const { t } = useTranslation();
  const {
    rows,
    dirty,
    dupKeys,
    groups,
    mode,
    c,
    missing,
    varRefCounts,
    add,
    save,
  } = useVarGroups();
  const mg = useManualGroups();
  const { collapsed, toggle, expand } = useCollapsed();
  const [q, setQ] = useState("");
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const query = q.trim().toLowerCase();

  // 搜索只筛行、不拆组：命中的组照常列出，空的组不显示
  const visible = groups
    .map((g) => ({
      ...g,
      rows: query
        ? g.rows.filter(({ row }) => `${row.key} ${row.value}`.toLowerCase().includes(query))
        : g.rows,
    }))
    .filter((g) => g.rows.length > 0);

  const addRow = (key = "") => {
    const idx = add(key);
    const target = groupVars(
      [...rows, { key, value: "" }],
      mode,
      varRefCounts,
      mg,
      c,
    ).find((g) => g.rows.some((r) => r.index === idx));
    if (target) expand(target.id);
    setOpenIdx(idx);
  };

  const headAction = (g: VarGroup) =>
    g.kind === "manual" ? (
      <TextButton
        tone="danger"
        className="opacity-0 group-hover/head:opacity-100 focus-visible:opacity-100"
        onClick={() => removeManualGroup(g.name)}
      >
        {c.removeGroup}
      </TextButton>
    ) : undefined;

  return (
    <PageFrame
      inSheet={false}
      title={t("global.title")}
      tools={
        <div className="flex items-center gap-3">
          <SearchBox
            value={q}
            onChange={setQ}
            placeholder={c.filterVars}
            className="w-56"
          />
          <ModeTabs value={mode} />
          {mode === "manual" && (
            <TextButton onClick={() => createManualGroup(window.prompt(c.newGroupPrompt) ?? "")}>
              {c.newGroup}
            </TextButton>
          )}
          <AddSave dirty={dirty} onAdd={() => addRow()} onSave={save} />
        </div>
      }
    >
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[880px] flex-col px-6 pt-3 pb-24">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pb-2 font-mono text-[11px] leading-4 text-muted-foreground/80">
            <span>
              {t("global.desc")}
              <span className="mx-1.5 opacity-50" aria-hidden="true">
                ·
              </span>
              {modeHint(c, mode)}
              <span className="mx-1.5 opacity-50" aria-hidden="true">
                ·
              </span>
              <span className="opacity-70">{c.expandHint}</span>
            </span>
            <span className="shrink-0 tabular-nums">
              {c.fill("stateVars", { n: rows.length, g: groups.length })}
            </span>
          </div>

          {visible.map((g) => (
            <section key={g.id} className="pt-1">
              <LedgerHead
                name={g.name}
                hint={
                  g.kind === "used" ||
                  g.kind === "unused" ||
                  g.kind === "other" ||
                  g.kind === "ungrouped"
                    ? g.hint
                    : undefined
                }
                count={g.rows.length}
                collapsed={collapsed.has(g.id)}
                onToggle={() => toggle(g.id)}
                action={headAction(g)}
              />
              {!collapsed.has(g.id) && (
                <div className="flex flex-col py-1">
                  {g.rows.map(({ row, index }) => (
                    <VarLedgerRow
                      key={index}
                      index={index}
                      row={row}
                      open={openIdx === index}
                      onToggle={() => setOpenIdx((cur) => (cur === index ? null : index))}
                    />
                  ))}
                </div>
              )}
            </section>
          ))}

          <MissingDefs
            missing={missing}
            onDefine={addRow}
            className="mt-3 border-t border-border pt-3"
          />
          {dupKeys.size > 0 && (
            <p className="mt-3 font-mono text-[11px] text-destructive">{t("global.dupHint")}</p>
          )}
          {mode === "manual" && (
            <p className="mt-2 font-mono text-[11px] text-muted-foreground/60">
              {c.manualEphemeral}
            </p>
          )}
        </div>
      </div>
    </PageFrame>
  );
}

// ─── 指令片段 ───────────────────────────────────────────────────────────────

function FragLedgerRow({
  ft,
  i,
  open,
  onToggle,
}: {
  ft: ReturnType<typeof useFragTools>;
  i: number;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const c = useCopy();
  const back = useReturnFocus();
  const f = ft.fragments[i];
  if (!f) return null;
  const tags = f.tags ?? [];
  const copied = ft.copiedIdx === i;
  const armed = ft.pendingDelete === i;
  const title = f.title || t("fragments.untitled");

  if (open) {
    return (
      <div
        tabIndex={-1}
        autoFocus
        onKeyDown={(e) => {
          // 只处理焦点落在容器自身时的按键（可点的 ${VAR} token 有自己的 Esc 语义）
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            requestReturnFocus(back);
            onToggle();
          }
        }}
        className="mb-1.5 ml-1 border-l-2 border-border py-1.5 pl-3 outline-none"
      >
        <div className="flex items-center gap-2 font-mono text-[11px] leading-4 text-muted-foreground/80">
          <span className="truncate text-xs font-medium text-foreground">{title}</span>
          {tags.map((tag) => (
            <span key={tag} className={cn(tag === ft.activeTag && "text-foreground")}>
              {tag}
            </span>
          ))}
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{c.fill("lines", { n: f.content.split("\n").length })}</span>
        </div>
        <pre className="mt-1 font-mono text-xs leading-6 break-all whitespace-pre-wrap text-foreground/90 select-all">
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
      </div>
    );
  }

  return (
    <div
      ref={back}
      role="button"
      tabIndex={0}
      aria-expanded={false}
      title={c.expandFragHint}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      className={cn(LEDGER_ROW, "grid-cols-[minmax(0,22ch)_minmax(0,1fr)_auto]")}
    >
      <span className="truncate text-xs font-medium text-foreground">{title}</span>
      <span className="truncate font-mono text-xs text-muted-foreground">
        <CommandText
          content={f.content}
          vars={ft.globalConfig}
          overrides={ft.overrides[i]}
          interactive={false}
        />
      </span>
      {/* 选了 tag 时整组同 tag，第三栏不再重复 */}
      {ft.activeTag ? (
        <span className="w-9" />
      ) : (
        <span className={cn("max-w-[14ch] truncate", META, META_DIM)}>
          {tags[0] ?? t("fragments.uncategorized")}
        </span>
      )}
    </div>
  );
}

function FragmentsB({ inSheet }: { inSheet: boolean }) {
  const { t } = useTranslation();
  const c = useCopy();
  const ft = useFragTools();
  const { collapsed, toggle } = useCollapsed();
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const groups = useMemo(
    () => groupFrags(ft.filtered, ft.activeTag, t("fragments.uncategorized")),
    [ft.filtered, ft.activeTag, t],
  );
  const tabs = useMemo(
    () => fragTabs(ft.fragments, ft.tagCounts, t("fragments.all")),
    [ft.fragments, ft.tagCounts, t],
  );
  const entries = [...groups.entries()];

  const search = (
    <SearchBox
      value={ft.q}
      onChange={ft.setQ}
      placeholder={t("fragments.searchPlaceholder")}
      className={inSheet ? "min-w-0 flex-1" : "w-64"}
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
      {tabs.length > 1 && (
        <div className="shrink-0 border-b px-4">
          <TagTabs tabs={tabs} value={ft.activeTag} onChange={ft.setActiveTag} className="-mb-px" />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <div
          className={cn(
            "mx-auto flex w-full flex-col",
            inSheet ? "px-4 pt-2 pb-8" : "max-w-[880px] px-6 pt-2 pb-24",
          )}
        >
          {ft.fragments.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">
              {t("fragments.empty")}
            </p>
          ) : entries.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">
              {t("fragments.noResults")}
            </p>
          ) : (
            entries.map(([tag, idxs], gi) => (
              <section key={tag} className={cn(gi > 0 && "pt-2")}>
                <LedgerHead
                  name={tag}
                  count={idxs.length}
                  collapsed={collapsed.has(tag)}
                  onToggle={() => toggle(tag)}
                />
                {!collapsed.has(tag) && (
                  <div className="flex flex-col py-1">
                    {idxs.map((i) => (
                      <FragLedgerRow
                        key={i}
                        ft={ft}
                        i={i}
                        open={openIdx === i}
                        onToggle={() => setOpenIdx((cur) => (cur === i ? null : i))}
                      />
                    ))}
                  </div>
                )}
              </section>
            ))
          )}
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
