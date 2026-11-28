import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Alert02Icon,
  Delete02Icon,
  Edit02Icon,
  FloppyDiskIcon,
  Folder01Icon,
  InboxUnreadIcon,
  Link01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { IconButton } from "./IconButton";
import { GroupColorPicker, GroupDialog } from "./config-pages/group-dialog";
import { SectionHead } from "@/components/config-pages/section-head";
import { HEAD_ACTION, normalizeAmbColor } from "@/lib/amb-colors";
import { removeFromSet, toggleInSet } from "@/lib/sets";
import { useActionRunner } from "../hooks/useActionRunner";
import {
  pickDefaultColor,
  useVariableGroups,
  type GroupWriteCtx,
} from "../hooks/useVariableGroups";
import { useLitSection } from "../hooks/useLitSection";
import { extractVars } from "@/lib/vars";
import { cn } from "@/lib/utils";
import type { VariableGroup } from "../../bindings/workflow-tool/internal/registry/models.js";

// 全局配置页（规格 E）：分区镜像版式——手动分组 + 「未分组」兜底分区。
// 分组状态由页面级 useVariableGroups 写穿管理（即时落盘）；变量仍是草稿 + 显式保存
// （SetGlobalConfig），两套写入互不触发。每行右侧标引用元信息（重复 > N处 > 未用），
// 关系线（派生自 / 引用它的变量）在卡片 ≥ 36rem 才显示；分区列表下方「缺定义」框
// 只看片段内容引用。颜色只落在分区头色块、条目底色与行首图标，文字不变色。

/** 运行时才提供的内置变量：不算「缺定义」（规格 E）。 */
const BUILTIN_VARS = new Set(["CURRENT_DATE", "CURRENT_TIME", "ADB_SERIAL"]);

/** 悬停 / 键盘聚焦到本行才出现的行内动作（透明但仍在 Tab 序里，规格 G）。 */
const ROW_REVEAL =
  "opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100";

/** 融入行的裸输入：聚焦才亮 1px 环。 */
const BARE_INPUT =
  "h-7 border-0 bg-transparent px-1 font-mono text-xs shadow-none focus-visible:ring-1 focus-visible:ring-ring/40";

const UNGROUPED_VALUE = "__ungrouped__";

interface VarRow {
  key: string;
  value: string;
}

export function GlobalConfigEditor() {
  const { t } = useTranslation();
  const { globalConfig, varRefCounts, fragments, saveGlobalConfig } = useActionRunner();
  const { groups, error, create, rename, setColor, move, remove } = useVariableGroups();

  const [rows, setRows] = useState<VarRow[]>(() =>
    Object.entries(globalConfig).map(([key, value]) => ({ key, value })),
  );
  const [dirty, setDirty] = useState(false);
  /** 刚用「新增 / 补定义」加进来的行 + 焦点落点；草稿再有别的改动就清空。 */
  const [fresh, setFresh] = useState<{ index: number; focus: "key" | "value" } | null>(null);
  /** 收起 / 展开只在本次会话的内存里（规格 E）。 */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /** 焦点所在的分区整段提亮（data-lit），样板抽成 useLitSection。 */
  const { lit, onFocusCapture, onBlurCapture } = useLitSection();
  const [dialog, setDialog] = useState<
    { mode: "create" } | { mode: "rename"; group: VariableGroup } | null
  >(null);

  // globalConfig（异步）加载后同步 rows：render-time 调整，未编辑时才同步，避免覆盖用户改动
  const [prevConfig, setPrevConfig] = useState(globalConfig);
  if (globalConfig !== prevConfig) {
    setPrevConfig(globalConfig);
    if (!dirty) {
      setRows(Object.entries(globalConfig).map(([key, value]) => ({ key, value })));
    }
  }

  // 重复键：trim 后同名 key 出现 >1 次
  const dupKeys = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = r.key.trim();
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return new Set(
      [...counts.entries()].filter(([, c]) => c > 1).map(([k]) => k),
    );
  }, [rows]);

  /** 草稿行键（trim 后非空）——分组载荷过滤用（规格 A）。 */
  const pageKeys = useMemo(
    () => new Set(rows.map((r) => r.key.trim()).filter(Boolean)),
    [rows],
  );
  const savedKeys = useMemo(() => new Set(Object.keys(globalConfig)), [globalConfig]);
  const writeCtx = (): GroupWriteCtx => ({ pageKeys, savedKeys });

  // 分组成员归属：键 → 分组名（同键多组时取最前，与后端规整口径一致）
  const memberOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups) {
      for (const k of g.keys ?? []) {
        if (!map.has(k)) map.set(k, g.name);
      }
    }
    return map;
  }, [groups]);

  // 分区 = 分组（按存储顺序）+ 「未分组」；分区内行的顺序跟随草稿（= 配置）顺序
  const sectioned = useMemo(() => {
    const byName = new Map<string, { row: VarRow; index: number }[]>(
      groups.map((g) => [g.name, []]),
    );
    const ungrouped: { row: VarRow; index: number }[] = [];
    rows.forEach((row, index) => {
      const k = row.key.trim();
      const g = k ? memberOf.get(k) : undefined;
      const bucket = g !== undefined ? byName.get(g) : undefined;
      if (bucket) bucket.push({ row, index });
      else ungrouped.push({ row, index });
    });
    return { byName, ungrouped };
  }, [rows, groups, memberOf]);

  /** 缺定义：全部片段内容引用的 ${VAR}，去掉草稿已定义的键与内置变量；按引用片段数降序。 */
  const missing = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of fragments) {
      for (const v of extractVars(f.content ?? "")) {
        if (BUILTIN_VARS.has(v)) continue;
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .filter(([name]) => !pageKeys.has(name))
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [fragments, pageKeys]);

  const update = (i: number, field: "key" | "value", v: string) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: v } : r)));
    setDirty(true);
    setFresh(null);
  };
  const removeRow = (i: number) => {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
    setDirty(true);
    setFresh(null);
  };
  const expand = (id: string) => setCollapsed((prev) => removeFromSet(prev, id));
  /** 追加一行（key 可预填，用于「补定义」）：保证所在分区展开，焦点交给指定输入框。 */
  const addRow = (key = "", focus: "key" | "value" = "key") => {
    const index = rows.length;
    setRows((prev) => [...prev, { key, value: "" }]);
    setDirty(true);
    setFresh({ index, focus });
    const target = key.trim() ? memberOf.get(key.trim()) : undefined;
    expand(target !== undefined ? `m:${target}` : "ungrouped");
  };
  const save = async () => {
    const kv: Record<string, string> = {};
    rows.forEach((r) => {
      if (r.key.trim()) kv[r.key.trim()] = r.value;
    });
    await saveGlobalConfig(kv);
    setDirty(false);
  };

  /** 一行关系线：值里引用了谁（from，只列已定义），谁又引用了它（by）。 */
  const relationsOf = (row: VarRow) => {
    const key = row.key.trim();
    const defined = pageKeys;
    const from = extractVars(row.value).filter((v) => defined.has(v));
    const by: string[] = [];
    for (const r of rows) {
      const k = r.key.trim();
      if (k && k !== key && extractVars(r.value).includes(key)) by.push(k);
    }
    return { from, by };
  };

  const renderRow = (row: VarRow, index: number) => {
    const key = row.key.trim();
    const isDup = key !== "" && dupKeys.has(key);
    const ref = key ? (varRefCounts[key] ?? 0) : 0;
    const { from, by } = relationsOf(row);
    const currentGroup = key ? (memberOf.get(key) ?? null) : null;
    const meta = isDup
      ? t("global.dup")
      : ref > 0
        ? t("global.refCount", { count: ref })
        : t("global.unused");
    return (
      <div key={index} className="group/row @container tint-card rounded-md px-2">
        <div className="flex min-h-8 items-center gap-2">
          {/* 引用状态小图标：吃板块墨色 --ink；无引用淡到 35%，重复键转红 */}
          <HugeiconsIcon
            icon={isDup ? Alert02Icon : Link01Icon}
            strokeWidth={1.75}
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0",
              isDup ? "text-destructive" : "text-[color:var(--ink)]",
              !isDup && ref === 0 && "opacity-35",
            )}
          />
          <Input
            aria-label={t("global.keyPlaceholder")}
            value={row.key}
            onChange={(e) => update(index, "key", e.target.value)}
            placeholder={t("global.keyPlaceholder")}
            autoFocus={fresh?.index === index && fresh.focus === "key"}
            className={cn(
              BARE_INPUT,
              "w-[21ch] flex-none font-semibold tracking-wide uppercase",
              isDup && "text-destructive",
            )}
          />
          <span
            className="shrink-0 font-mono text-xs text-muted-foreground/45"
            aria-hidden="true"
          >
            =
          </span>
          <Input
            aria-label={t("global.valuePlaceholder")}
            value={row.value}
            onChange={(e) => update(index, "value", e.target.value)}
            placeholder={t("global.valuePlaceholder")}
            autoFocus={fresh?.index === index && fresh.focus === "value"}
            className={cn(BARE_INPUT, "min-w-0 flex-1")}
          />
          <span
            className={cn(
              "w-9 shrink-0 text-right font-mono text-[11px] tabular-nums",
              isDup
                ? "text-destructive"
                : ref > 0
                  ? "text-muted-foreground"
                  : "text-muted-foreground/50",
            )}
          >
            {meta}
          </span>
          <GroupMoveSelect
            value={currentGroup}
            groupNames={groups.map((g) => g.name)}
            disabled={key === ""}
            onSelect={(target) => move(key, target, writeCtx())}
          />
          <IconButton
            icon={Delete02Icon}
            label={t("global.remove")}
            className={cn("text-muted-foreground/60 hover:text-destructive", ROW_REVEAL)}
            onClick={() => removeRow(index)}
          />
        </div>
        {/* 关系线（卡片容器 ≥ 36rem 才显示） */}
        {(from.length > 0 || by.length > 0) && (
          <div className="hidden gap-x-4 gap-y-0.5 pb-1.5 pl-[22px] font-mono text-[11px] leading-4 text-muted-foreground/80 @xl:flex">
            {/* 标签与名单同为直下文本节点，保证屏幕阅读器 / getByText 读到同一句 */}
            {from.length > 0 && <span>{t("global.derivedFrom")} {from.join(" ")}</span>}
            {by.length > 0 && <span>{t("global.usedBy")} {by.join(" ")}</span>}
          </div>
        )}
      </div>
    );
  };

  const empty = rows.length === 0 && groups.length === 0;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <span className="font-semibold">{t("global.title")}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={() => setDialog({ mode: "create" })}>
            <HugeiconsIcon icon={Add01Icon} />
            {t("global.newGroup")}
          </Button>
          <IconButton
            icon={Add01Icon}
            label={t("global.add")}
            variant="outline"
            onClick={() => addRow()}
          />
          <IconButton
            icon={FloppyDiskIcon}
            label={t("global.save")}
            variant={dirty ? "default" : "outline"}
            dot={dirty}
            disabled={!dirty}
            onClick={save}
          />
        </div>
      </header>

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
              {t("global.groupHint")}
            </p>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground/80 tabular-nums">
              {t("global.stateVars", { n: rows.length, g: groups.length })}
            </span>
          </div>

          {error && (
            <p role="alert" className="font-mono text-[11px] text-destructive">
              {error}
            </p>
          )}

          {empty ? (
            <Empty>
              <EmptyDescription>{t("global.empty")}</EmptyDescription>
              <code className="font-mono text-[11px] text-muted-foreground/50">
                # {t("global.example")}
              </code>
            </Empty>
          ) : (
            <>
              {groups.map((g) => {
                // 分区键（data-sec）命名空间：手动分组带 m: 前缀，与「未分组」的
                // 裸键 "ungrouped" 隔开——分组名可能与它撞名，前缀保证键永不冲突
                const id = `m:${g.name}`;
                // 未设置 / 越界按蓝色显示（规格 E）
                const amb = normalizeAmbColor(g.color, "blue");
                const members = sectioned.byName.get(g.name) ?? [];
                const memberKeys = members
                  .map(({ row }) => row.key.trim())
                  .filter(Boolean);
                const sub =
                  memberKeys.length > 0
                    ? `${memberKeys.slice(0, 3).join(" · ")}${memberKeys.length > 3 ? " …" : ""}`
                    : t("global.groupHint");
                const isCollapsed = collapsed.has(id);
                return (
                  <section
                    key={id}
                    data-sec={id}
                    data-amb={amb}
                    data-lit={lit === id ? "" : undefined}
                    className="side-sec rounded-lg border-t border-sidebar-border px-2 pt-2 pb-3"
                  >
                    <SectionHead
                      icon={Folder01Icon}
                      name={g.name}
                      sub={sub}
                      count={members.length}
                      collapsed={isCollapsed}
                      onToggle={() =>
                        setCollapsed((prev) => toggleInSet(prev, id))
                      }
                      action={
                        <>
                          <GroupColorPicker
                            name={g.name}
                            color={amb}
                            secId={id}
                            onPick={(c) => setColor(g.name, c, writeCtx())}
                          />
                          <IconButton
                            icon={Edit02Icon}
                            label={t("global.renameGroup")}
                            className={cn(
                              "text-muted-foreground/60 hover:text-foreground",
                              HEAD_ACTION,
                            )}
                            onClick={() => setDialog({ mode: "rename", group: g })}
                          />
                          {/* 删除分组无需确认：成员只是回到「未分组」，没有数据丢失 */}
                          <IconButton
                            icon={Delete02Icon}
                            label={t("global.removeGroup")}
                            className={cn(
                              "text-muted-foreground/60 hover:text-destructive",
                              HEAD_ACTION,
                            )}
                            onClick={() => remove(g.name, writeCtx())}
                          />
                        </>
                      }
                    />
                    {!isCollapsed && (
                      <div className="flex flex-col gap-1">
                        {members.map(({ row, index }) => renderRow(row, index))}
                        {members.length === 0 && (
                          <p className="px-2 py-1 text-xs text-muted-foreground/60">
                            {t("global.emptyGroup")}
                          </p>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}

              <section
                data-sec="ungrouped"
                data-amb="none"
                data-lit={lit === "ungrouped" ? "" : undefined}
                className="side-sec rounded-lg border-t border-sidebar-border px-2 pt-2 pb-3"
              >
                <SectionHead
                  icon={InboxUnreadIcon}
                  name={t("global.ungrouped")}
                  sub={t("global.ungroupedHint")}
                  count={sectioned.ungrouped.length}
                  collapsed={collapsed.has("ungrouped")}
                  onToggle={() =>
                    setCollapsed((prev) => toggleInSet(prev, "ungrouped"))
                  }
                />
                {!collapsed.has("ungrouped") && (
                  <div className="flex flex-col gap-1">
                    {sectioned.ungrouped.map(({ row, index }) => renderRow(row, index))}
                    {sectioned.ungrouped.length === 0 && (
                      <p className="px-2 py-1 text-xs text-muted-foreground/60">
                        {t("global.emptyGroup")}
                      </p>
                    )}
                  </div>
                )}
              </section>

              {/* 缺定义框：片段引用了、这里却没有定义的变量 */}
              {missing.length > 0 && (
                <div className="rounded-lg border border-dashed border-border px-3 py-2">
                  <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                    <span className="font-semibold text-foreground">
                      {t("global.missingDefs")}
                    </span>
                    <span className="text-muted-foreground">
                      {t("global.missingDefsHint")}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground/60 tabular-nums">
                      ·{missing.length}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-col gap-0.5">
                    {missing.map((m) => (
                      <div key={m.name} className="flex items-center gap-2 font-mono text-xs">
                        <span className="text-destructive">{`\${${m.name}}`}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {t("global.refsAt", { n: m.count })}
                        </span>
                        <button
                          type="button"
                          onClick={() => addRow(m.name, "value")}
                          className="h-6 rounded-[5px] px-1.5 text-xs whitespace-nowrap text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60"
                        >
                          {t("global.define")}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {dupKeys.size > 0 && (
                <p className="font-mono text-[11px] text-destructive">{t("global.dupHint")}</p>
              )}
            </>
          )}
        </div>
      </div>

      {dialog?.mode === "create" && (
        <GroupDialog
          mode="create"
          initialColor={pickDefaultColor(groups)}
          existingNames={groups.map((g) => g.name)}
          onSubmit={(name, color) => create(name, color, writeCtx())}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.mode === "rename" && (
        <GroupDialog
          mode="rename"
          initialName={dialog.group.name}
          initialColor={normalizeAmbColor(dialog.group.color, "blue")}
          existingNames={groups.map((g) => g.name).filter((n) => n !== dialog.group.name)}
          onSubmit={(name, color) => rename(dialog.group.name, name, color, writeCtx())}
          onClose={() => setDialog(null)}
        />
      )}
    </main>
  );
}

// 「移入分组」下拉：触发器是当前组名的纯文字（无障碍名带「移入分组」前缀，避免与
// 分区头同名冲突）；选项 = 各分组 + 分隔线 + 「未分组」。变量名为空的行不能归组。
function GroupMoveSelect({
  value,
  groupNames,
  disabled,
  onSelect,
}: {
  value: string | null;
  groupNames: string[];
  disabled: boolean;
  onSelect: (group: string | null) => void;
}) {
  const { t } = useTranslation();
  const currentLabel = value ?? t("global.ungrouped");
  return (
    <Select
      value={value ?? UNGROUPED_VALUE}
      onValueChange={(v) => onSelect(v === UNGROUPED_VALUE ? null : String(v))}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        aria-label={`${t("global.moveToGroup")}：${currentLabel}`}
        title={t("global.moveToGroup")}
        className={cn(
          "h-6 gap-1 border-0 bg-transparent py-0 pr-1 pl-1 font-sans text-[11px] font-normal text-muted-foreground shadow-none hover:border-transparent hover:shadow-none focus-visible:shadow-none [&_svg]:size-3 [&_svg]:text-muted-foreground/60",
          ROW_REVEAL,
        )}
      >
        <HugeiconsIcon icon={Folder01Icon} strokeWidth={1.75} className="size-3 shrink-0" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false}>
        {groupNames.map((g) => (
          <SelectItem key={g} value={g}>
            {g}
          </SelectItem>
        ))}
        <SelectSeparator />
        <SelectItem value={UNGROUPED_VALUE}>{t("global.ungrouped")}</SelectItem>
      </SelectContent>
    </Select>
  );
}
