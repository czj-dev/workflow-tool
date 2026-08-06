import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Edit02Icon } from "@hugeicons/core-free-icons";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";
import { useActionUsage, groupLabel, FOOTPRINT_SEGMENTS, MISC_KEY } from "../hooks/useActionUsage";
import { ActionIcon } from "./ActionIcon";
import type { ActionItem } from "../../bindings/workflow-tool/internal/api/models.js";

// 等宽大写 eyebrow
const EYEBROW =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

// Grid 页：按 id 前缀分组展示所有 action。点卡片 = 默认运行；右上 ✎ 进 form；preset chip 直接运行。
export function ActionsGridView() {
  const { t } = useTranslation();
  const { actions, runAction, selectPreset, isRunning } = useActionRunner();
  const { groupByPrefix, footprintLevel, recordUsage } = useActionUsage();

  const groups = groupByPrefix(actions);
  const groupEntries = Object.entries(groups).sort(([a], [b]) => {
    // MISC_KEY 永远排最后
    if (a === MISC_KEY) return 1;
    if (b === MISC_KEY) return -1;
    return a.localeCompare(b);
  });
  const groupCount = groupEntries.length;

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
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
        {groupEntries.map(([key, items]) => (
          <section key={key}>
            {/* 分组头：name ── rule ── count */}
            <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 pb-3">
              <span className={EYEBROW}>
                {key === MISC_KEY ? t("grid.groupMisc") : groupLabel(key)}
              </span>
              <span className="h-px bg-border" />
              <span className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground">
                {items.length}
              </span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
              {items.map((action) => (
                <ActionCard
                  key={action.id}
                  action={action}
                  running={isRunning(action.id)}
                  level={footprintLevel(action.id)}
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
        ))}
      </div>
    </main>
  );
}

// ——— 内联 ActionCard ———
// ponytail: 单一消费者，不外抽文件；复用时再拆。
interface ActionCardProps {
  action: ActionItem;
  running: boolean;
  level: number; // 足迹亮段数 0-5
  onRun: (params: Record<string, string>) => void;
  onEdit: () => void;
  onPresetRun: (values: Record<string, string>) => void;
  onPresetEdit: (name: string) => void;
}

function ActionCard({ action, running, level, onRun, onEdit, onPresetRun, onPresetEdit }: ActionCardProps) {
  const { t } = useTranslation();
  const hasParams = (action.params?.length ?? 0) > 0;
  const presetCount = action.presets?.length ?? 0;

  // 用 param defaults 构造默认参数
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
      className={`
        group relative flex flex-col gap-2.5 rounded-lg border p-3.5 cursor-pointer
        transition-all duration-150 ease-out
        hover:border-primary/55 hover:-translate-y-0.5 hover:shadow-[0_4px_20px_-8px] hover:shadow-primary/40
        ${running ? "border-primary" : "border-border"}
      `}
    >
      {/* running 态呼吸边框 */}
      {running && (
        <span className="pointer-events-none absolute inset-[-1px] rounded-lg border border-primary/60 animate-pulse" />
      )}

      {/* 顶部：图标 + 足迹条 + edit 按钮 */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/14 text-primary">
            <ActionIcon name={action.icon} className="size-4" />
          </span>
          {/* 使用足迹条 */}
          <div className="flex gap-[3px] items-center">
            {Array.from({ length: FOOTPRINT_SEGMENTS }, (_, i) => (
              <span
                key={i}
                className={`h-0.5 w-2 rounded-sm ${
                  i < level ? "bg-primary/65" : "bg-foreground/12"
                }`}
              />
            ))}
          </div>
        </div>
        {/* edit 按钮：仅有 params 时显示 */}
        {hasParams && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="size-6 rounded-md border border-transparent grid place-items-center text-muted-foreground
              opacity-0 group-hover:opacity-100 transition-opacity
              hover:bg-muted hover:text-foreground hover:border-border"
            title={t("grid.editParams")}
          >
            <HugeiconsIcon icon={Edit02Icon} strokeWidth={1.75} className="size-3.5" />
          </button>
        )}
      </div>

      {/* 标题 */}
      <span className="font-mono text-sm font-semibold leading-tight tracking-[0.02em]">
        {action.title}
      </span>

      {/* 描述 */}
      {action.description && (
        <span className="text-xs leading-relaxed text-muted-foreground line-clamp-2">
          {action.description}
        </span>
      )}

      {/* preset chips */}
      {action.presets && action.presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {action.presets.map((p) => (
            <span
              key={p.name}
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
              className="group/chip relative inline-flex items-center gap-1.5 rounded-full border border-border
                bg-muted/60 px-2.5 py-0.5 font-mono text-[11px] tracking-[0.02em] cursor-pointer
                transition-colors hover:border-primary/60 hover:bg-primary/8"
            >
              <span className="text-primary text-[10px]">▸</span>
              {p.name}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onPresetEdit(p.name); }}
                className="size-4 rounded grid place-items-center text-muted-foreground
                  opacity-0 group-hover/chip:opacity-100 transition-opacity
                  hover:bg-card hover:text-foreground"
                title={t("grid.editPreset")}
              >
                <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} className="size-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* 底部元信息 */}
      <div className="flex items-center justify-between gap-2 border-t border-dashed border-border pt-2 mt-auto
        font-mono text-[10px] tracking-[0.06em] uppercase text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 opacity-70 text-foreground">
          {hasParams
            ? t("grid.paramsCount", { count: action.params!.length }) + (presetCount ? ` · ${t("grid.presetsCount", { count: presetCount })}` : "")
            : t("grid.noParams")}
        </span>
        {running && (
          <span className="flex items-center gap-1.5 text-primary">
            <span className="size-1.5 rounded-full bg-primary live-pulse" />
            running
          </span>
        )}
      </div>
    </div>
  );
}

