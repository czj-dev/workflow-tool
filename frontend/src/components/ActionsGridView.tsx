import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Edit02Icon } from "@hugeicons/core-free-icons";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";
import { useActionUsage, groupLabel, MISC_KEY } from "../hooks/useActionUsage";
import { hasFormFields } from "../lib/params";
import { ActionIcon } from "./ActionIcon";
import { TickRuler, StatusRail, RunningFlow } from "./GridCardParts";
import type { ActionItem } from "../../bindings/workflow-tool/internal/api/models.js";
import type { Preset } from "../../bindings/workflow-tool/internal/registry/models.js";

// 等宽大写 eyebrow
const EYEBROW =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

// 使用足迹 → 键面图标「背光」强度：底色 + 内发光双档映射，越常用越亮（仪表留痕直读）
const ICON_TINT = [
  { bg: "bg-primary/10", glow: "shadow-primary/20" },
  { bg: "bg-primary/16", glow: "shadow-primary/25" },
  { bg: "bg-primary/22", glow: "shadow-primary/30" },
  { bg: "bg-primary/30", glow: "shadow-primary/40" },
  { bg: "bg-primary/40", glow: "shadow-primary/50" },
] as const;

// 翻面时长与缓动（正/背面共用，保持两面同步）
const FLIP = "transition-[transform,opacity] duration-[180ms] ease-[cubic-bezier(0.2,0.7,0.3,1)]";

// Grid 页（StreamDeck 键面翻转形态）：按 id 前缀分组，正面只留识别级信息
// （图标+短名+preset 暗示点）；有 preset 的键 hover/focus 原地翻面，背面是操作面
// （首行=默认行为，preset 行全宽直跑，>3 收 +N 进表单）。无 preset 键不翻、点即跑。
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
              <div className="grid grid-cols-[repeat(auto-fill,130px)] justify-start gap-2.5">
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

  const presets = action.presets ?? [];
  const hasPresets = presets.length > 0;
  // 键面翻转：有 preset 的键 hover/focus 翻到操作面；无 preset 键不翻（点即跑，不打断）
  const flipFront = hasPresets
    ? "group-hover:[transform:rotateX(92deg)] group-hover:opacity-0 group-focus-within:[transform:rotateX(92deg)] group-focus-within:opacity-0"
    : "";
  const flipBack =
    "group-hover:[transform:rotateX(0deg)] group-hover:opacity-100 group-hover:pointer-events-auto " +
    "group-focus-within:[transform:rotateX(0deg)] group-focus-within:opacity-100 group-focus-within:pointer-events-auto";

  // 原生 tooltip：描述 + 预设全名列表（翻面动画的 180ms 空窗内也能预览全部预设）
  const tip = [
    action.description,
    hasPresets ? `${t("form.presetsLabel")}: ${presets.map((p) => p.name).join(" / ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div
      role="button"
      tabIndex={0}
      title={tip || action.title}
      onClick={handleCardClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleCardClick();
        }
      }}
      data-running={running || undefined}
      className={`
        group relative aspect-square cursor-pointer rounded-xl border
        bg-gradient-to-b from-card to-background/70
        shadow-[0_1px_2px_rgb(0_0_0/0.1),0_2px_5px_rgb(0_0_0/0.06)]
        [perspective:320px] transition-[border-color,box-shadow,translate] duration-150 ease-out
        after:pointer-events-none after:absolute after:inset-x-2.5 after:top-px after:h-px
        after:bg-gradient-to-r after:from-transparent after:via-card-foreground/12 after:to-transparent
        hover:-translate-y-px hover:border-primary/60
        hover:shadow-[0_5px_14px_rgb(0_0_0/0.2),0_1px_3px_rgb(0_0_0/0.14)]
        focus-visible:-translate-y-px focus-visible:border-primary/60
        focus-visible:shadow-[0_5px_14px_rgb(0_0_0/0.2),0_1px_3px_rgb(0_0_0/0.14)]
        focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60
        active:translate-y-px active:shadow-[0_0_1px_rgb(0_0_0/0.1),inset_0_1px_3px_rgb(0_0_0/0.18)]
        ${running ? "border-primary" : "border-border"}
      `}
    >
      {running && <RunningFlow className="rounded-t-xl" />}

      {/* ——— 正面：识别面（StatusRail + 图标 + 短名 + preset 暗示点） ——— */}
      <div
        className={`absolute inset-0 flex flex-col items-center rounded-[11px]
          bg-gradient-to-b from-card to-background/70 p-1.5
          [backface-visibility:hidden] motion-reduce:transform-none ${FLIP} ${flipFront}`}
      >
        {/* 顶部仪表 rail（compact）：状态点 + 使用足迹，靠左无计数（与其他 Grid 视图共用组件） */}
        <StatusRail level={level} score={score} compact />

        {/* 图标区：主识别物，垂直居中；底色+内发光 = 使用足迹背光（越常用越亮） */}
        <span className="flex flex-1 items-center justify-center">
          <span
            className={`flex size-[50px] items-center justify-center rounded-xl text-primary
              shadow-[inset_0_0_14px] ${ICON_TINT[Math.min(level, ICON_TINT.length - 1)].bg}
              ${ICON_TINT[Math.min(level, ICON_TINT.length - 1)].glow}`}
          >
            <ActionIcon name={action.icon} className="size-6" />
          </span>
        </span>

        {/* 标题：1 行截断，全名挂原生 title */}
        <span className="w-full text-center font-mono text-xs font-semibold leading-tight -tracking-[0.01em] truncate">
          {action.title}
        </span>

        {/* preset 暗示点：只说「有几个」，不假装能读字；无 preset 空占位保持整排同构 */}
        <span className="mt-0.5 flex h-1.5 items-center justify-center gap-1">
          {hasPresets ? (
            presets.map((p) => (
              <i key={p.name} className="size-1 rounded-full bg-primary/40" aria-hidden="true" />
            ))
          ) : (
            <i className="invisible size-1" aria-hidden="true" />
          )}
        </span>

        {/* 无 preset 键 hover 浮现的编辑入口（有 preset 键的编辑走背面 ✎/+N） */}
        {!hasPresets && (
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
        )}
      </div>

      {/* ——— 背面：操作面（主行 + preset 行 + +N） ——— */}
      {hasPresets && (
        <div
          className={`absolute inset-0 flex flex-col gap-0.5 rounded-[11px]
            bg-gradient-to-b from-card to-background/70 p-1.5
            opacity-0 pointer-events-none [backface-visibility:hidden] [transform:rotateX(-92deg)]
            motion-reduce:transform-none ${FLIP} ${flipBack}`}
        >
          {/* 主行：点击冒泡键身 = 默认行为（运行中→回输出；必填→表单；否则直跑） */}
          <div className="flex h-7 shrink-0 items-center gap-1.5 rounded-t-md border-b border-dashed border-border
            px-1.5 font-mono text-xs font-semibold hover:bg-primary/10 cursor-pointer">
            <ActionIcon name={action.icon} className="size-4 shrink-0 text-primary" />
            <span className="truncate">{action.title}</span>
            <span className="ml-auto shrink-0 text-[10px] tracking-[0.1em] text-primary">
              {running ? "↩" : "▸"}
            </span>
          </div>
          <BackPresets
            presets={presets}
            onPresetRun={onPresetRun}
            onPresetEdit={onPresetEdit}
            onMore={onEdit}
          />
        </div>
      )}
    </div>
  );
}

// 背面 preset 行：≤4 全显；>4 前 3 + 「+N」行（+N 进 form 选其余）。键面 130px 可容主行+4 行。
// 行点击/键盘都 stopPropagation，不触发键身默认行为。
// 每行 hover 浮现 ✎：进 form 预填该 preset 值（修改后同名保存即覆盖）。
function BackPresets({
  presets, onPresetRun, onPresetEdit, onMore,
}: {
  presets: Preset[];
  onPresetRun: (values: Record<string, string | undefined>) => void;
  onPresetEdit: (name: string) => void;
  onMore: () => void;
}) {
  const { t } = useTranslation();
  const shown = presets.length <= 4 ? presets : presets.slice(0, 3);
  const rest = presets.length - shown.length;

  return (
    <>
      {shown.map((p) => (
        <div
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
          className="group/row flex min-h-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5
            font-mono text-xs font-semibold text-muted-foreground
            hover:bg-primary/10 hover:text-primary focus-visible:bg-primary/10 focus-visible:text-primary
            focus-visible:outline-none"
        >
          <i className="size-[5px] shrink-0 rounded-full bg-primary/45" aria-hidden="true" />
          <span className="truncate">{p.name}</span>
          <span
            role="button"
            tabIndex={0}
            aria-label={t("grid.editPreset")}
            title={t("grid.editPreset")}
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
            className="ml-auto grid size-4 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground
              opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100
              hover:text-primary"
          >
            <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} className="size-2.5" />
          </span>
        </div>
      ))}
      {rest > 0 && (
        <div
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
          className="flex h-5 shrink-0 cursor-pointer items-center justify-center rounded-b-md
            font-mono text-[11px] tabular-nums tracking-[0.08em] text-primary hover:bg-primary/10
            focus-visible:bg-primary/10 focus-visible:outline-none"
        >
          +{rest}
        </div>
      )}
    </>
  );
}
