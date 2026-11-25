import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { AiChat02Icon, Calendar03Icon, FirstBracketIcon } from "@hugeicons/core-free-icons";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useActionRunner } from "../hooks/useActionRunner";
import { useActionUsage, groupLabel, MISC_KEY, compareGroupKeys } from "../hooks/useActionUsage";
import { aiRunSummary, schedulesOfTarget } from "../lib/runs";
import { createScheduleId, DEFAULT_SCHEDULE_CRON, describeScheduleCron, parseScheduleCron } from "../lib/scheduleCron";
import { fmtGoDuration } from "../lib/duration";
import { ActionIcon } from "./ActionIcon";
import type { ScheduleItem } from "../../bindings/workflow-tool/internal/api/models.js";
import type { RunItem, ScheduleLastSkip } from "../types/events";
import {
  TickRuler,
  StatusRail,
  RunningFlow,
  ambFor,
  ambColorFor,
  runTone,
  NarrativeZone,
  PresetDots,
  PresetChips,
  GhostBtn,
  RunPill,
  QuickHint,
  narrativeStamp,
} from "./GridCardParts";
import type { AiTaskItem } from "../../bindings/workflow-tool/internal/api/models.js";

const EYEBROW =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

// AI 任务专属 grid：双态卡（ADR-0001）。❝叙述区 = 最近一次运行的摘要（时间戳 + 按当次
// 输入展开后的一句 prompt，取自运行记录；没有运行回落描述）；展开态另有该任务所属调度的
// 投影（cron / 启停 / 最近结果）与「定时」入口（新建调度，目标锁定为该任务——同一任务
// 可被多条调度指向，ADR-0005）；chips = 带预设进会话页；运行在后台跑，要看会话点卡片
// 本体（或「对话」）。
export function AiGridView() {
  const { t } = useTranslation();
  const {
    aiTasks, aiErrors, focusAi, isAiRunning, openAiChat, runAi, openYamlEditor,
    schedules, openScheduleForm, openRun, setFormSheetOpen,
  } = useActionRunner();
  const { groupByPrefix, footprintLevel, getScore, topActions } = useActionUsage("ai-usage");
  // 双态：同视图内至多一张展开卡
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const groups = groupByPrefix(aiTasks);
  const groupEntries = Object.entries(groups).sort(([a], [b]) => compareGroupKeys(a, b));

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <h1 className="text-sm font-semibold">{t("aiGrid.title")}</h1>
        </div>
        <span className="font-mono text-[11px] tracking-[0.14em] uppercase text-muted-foreground">
          {t("grid.itemsCount", { count: aiTasks.length })}
          {" · "}
          {t("grid.groupsCount", { count: groupEntries.length })}
        </span>
      </header>
      <div className="p-4 space-y-6">
        {aiTasks.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-20 text-center">
            <span className={EYEBROW}>{t("aiGrid.title")}</span>
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{t("empty.noAiTasks")}</p>
          </div>
        )}
        {aiErrors.map((e, i) => (
          <Alert key={`ai-err-${i}`} variant="destructive">
            <AlertDescription className="whitespace-pre-wrap font-mono text-xs">{e}</AlertDescription>
          </Alert>
        ))}
        {groupEntries.map(([key, items], groupIndex) => {
          const lit = items.reduce((n, it) => (getScore(it.id) > 0 ? n + 1 : n), 0);
          return (
            <section key={key}>
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
                {topActions(items, items.length).map((task) => (
                  <AiCard
                    key={task.id}
                    task={task}
                    group={key === MISC_KEY ? "misc" : key}
                    amb={ambColorFor(task.color) ?? ambFor(groupIndex)}
                    running={isAiRunning(task.id)}
                    level={footprintLevel(task.id)}
                    score={getScore(task.id)}
                    expanded={expandedId === task.id}
                    onToggleExpand={() =>
                      setExpandedId((cur) => (cur === task.id ? null : task.id))
                    }
                    onCollapse={() =>
                      setExpandedId((cur) => (cur === task.id ? null : cur))
                    }
                    onOpen={() => focusAi(task.id)}
                    // 预设只把 values 并入草稿再进会话页：不直接起跑（提示词多半还要改）
                    onOpenPreset={(name) => {
                      const preset = task.presets?.find((p) => p.name === name);
                      openAiChat(task.id, preset?.values);
                    }}
                    onRun={() => { void runAi(task.id, undefined, true); }}
                    onEditYaml={() => openYamlEditor(task.id, "ai")}
                    schedules={schedulesOfTarget(schedules, "ai", task.id)}
                    onNewSchedule={() => {
                      setFormSheetOpen(false);
                      openScheduleForm({
                        id: createScheduleId(schedules.map((item) => item.id)),
                        name: task.title,
                        enabled: true,
                        cron: DEFAULT_SCHEDULE_CRON,
                        targetKind: "ai",
                        targetId: task.id,
                        params: {},
                      }, true, { kind: "ai", id: task.id });
                    }}
                    onEditSchedule={(schedule) => {
                      setFormSheetOpen(false);
                      openScheduleForm({
                        id: schedule.id, name: schedule.name, enabled: schedule.enabled, cron: schedule.cron,
                        targetKind: "ai", targetId: task.id, params: schedule.params ?? {},
                        catchUp: schedule.catchUp,
                      }, false);
                    }}
                    onViewRun={openRun}
                    onOpenScheduled={() => {
                      // 调度发起的运行：前端没有它的输出捕获，去运行详情实时跟踪
                      const liveRun = schedulesOfTarget(schedules, "ai", task.id).find((item) => item.running)?.lastRun?.runId;
                      if (liveRun) openRun(liveRun);
                    }}
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

// 单一消费者，内联不外抽。
interface AiCardProps {
  task: AiTaskItem;
  group: string;
  /** 氛围色（按分组显示序循环）；恒为组色，运行不夺氛围（ADR-0003） */
  amb: string;
  running: boolean;
  level: number;
  score: number;
  expanded: boolean;
  onToggleExpand: () => void;
  onCollapse: () => void;
  onOpen: () => void;
  onOpenPreset: (name: string) => void;
  onRun: () => void;
  onEditYaml: () => void;
  /** 指向该任务的调度（调度投影的数据源） */
  schedules: ScheduleItem[];
  /** 新建一条指向该任务的调度（编辑器里目标锁定） */
  onNewSchedule: () => void;
  onEditSchedule: (schedule: ScheduleItem) => void;
  /** 进某次运行的详情（调度最近结果的入口） */
  onViewRun: (runId: string) => void;
  /** 调度发起的运行进行中时点卡身：去那条运行的详情实时跟踪 */
  onOpenScheduled: () => void;
}

function AiCard({
  task, group, amb, running, level, score, expanded, onToggleExpand, onCollapse, onOpen, onOpenPreset, onRun,
  onEditYaml, schedules, onNewSchedule, onEditSchedule, onViewRun, onOpenScheduled,
}: AiCardProps) {
  const { t } = useTranslation();
  const presets = task.presets ?? [];
  // ❝ 摘要取自运行记录：最近一次真实运行的 prompt 按当次输入展开后一句话
  const last: RunItem | undefined = task.lastRun ?? undefined;
  const lastAt = last?.startedAt ? Date.parse(last.startedAt) : NaN;
  const icon = task.icon || "hi:ai";
  const summary = running
    ? t("aiChat.liveSummary")
    : aiRunSummary(last) ?? task.description ?? task.id;
  // 调度投影：该任务被哪些调度指向。调度发起的运行在卡片上同样显示运行中
  // （它不经前端发起，只体现在调度列表的 running 上）。
  const scheduledRunning = schedules.some((schedule) => schedule.running);
  const live = running || scheduledRunning;
  // 运行中点卡身：前端发起的回会话页回放这一轮，调度发起的去运行详情实时跟踪
  const openCurrent = running ? onOpen : onOpenScheduled;
  const cronSentence = (cron: string) => {
    try {
      return describeScheduleCron(parseScheduleCron(cron), t) ?? cron;
    } catch {
      return cron;
    }
  };
  const firstSchedule = schedules[0];

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={task.title}
      aria-expanded={expanded}
      title={expanded ? undefined : task.description || task.title}
      // 运行中：点卡身=回到这一轮（见 openCurrent）；闲时照旧展开
      onClick={live ? openCurrent : onToggleExpand}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (live) openCurrent(); else onToggleExpand(); }
        if (e.key === "Escape" && expanded) { e.preventDefault(); onCollapse(); }
      }}
      data-running={live || undefined}
      data-expanded={expanded || undefined}
      style={{ "--amb": amb } as CSSProperties}
      className={`dual-card group relative flex cursor-pointer flex-col rounded-lg border border-border p-3.5
        transition-[border-color,box-shadow,background-color] duration-150 ease-out
        ${expanded ? "col-span-2 gap-3.5 p-5" : "gap-2.5"}
        focus-visible:outline-none`}
    >
      {live && <RunningFlow />}

      <StatusRail level={level} score={score} />

      {/* —— 紧凑态：身份 —— */}
      {!expanded && (
        <>
          <div className="flex items-center gap-2.5">
            <span className="dual-hub flex size-8 shrink-0 items-center justify-center rounded-lg">
              <ActionIcon name={icon} className="size-4" />
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[13.5px] font-semibold leading-tight -tracking-[0.01em]">
              {task.title}
            </span>
            <PresetDots count={presets.length} />
          </div>
          <span className="truncate text-xs leading-relaxed text-muted-foreground">
            {task.description || <span className="text-muted-foreground/50">{task.id}</span>}
          </span>
          {/* 调度投影（紧凑态一行）：有定时才出现——cron 句子 + 启停；多条时标出条数 */}
          {firstSchedule && (
            <span className="flex items-center gap-1.5 font-mono text-[10.5px] tracking-[0.02em] text-muted-foreground">
              <HugeiconsIcon icon={Calendar03Icon} strokeWidth={1.75} className="size-3 shrink-0" />
              <span className="truncate">{cronSentence(firstSchedule.cron)}</span>
              {schedules.length > 1 && <span>+{schedules.length - 1}</span>}
              {!schedules.some((schedule) => schedule.enabled) && (
                <span className="shrink-0 text-muted-foreground/60">{t("scheduler.disabledLabel")}</span>
              )}
            </span>
          )}
          <div className="mt-auto flex items-center justify-end border-t border-dashed
            border-[color-mix(in_oklab,var(--amb)_30%,var(--border))] pt-2
            font-mono text-[10px] tracking-[0.06em] uppercase">
            {live ? (
              // 读数态仍可点：focusAi 切回会话页（这一轮的输出在捕获里，可回放）
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); openCurrent(); }}
                className="flex cursor-pointer items-center gap-1.5 font-mono text-[10px] tracking-[0.06em] text-primary"
              >
                <span className="size-1.5 rounded-full bg-primary live-pulse" />
                {t("workflow.running")} ▸
              </button>
            ) : (
              <QuickHint label={t("grid.run")} onClick={onRun} />
            )}
          </div>
        </>
      )}

      {/* —— 展开态：意图 —— */}
      {expanded && (
        <>
          <div className="flex items-center gap-3">
            <span className="dual-hub flex size-10 shrink-0 items-center justify-center rounded-[27.5%]">
              <ActionIcon name={icon} className="size-5" />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-mono text-base font-bold leading-tight -tracking-[0.01em] break-all">
                {task.title}
              </span>
              <span className="truncate font-mono text-[11px] tracking-[0.015em] text-muted-foreground">
                {group} · {task.id}
              </span>
            </span>
          </div>
          <NarrativeZone stamp={last && !live && !Number.isNaN(lastAt) ? narrativeStamp(lastAt) : undefined}>
            {summary}
          </NarrativeZone>
          {/* 调度投影（展开态）：每条所属调度一行——cron 句子 / 启停 / 最近结果（点进运行详情）。
              点行身编辑该调度。 */}
          <div className="grid gap-1">
            {schedules.map((schedule) => (
              <ScheduleProjection
                key={schedule.id}
                schedule={schedule}
                sentence={cronSentence(schedule.cron)}
                onEdit={() => onEditSchedule(schedule)}
                onViewRun={onViewRun}
              />
            ))}
          </div>
          <div className="mt-auto flex flex-wrap items-center gap-2.5 border-t border-dashed
            border-[color-mix(in_oklab,var(--amb)_30%,var(--border))] pt-3.5">
            <PresetChips presets={presets} onChoose={onOpenPreset} />
            <GhostBtn
              label={t("aiGrid.schedule")}
              onClick={onNewSchedule}
              icon={<HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} className="size-3" />}
            />
            <GhostBtn
              label={t("grid.editConfig")}
              onClick={onEditYaml}
              icon={<HugeiconsIcon icon={FirstBracketIcon} strokeWidth={2} className="size-3" />}
            />
            <GhostBtn
              label={t("grid.chat")}
              onClick={onOpen}
              icon={<HugeiconsIcon icon={AiChat02Icon} strokeWidth={2} className="size-3" />}
            />
            <RunPill
              label={t("grid.run")}
              running={live}
              runningLabel={t("workflow.running")}
              onClick={onRun}
            />
          </div>
        </>
      )}
    </div>
  );
}

// 调度投影行：一条指向该任务的调度。cron 句子 · 启停 / 下次 · 最近结果（可点进运行详情）；
// 上次到点被跳过时注明。行身可点 = 编辑这条调度。
function ScheduleProjection({
  schedule, sentence, onEdit, onViewRun,
}: {
  schedule: ScheduleItem;
  sentence: string;
  onEdit: () => void;
  onViewRun: (runId: string) => void;
}) {
  const { t } = useTranslation();
  const last = schedule.lastRun;
  const skip: ScheduleLastSkip | undefined = schedule.lastSkip ?? undefined;
  return (
    <div
      className="flex items-center gap-2.5 rounded-md border border-border bg-card/55 px-3 py-1.5
        font-mono text-[11.5px] tracking-[0.02em] text-muted-foreground"
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onEdit(); }}
        title={t("scheduler.edit", { name: schedule.name })}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-none bg-transparent p-0 text-left"
      >
        <HugeiconsIcon icon={Calendar03Icon} strokeWidth={1.75} className="size-3 shrink-0" />
        <span className="truncate text-foreground/85">{sentence}</span>
        <span className="shrink-0 text-muted-foreground/80">
          {schedule.running
            ? t("runs.status.running")
            : schedule.enabled ? t("scheduler.enabledLabel") : t("scheduler.disabledLabel")}
        </span>
      </button>
      {last?.runId ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onViewRun(last.runId!); }}
          title={t("scheduler.viewRun")}
          className={`shrink-0 cursor-pointer border-none bg-transparent p-0 underline-offset-2 hover:underline ${runTone(last?.status ?? "")}`}
        >
          {last.duration ? fmtGoDuration(last.duration) : t(`runs.status.${last.status}`, last.status)}
        </button>
      ) : (
        <span className="shrink-0">--</span>
      )}
      {skip && (
        <span className="shrink-0 text-muted-foreground/80" title={skip.reason}>
          ⤬ {t("scheduler.skippedShort")}
        </span>
      )}
    </div>
  );
}
