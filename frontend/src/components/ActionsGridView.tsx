import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Edit02Icon } from "@hugeicons/core-free-icons";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useActionRunner } from "../hooks/useActionRunner";
import { useActionUsage, groupLabel, MISC_KEY, FOOTPRINT_SEGMENTS } from "../hooks/useActionUsage";
import { hasFormFields } from "../lib/params";
import { ActionIcon } from "./ActionIcon";
import { TickRuler, RunningFlow } from "./GridCardParts";
import type { ActionItem } from "../../bindings/workflow-tool/internal/api/models.js";
import type { Preset } from "../../bindings/workflow-tool/internal/registry/models.js";

// 等宽大写 eyebrow
const EYEBROW =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

// 使用足迹 → 键面图标底浓度：越常用越亮，仪表留痕在键面直读（Tooltip 里的分段条负责精读）
const ICON_TINT = [
  "bg-primary/10", "bg-primary/16", "bg-primary/22", "bg-primary/30", "bg-primary/40",
] as const;

// Grid 页（StreamDeck 形态）：按 id 前缀分组，键面只留识别级信息（图标+短名），
// 详情进 hover Tooltip；preset 以键底命名分段条常驻，点格直跑。
// 点键身：运行中→回到其输出视图；有「必填且无默认值」的参数进表单；否则直接运行。
export function ActionsGridView() {
  const { t } = useTranslation();
  const { actions, runAction, selectPreset, isRunning, focusRunning } = useActionRunner();
  const { groupByPrefix, footprintLevel, getScore, recordUsage, topActions } = useActionUsage();

  const shellActions = actions.filter((a) => !a.llm);
  const groups = groupByPrefix(shellActions);
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
          {t("grid.itemsCount", { count: shellActions.length })}
          {" · "}
          {t("grid.groupsCount", { count: groupCount })}
        </span>
      </header>

      <div className="p-4 space-y-6">
        {shellActions.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-20 text-center">
            <span className={EYEBROW}>{t("grid.emptyEyebrow")}</span>
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
              {t("grid.empty")}
            </p>
          </div>
        )}
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
              {/* 固定列宽：尾行单项不被 1fr 拉宽、aspect-square 跟随变形 */}
              <div className="grid grid-cols-[repeat(auto-fill,104px)] justify-start gap-2">
                {topActions(items, items.length).map((action) => (
                  <ActionCard
                    key={action.id}
                    action={action}
                    running={isRunning(action.id)}
                    level={footprintLevel(action.id)}
                    score={getScore(action.id)}
                    onRun={(params, background) => {
                      runAction(action.id, params, background);
                      recordUsage(action.id);
                    }}
                    onEdit={() => selectPreset(action.id, "")}
                    onFocus={() =>
                      focusRunning(
                        action.id,
                        action.llm ? "llm-chat" : action.stream === "logcat" ? "logcat" : "output",
                      )
                    }
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
  onRun: (params: Record<string, string>, background?: boolean) => void;
  onEdit: () => void;
  onFocus: () => void;
  onPresetRun: (values: Record<string, string | undefined>) => void;
  onPresetEdit: (name: string) => void;
}

function ActionCard({
  action, running, level, score,
  onRun, onFocus, onEdit, onPresetRun, onPresetEdit,
}: ActionCardProps) {
  const { t } = useTranslation();
  const hasParams = (action.params?.length ?? 0) > 0;
  // 是否「值得进表单」：有必填且无默认值的项。否则单击直接运行（与侧边栏/工作流网格一致）。
  const showForm = hasFormFields(action.params);
  const paramIds = action.params?.map((p) => p.id) ?? [];

  const buildDefaults = (): Record<string, string> => {
    const vals: Record<string, string> = {};
    action.params?.forEach((p) => { vals[p.id] = p.default || ""; });
    return vals;
  };

  const handleCardClick = () => {
    if (running) {
      // 运行中：回到其输出视图（logcat 会带回该次的过滤条件），不重复启动
      onFocus();
      return;
    }
    if (showForm) {
      onEdit(); // 进 form（selectPreset("")，用 default 预填）
    } else {
      onRun(hasParams ? buildDefaults() : {});
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <div
            {...props}
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
              group relative flex aspect-square flex-col items-center gap-1 rounded-lg border p-1.5 cursor-pointer
              bg-card transition-colors duration-150 ease-out
              hover:border-primary/55 hover:shadow-[inset_0_0_0_1px] hover:shadow-primary/30
              focus-visible:outline-none focus-visible:border-primary/55
              focus-visible:shadow-[inset_0_0_0_1px] focus-visible:shadow-primary/30
              ${running ? "border-primary" : "border-border"}
            `}
          >
            {running && <RunningFlow />}

            {/* 运行状态点（仅运行中显示，与流光互补） */}
            {running && (
              <span className="live-pulse absolute left-1.5 top-1.5 size-1.5 rounded-full bg-primary" />
            )}

            {/* hover 浮现的编辑入口：进 form 看参数/preset */}
            <button
              type="button"
              aria-label={t("grid.editParams")}
              title={t("grid.editParams")}
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              className="absolute right-1 top-1 z-10 grid size-5 place-items-center rounded text-muted-foreground
                opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100
                hover:bg-card hover:text-foreground cursor-pointer"
            >
              <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} className="size-3" />
            </button>

            {/* 图标区：主识别物，垂直居中；底浓度 = 使用足迹（越常用越亮） */}
            <span className="flex flex-1 items-center justify-center">
              <span
                className={`flex size-10 items-center justify-center rounded-lg text-primary
                  ${ICON_TINT[Math.min(level, ICON_TINT.length - 1)]}`}
              >
                <ActionIcon name={action.icon} className="size-5" />
              </span>
            </span>

            {/* 标题：1 行截断，全名在 Tooltip */}
            <span className="w-full text-center font-mono text-[11px] font-semibold leading-tight -tracking-[0.01em] truncate">
              {action.title}
            </span>

            {/* preset 命名分段条：名字常驻可辨识，点格直跑 */}
            {(action.presets?.length ?? 0) > 0 && (
              <PresetSegments
                presets={action.presets!}
                onPresetRun={onPresetRun}
                onPresetEdit={onPresetEdit}
                onMore={onEdit}
              />
            )}
          </div>
        )}
      />
      <TooltipContent side="top">
        <div className="space-y-1 text-left">
          <div className="font-mono text-xs font-semibold">{action.title}</div>
          {action.description && (
            <div className="max-w-[260px] text-[11px] leading-relaxed text-background/70">
              {action.description}
            </div>
          )}
          {hasParams && (
            <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-background/60">
              {paramIds.join(" · ")}
            </div>
          )}
          <div className="flex items-center gap-2 font-mono text-[10px] text-background/60">
            <span aria-label={t("grid.footprint")} className="flex items-center gap-[3px]">
              {Array.from({ length: FOOTPRINT_SEGMENTS }, (_, i) => (
                <span
                  key={i}
                  className={`h-0.5 w-2 rounded-sm ${i < level ? "bg-primary" : "bg-background/25"}`}
                />
              ))}
            </span>
            <span className="tabular-nums">·{Math.round(score)}</span>
            {(action.presets?.length ?? 0) > 0 && (
              <span className="tabular-nums">
                · {t("grid.presetsCount", { count: action.presets!.length })}
              </span>
            )}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

// preset 命名分段条：≤3 全显；>3 前 2 + 「+N」格（+N 进 form 选其余）。
// 整条 stopPropagation，格内各自处理，点格不触发键身默认行为。
// 每格 hover 浮现微型 ✎：进 form 预填该 preset 值（修改后同名保存即覆盖）。
function PresetSegments({
  presets, onPresetRun, onPresetEdit, onMore,
}: {
  presets: Preset[];
  onPresetRun: (values: Record<string, string | undefined>) => void;
  onPresetEdit: (name: string) => void;
  onMore: () => void;
}) {
  const { t } = useTranslation();
  const shown = presets.length <= 3 ? presets : presets.slice(0, 2);
  const rest = presets.length - shown.length;

  const segClass =
    "group/chip truncate bg-muted/50 px-1 py-0.5 text-center font-mono text-[10px] leading-4 tracking-[0.02em] " +
    "text-muted-foreground hover:bg-primary/12 hover:text-primary cursor-pointer focus-visible:outline-none " +
    "focus-visible:bg-primary/12 focus-visible:text-primary";

  return (
    <div
      className="grid w-full grid-flow-col auto-cols-fr gap-px overflow-hidden rounded-md border border-border/60"
      onClick={(e) => e.stopPropagation()}
    >
      {shown.map((p) => (
        <span
          key={p.name}
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onPresetRun(p.values);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onPresetRun(p.values);
            }
          }}
          className={segClass}
        >
          {p.name}
          <span
            role="button"
            tabIndex={0}
            aria-label={t("grid.editPreset")}
            onClick={(e) => {
              e.stopPropagation();
              onPresetEdit(p.name);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onPresetEdit(p.name);
              }
            }}
            className="ml-0.5 inline-grid size-3 place-items-center rounded align-[-1px] text-muted-foreground
              opacity-0 group-hover/chip:opacity-100 group-focus-within/chip:opacity-100 transition-opacity
              hover:bg-card hover:text-foreground cursor-pointer"
          >
            <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} className="size-2" />
          </span>
        </span>
      ))}
      {rest > 0 && (
        <span
          role="button"
          tabIndex={0}
          aria-label={t("grid.morePresets", { count: rest })}
          onClick={(e) => {
            e.stopPropagation();
            onMore();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onMore();
            }
          }}
          className={`${segClass} text-primary tabular-nums`}
        >
          +{rest}
        </span>
      )}
    </div>
  );
}
