// PROTOTYPE（一次性）变体 A「分区镜像」——定稿方向。
// 把侧栏「板块」的语法原样搬进主区：顶沿细线分区 + 两行分组头（20px mini-hub 色块 / 13px 半粗组名 /
// 副行 / ·计数 / ›）+ 同色浅染条目卡，正在交互的分区整段提亮（data-lit，同侧栏「当前组」）。
// 颜色只落在三处：分组头色块、条目 8% 底色（hover 15% + 板块色内描边）、行首 14px 小图标；
// 文字一律前景色 / 次要前景色——组名、键、值、计数都不带色。
// 结构复用 index.css 里现成的 .side-sec / .side-head / .side-hub-mini / .side-sub / .side-count / .side-chev；
// 条目卡那几条（.side-sec [data-sidebar=menu-button]）只认侧栏条目，这里用 TINT_CARD 自己上色。
// 分区色（全局配置）：手动组 = 它自己的卡片颜色（建组时从五色色卡选，之后在分组头改，见 group-ui.tsx），「未分组」中性灰；
// 分区色（指令片段）：分组固定琥珀，颜色下放给条目——每条片段新增 / 编辑时从同一支五色色卡自选
// （见 frag-dialog.tsx），没选过的跟随分组。选了色的卡片用 .frag-card[data-amb] 在自己身上重定义 --amb / --tintc，
// 标题 / 命令文字照旧是前景色。
// 色卡新增的 amber / cyan / none 三档与 .frag-card 那几条由 ensureProtoStyles() 注入，正式 index.css 不动。
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Alert02Icon,
  CheckmarkCircle02Icon,
  Copy02Icon,
  Delete02Icon,
  Edit02Icon,
  Link01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IconButton } from "../IconButton";
import { cn } from "@/lib/utils";
import {
  AddSave,
  CommandText,
  GroupMoveSelect,
  MissingDefs,
  MissingNote,
  PageFrame,
  SearchBox,
  SegmentedTabs,
} from "./parts";
import { GroupColorPicker, GroupDialog } from "./group-ui";
import { SectionHead } from "./section";
import { BARE_INPUT, HEAD_ACTION, TINT_CARD } from "./styles";
import { fragTabs, groupFrags, tagIcon, useFragTools } from "./frag-tools";
import {
  ambOfGroup,
  assignManual,
  groupSub,
  groupVars,
  modeHint,
  relations,
  removeManualGroup,
  useManualGroups,
  useRefMeta,
  useVarGroups,
  varGroupIcon,
  type VarRow,
} from "./var-state";
import type { VariantProps } from "./url-state";
import { useCopy } from "./copy";
import { FragColorDialogHost } from "./frag-dialog";
import { useCollapsed, useLit } from "./row-state";

// 条目聚焦时整卡再深一档（与 hover 同浓度）
const TINT_FOCUS = "focus-within:bg-[color-mix(in_oklab,var(--tintc)_15%,transparent)]";
// 手动模式下，行内的「移入分组」/ 删除只在悬停或键盘聚焦到本行时出现
const HOVER_ONLY =
  "invisible group-hover/row:visible group-focus-within/row:visible";

export default function VariantA({ page, inSheet }: VariantProps) {
  return page === "global" ? <GlobalA /> : <FragmentsA inSheet={inSheet} />;
}

// 两行分组头在 section.tsx（新建分组对话框的预览也要画它）。

// ─── 全局配置 ───────────────────────────────────────────────────────────────

function VarCard({ index, row }: { index: number; row: VarRow }) {
  const { t } = useTranslation();
  const { rows, dupKeys, varRefCounts, mode, c, fresh, update, remove } = useVarGroups();
  const mg = useManualGroups();
  const meta = useRefMeta();
  const key = row.key.trim();
  const dup = key !== "" && dupKeys.has(key);
  const ref = key ? (varRefCounts[key] ?? 0) : 0;
  const { from, by } = relations(row, rows);

  return (
    <div
      className={cn(
        "group/row @container rounded-md px-2",
        TINT_CARD,
        TINT_FOCUS,
      )}
    >
      <div className="flex min-h-8 items-center gap-2">
        {/* 引用状态的小图标：吃板块墨色 --ink；无引用时同一字形淡到 35%，重复键转红 */}
        <HugeiconsIcon
          icon={dup ? Alert02Icon : Link01Icon}
          strokeWidth={1.75}
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0",
            dup ? "text-destructive" : "text-[color:var(--ink)]",
            !dup && ref === 0 && "opacity-35",
          )}
        />
        <Input
          aria-label={t("global.keyPlaceholder")}
          value={row.key}
          onChange={(e) => update(index, "key", e.target.value)}
          placeholder={t("global.keyPlaceholder")}
          autoFocus={fresh === index}
          className={cn(
            BARE_INPUT,
            "w-[21ch] flex-none font-semibold uppercase tracking-wide",
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
          className={cn(BARE_INPUT, "min-w-0 flex-1")}
        />
        <span
          className={cn(
            "w-9 shrink-0 text-right font-mono text-[11px] tabular-nums",
            dup ? "text-destructive" : ref > 0 ? "text-muted-foreground" : "text-muted-foreground/50",
          )}
        >
          {meta(ref, dup)}
        </span>
        {mode === "manual" && (
          <GroupMoveSelect
            value={mg.assign[key] ?? null}
            groups={mg.order}
            onSelect={(g) => assignManual(key, g)}
            label={c.moveToGroup}
            ungroupedLabel={c.ungrouped}
            className={HOVER_ONLY}
          />
        )}
        <IconButton
          icon={Delete02Icon}
          label={t("global.remove")}
          className={cn("text-muted-foreground/60 hover:text-destructive", HOVER_ONLY)}
          onClick={() => remove(index)}
        />
      </div>
      {/* 关系线（容器 ≥ 36rem 才显示）：值里引用了谁、谁又引用了它 */}
      {(from.length > 0 || by.length > 0) && (
        <div className="hidden gap-x-4 gap-y-0.5 pb-1.5 pl-[22px] font-mono text-[11px] leading-4 text-muted-foreground/80 @xl:flex">
          {from.length > 0 && (
            <span>
              <span className="opacity-60">{c.derivedFrom}</span> {from.join(" ")}
            </span>
          )}
          {by.length > 0 && (
            <span>
              <span className="opacity-60">{c.usedBy}</span> {by.join(" ")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function GlobalA() {
  const { t } = useTranslation();
  const { rows, dirty, dupKeys, groups, mode, c, missing, varRefCounts, add, save } =
    useVarGroups();
  const mg = useManualGroups();
  const { collapsed, toggle, expand } = useCollapsed();
  const { lit, onFocusCapture, onBlurCapture } = useLit();
  const [groupDialog, setGroupDialog] = useState(false);

  // 新增（或补定义）一行：保证它所在的组是展开的；焦点由 fresh 行上的 autoFocus 接管
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
  };

  return (
    <PageFrame
      inSheet={false}
      title={t("global.title")}
      tools={
        <div className="flex items-center gap-1.5">
          {mode === "manual" && (
            <Button variant="outline" size="sm" onClick={() => setGroupDialog(true)}>
              <HugeiconsIcon icon={Add01Icon} />
              {c.newGroup}
            </Button>
          )}
          <AddSave dirty={dirty} onAdd={() => addRow()} onSave={save} />
        </div>
      }
    >
      <div
        className="min-h-0 flex-1 overflow-auto"
        onFocusCapture={onFocusCapture}
        onBlurCapture={onBlurCapture}
      >
        <div className="mx-auto flex w-full max-w-[920px] flex-col gap-3 px-6 pt-4 pb-24">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="font-mono text-[11px] leading-4 text-muted-foreground/80">
              {t("global.desc")}
              <span className="mx-1.5 opacity-50" aria-hidden="true">
                ·
              </span>
              {modeHint(c, mode)}
            </p>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/80">
              {c.fill("stateVars", { n: rows.length, g: groups.length })}
            </span>
          </div>

          {groups.map((g, gi) => {
            const isCollapsed = collapsed.has(g.id);
            return (
              <section
                key={g.id}
                data-sec={g.id}
                data-amb={ambOfGroup(g, gi)}
                data-lit={lit === g.id ? "" : undefined}
                className="side-sec rounded-lg border-t border-sidebar-border px-2 pt-2 pb-3"
              >
                <SectionHead
                  icon={varGroupIcon(g.kind)}
                  name={g.name}
                  sub={groupSub(g)}
                  count={g.rows.length}
                  collapsed={isCollapsed}
                  onToggle={() => toggle(g.id)}
                  action={
                    g.kind === "manual" ? (
                      <>
                        <GroupColorPicker name={g.name} secId={g.id} />
                        <IconButton
                          icon={Delete02Icon}
                          label={c.removeGroup}
                          className={cn(
                            "text-muted-foreground/60 hover:text-destructive",
                            HEAD_ACTION,
                          )}
                          onClick={() => removeManualGroup(g.name)}
                        />
                      </>
                    ) : undefined
                  }
                />
                {!isCollapsed && (
                  <div className="flex flex-col gap-1">
                    {g.rows.map(({ row, index }) => (
                      <VarCard key={index} index={index} row={row} />
                    ))}
                    {g.rows.length === 0 && (
                      <p className="px-2 py-1 text-xs text-muted-foreground/60">{c.emptyGroup}</p>
                    )}
                  </div>
                )}
              </section>
            );
          })}

          <MissingDefs
            missing={missing}
            onDefine={addRow}
            className="rounded-lg border border-dashed border-border px-3 py-2"
          />
          {dupKeys.size > 0 && (
            <p className="font-mono text-[11px] text-destructive">{t("global.dupHint")}</p>
          )}
          {mode === "manual" && (
            <p className="font-mono text-[11px] text-muted-foreground/60">{c.manualEphemeral}</p>
          )}
        </div>
      </div>
      {groupDialog && <GroupDialog onClose={() => setGroupDialog(false)} />}
    </PageFrame>
  );
}

// ─── 指令片段 ───────────────────────────────────────────────────────────────

// 片段页分组的固定色：颜色下放给条目（每条自己选），分组头一律琥珀
const GROUP_AMB = "amber";

function FragCard({
  ft,
  i,
  groupTag,
}: {
  ft: ReturnType<typeof useFragTools>;
  i: number;
  groupTag: string;
}) {
  const { t } = useTranslation();
  const c = useCopy();
  const f = ft.fragments[i];
  if (!f) return null;
  const others = (f.tags ?? []).filter((tag) => tag !== groupTag);
  const copied = ft.copiedIdx === i;
  const armed = ft.pendingDelete === i;
  // 这条自己的卡片颜色；null = 没选过，不设 data-amb，底色继承所在分组的琥珀
  const color = ft.colors[i] ?? null;

  return (
    <article
      data-amb={color ?? undefined}
      className={cn("frag-card group/row @container rounded-md px-2 py-1.5", TINT_CARD)}
    >
      <div className="flex items-center gap-2">
        {/* 标题即「复制」：这是片段页的主操作，给它最大的点击面 */}
        <button
          type="button"
          onClick={() => void ft.copyOne(i)}
          title={c.clickToCopy}
          className="min-w-0 flex-1 cursor-copy truncate text-left text-[13px] leading-[18px] font-medium text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
        >
          {f.title || t("fragments.untitled")}
        </button>
        {others.length > 0 && (
          <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground/70 @md:inline">
            +{others.join(" +")}
          </span>
        )}
        <div className="flex w-24 shrink-0 items-center justify-end">
          <IconButton
            icon={copied ? CheckmarkCircle02Icon : Copy02Icon}
            label={copied ? t("fragments.copied") : t("fragments.copy")}
            className={cn(
              "text-muted-foreground/70 hover:text-foreground",
              copied && "text-success hover:text-success",
            )}
            onClick={() => void ft.copyOne(i)}
          />
          <IconButton
            icon={Edit02Icon}
            label={t("fragments.edit")}
            className={cn("text-muted-foreground/70 hover:text-foreground", HOVER_ONLY)}
            onClick={() => ft.setEditing(i)}
          />
          <IconButton
            icon={Delete02Icon}
            label={armed ? t("fragments.confirmDelete") : t("fragments.remove")}
            className={cn(
              "hover:text-destructive",
              armed
                ? "bg-destructive/10 text-destructive"
                : cn("text-muted-foreground/70", HOVER_ONLY),
            )}
            onClick={() => ft.clickDelete(i)}
          />
        </div>
      </div>
      {/* 命令预览：两行截断，悬停展开全文（同正式页） */}
      <div className="mt-0.5 font-mono text-xs leading-5 break-all whitespace-pre-wrap text-foreground/85 line-clamp-2 group-hover/row:line-clamp-none">
        <CommandText
          content={f.content}
          vars={ft.globalConfig}
          overrides={ft.overrides[i]}
          fragIndex={i}
          onSetVar={(name, value) => ft.setVarOverride(i, name, value)}
        />
      </div>
      <MissingNote missing={ft.missingOf(i)} />
    </article>
  );
}

function FragmentsA({ inSheet }: { inSheet: boolean }) {
  const { t } = useTranslation();
  const c = useCopy();
  const ft = useFragTools();
  const { collapsed, toggle } = useCollapsed();
  const { lit, onFocusCapture, onBlurCapture } = useLit();
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
        <div className="shrink-0 border-b">
          <div className={cn("py-2", inSheet ? "px-3" : "mx-auto w-full max-w-[920px] px-6")}>
            <SegmentedTabs tabs={tabs} value={ft.activeTag} onChange={ft.setActiveTag} />
          </div>
        </div>
      )}
      <div
        className="min-h-0 flex-1 overflow-auto"
        onFocusCapture={onFocusCapture}
        onBlurCapture={onBlurCapture}
      >
        <div
          className={cn(
            "mx-auto flex w-full flex-col gap-3",
            inSheet ? "px-3 pt-3 pb-8" : "max-w-[920px] px-6 pt-4 pb-24",
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
            entries.map(([tag, idxs]) => {
              const isCollapsed = collapsed.has(tag);
              const titles = idxs.map((i) => ft.fragments[i].title).filter(Boolean);
              const preview = `${titles.slice(0, 3).join(" · ")}${titles.length > 3 ? " …" : ""}`;
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
                    sub={preview}
                    count={idxs.length}
                    collapsed={isCollapsed}
                    onToggle={() => toggle(tag)}
                  />
                  {!isCollapsed && (
                    <div className="flex flex-col gap-1">
                      {idxs.map((i) => (
                        <FragCard key={i} ft={ft} i={i} groupTag={tag} />
                      ))}
                    </div>
                  )}
                </section>
              );
            })
          )}
          {/* 与全局配置页的「手动分组」提示同一口径：颜色是原型会话里的状态，别让人以为已经存盘 */}
          {ft.fragments.length > 0 && (
            <p className="font-mono text-[11px] text-muted-foreground/60">{c.fragColorEphemeral}</p>
          )}
        </div>
      </div>
      <FragColorDialogHost
        editing={ft.editing}
        fragments={ft.fragments}
        colors={ft.colors}
        allTags={ft.allTags}
        globalConfig={ft.globalConfig}
        onSave={ft.saveOne}
        onClose={() => ft.setEditing(null)}
      />
    </PageFrame>
  );
}
