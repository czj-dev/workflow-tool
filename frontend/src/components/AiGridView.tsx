import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { AiChat02Icon, FirstBracketIcon } from "@hugeicons/core-free-icons";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useActionRunner } from "../hooks/useActionRunner";
import { useActionUsage, groupLabel, MISC_KEY, compareGroupKeys } from "../hooks/useActionUsage";
import { useAiHistory } from "../hooks/useAiHistory";
import { expandVars } from "../lib/vars";
import { ActionIcon } from "./ActionIcon";
import {
  TickRuler,
  StatusRail,
  RunningFlow,
  ambFor,
  ambColorFor,
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

// AI 任务专属 grid：双态卡（ADR-0001）。❝叙述区 = 最近会话摘要（时间戳 + 展开变量后的
// 一句 prompt，无会话回落描述）；展开态 chips = 带预设进会话页；运行在后台跑，要看会话
// 点卡片本体（或「对话」）。
export function AiGridView() {
  const { t } = useTranslation();
  const { aiTasks, aiErrors, focusAi, isAiRunning, openAiChat, runAi, openYamlEditor } = useActionRunner();
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
}

function AiCard({
  task, group, amb, running, level, score, expanded, onToggleExpand, onCollapse, onOpen, onOpenPreset, onRun, onEditYaml,
}: AiCardProps) {
  const { t } = useTranslation();
  const { entries } = useAiHistory(task.id); // 倒序：最新在前
  const presets = task.presets ?? [];
  const last = entries[0];
  const icon = task.icon || "hi:ai";
  // ❝ 摘要：最近会话 prompt 展开变量后一句话；无会话回落描述。运行中切实时读数。
  const summary = running
    ? t("aiChat.liveSummary")
    : last
      ? expandVars(last.prompt, last.params)
      : task.description || task.id;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={task.title}
      aria-expanded={expanded}
      title={expanded ? undefined : task.description || task.title}
      // 运行中：点卡身=回会话页（onOpen → focusAi，这一轮的输出可回放）；闲时照旧展开
      onClick={running ? onOpen : onToggleExpand}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (running) onOpen(); else onToggleExpand(); }
        if (e.key === "Escape" && expanded) { e.preventDefault(); onCollapse(); }
      }}
      data-running={running || undefined}
      data-expanded={expanded || undefined}
      style={{ "--amb": amb } as CSSProperties}
      className={`dual-card group relative flex cursor-pointer flex-col rounded-lg border border-border p-3.5
        transition-[border-color,box-shadow,background-color] duration-150 ease-out
        ${expanded ? "col-span-2 gap-3.5 p-5" : "gap-2.5"}
        focus-visible:outline-none`}
    >
      {running && <RunningFlow />}

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
          <div className="mt-auto flex items-center justify-end border-t border-dashed
            border-[color-mix(in_oklab,var(--amb)_30%,var(--border))] pt-2
            font-mono text-[10px] tracking-[0.06em] uppercase">
            {running ? (
              // 读数态仍可点：focusAi 切回会话页（这一轮的输出在捕获里，可回放）
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onOpen(); }}
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
          <NarrativeZone stamp={last && !running ? narrativeStamp(last.timestamp) : undefined}>
            {summary}
          </NarrativeZone>
          <div className="mt-auto flex flex-wrap items-center gap-2.5 border-t border-dashed
            border-[color-mix(in_oklab,var(--amb)_30%,var(--border))] pt-3.5">
            <PresetChips presets={presets} onChoose={onOpenPreset} />
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
              running={running}
              runningLabel={t("workflow.running")}
              onClick={onRun}
            />
          </div>
        </>
      )}
    </div>
  );
}
