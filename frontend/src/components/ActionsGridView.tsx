import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Edit02Icon } from "@hugeicons/core-free-icons";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { useActionRunner } from "../hooks/useActionRunner";
import { useActionUsage, groupLabel, MISC_KEY } from "../hooks/useActionUsage";import { ActionIcon } from "./ActionIcon";
import { TickRuler, StatusRail, ParamSummary, RunningFlow } from "./GridCardParts";
import type { ActionItem } from "../../bindings/workflow-tool/internal/api/models.js";

// 等宽大写 eyebrow
const EYEBROW =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

// Grid 页：按 id 前缀分组展示所有 action。点卡片 = 默认运行；preset chip 直接运行、chip 内 ✎ 进编辑。
export function ActionsGridView() {
  const { t } = useTranslation();
  const { actions, runAction, selectPreset, isRunning } = useActionRunner();
  const { groupByPrefix, footprintLevel, getScore, recordUsage, topActions } = useActionUsage();

  const groups = groupByPrefix(actions);
  const groupEntries = Object.entries(groups).sort(([a], [b]) => {
    // MISC_KEY 永远排最后
    if (a === MISC_KEY) return 1;
    if (b === MISC_KEY) return -1;
    return a.localeCompare(b);
  });
  const groupCount = groupEntries.length;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <h1 className="text-sm font-semibold">{t("grid.title")}</h1>
        </div>
        <span className="font-mono text-[11px] tracking-[0.14em] uppercase text-muted-foreground">
          {t("grid.itemsCount", { count: actions.length })}
          {" · "}
          {t("grid.groupsCount", { count: groupCount })}
        </span>
      </header>

      <div className="p-4 space-y-6">
        {groupEntries.map(([key, items]) => {
          const lit = items.reduce((n, it) => (getScore(it.id) > 0 ? n + 1 : n), 0);
          return (
            <section key={key}>
              {/* BUS RAIL 分组头：label ── tick-ruler ── count */}
              <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 pb-3">
                <span className={EYEBROW}>
                  {key === MISC_KEY ? t("grid.groupMisc") : groupLabel(key)}
                </span>
                <TickRuler total={items.length} lit={lit} />
                <span className="font-mono text-[11px] tracking-[0.14em] uppercase text-muted-foreground tabular-nums">
                  {items.length} {t("grid.slots")}
                </span>
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-3">
                {topActions(items, items.length).map((action) => (
                  <ActionCard
                    key={action.id}
                    action={action}
                    running={isRunning(action.id)}
                    level={footprintLevel(action.id)}
                    score={getScore(action.id)}
                    onRun={(params) => {
                      runAction(action.id, params);
                      recordUsage(action.id);
                    }}
                    onEdit={() => selectPreset(action.id, "")}
                    onPresetRun={(values) => {
                      runAction(action.id, values);
                      recordUsage(action.id);
                    }}
                    onPresetEdit={(name) => selectPreset(action.id, name)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}

// ——— 内联 ActionCard ———
// ponytail: 单一消费者，不外抽文件；复用时再拆。
interface ActionCardProps {
  action: ActionItem;
  running: boolean;
  level: number;
  score: number;
  onRun: (params: Record<string, string>) => void;
  onEdit: () => void;
  onPresetRun: (values: Record<string, string>) => void;
  onPresetEdit: (name: string) => void;
}

function ActionCard({
  action, running, level, score,
  onRun, onEdit, onPresetRun, onPresetEdit,
}: ActionCardProps) {
  const { t } = useTranslation();
  const hasParams = (action.params?.length ?? 0) > 0;
  const presetCount = action.presets?.length ?? 0;
  const paramIds = action.params?.map((p) => p.id) ?? [];

  const buildDefaults = (): Record<string, string> => {
    const vals: Record<string, string> = {};
    action.params?.forEach((p) => { vals[p.id] = p.default || ""; });
    return vals;
  };

  const handleCardClick = () => {
    onRun(hasParams ? buildDefaults() : {});
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleCardClick();
        }
      }}
      data-running={running || undefined}
      className={`
        group relative flex flex-col gap-2.5 rounded-lg border p-3.5 cursor-pointer
        bg-card transition-colors duration-150 ease-out
        hover:border-primary/55 hover:shadow-[inset_0_0_0_1px] hover:shadow-primary/30
        focus-visible:outline-none focus-visible:border-primary/55
        focus-visible:shadow-[inset_0_0_0_1px] focus-visible:shadow-primary/30
        ${running ? "border-primary" : "border-border"}
      `}
    >
      {running && <RunningFlow />}

      {/* 顶部仪表 rail */}
      <StatusRail level={level} score={score} />

      {/* 图标 + 标题：同行紧邻 */}
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/14 text-primary">
          <ActionIcon name={action.icon} className="size-4" />
        </span>
        <span className="font-mono text-[13.5px] font-semibold leading-tight -tracking-[0.01em] break-all">
          {action.title}
        </span>
      </div>

      {/* 描述：clamp 限高，hover/focus 展开 */}
      {action.description && (
        <span className="text-xs leading-relaxed text-muted-foreground line-clamp-2 group-hover:line-clamp-none group-focus-within:line-clamp-none">
          {action.description}
        </span>
      )}

      {/* 参数摘要：param id 列出，代替只有数字的读数 */}
      {hasParams && <ParamSummary ids={paramIds} />}

      {/* preset chips：限高，hover/focus 展开；chip 主体运行、内嵌 ✎ 编辑 */}
      {action.presets && action.presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5 max-h-14 overflow-hidden group-hover:max-h-none group-focus-within:max-h-none">
          {action.presets.map((p) => (
            <Badge
              key={p.name}
              variant="outline"
              className="group/chip cursor-pointer bg-muted/60 font-mono text-[11px] tracking-[0.02em] hover:border-primary/60 hover:bg-primary/8"
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onPresetRun(p.values as Record<string, string>); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onPresetRun(p.values as Record<string, string>);
                }
              }}
            >
              <span className="text-primary text-[10px]">▸</span>
              {p.name}
              <span
                role="button"
                tabIndex={0}
                aria-label={t("grid.editPreset")}
                onClick={(e) => { e.stopPropagation(); onPresetEdit(p.name); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onPresetEdit(p.name);
                  }
                }}
                className="size-4 rounded grid place-items-center text-muted-foreground
                  opacity-0 group-hover/chip:opacity-100 transition-opacity
                  hover:bg-card hover:text-foreground cursor-pointer"
                title={t("grid.editPreset")}
              >
                <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} className="size-2.5" />
              </span>
            </Badge>
          ))}
        </div>
      )}

      {/* 底部 read-out + hover CTA + edit */}
      <div className="flex items-center justify-between gap-2 border-t border-dashed border-border pt-2 mt-auto
        font-mono text-[10px] tracking-[0.06em] uppercase text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 opacity-70 text-foreground tabular-nums">
          {hasParams
            ? t("grid.paramsCount", { count: action.params!.length }) + (presetCount ? ` · ${t("grid.presetsCount", { count: presetCount })}` : "")
            : t("grid.noParams")}
        </span>
        {running ? (
          <span className="flex items-center gap-1.5 text-primary normal-case tracking-normal">
            <span className="size-1.5 rounded-full bg-primary live-pulse" />
            running
          </span>
        ) : (
          <span className="flex items-center gap-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {hasParams && (
              <button
                type="button"
                aria-label={t("grid.editParams")}
                title={t("grid.editParams")}
                onClick={(e) => { e.stopPropagation(); onEdit(); }}
                className="grid size-4 place-items-center rounded text-muted-foreground hover:text-foreground hover:bg-card"
              >
                <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} className="size-3" />
              </button>
            )}
            <span className="text-primary tracking-[0.14em]">▸ {t("grid.run")}</span>
          </span>
        )}
      </div>
    </div>
  );
}
