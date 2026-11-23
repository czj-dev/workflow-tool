import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { FirstBracketIcon } from "@hugeicons/core-free-icons";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";
import { useActionUsage, groupLabel, MISC_KEY, compareGroupKeys } from "../hooks/useActionUsage";
import { useLlmHistory } from "../hooks/useLlmHistory";
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
import type { ActionItem } from "../../bindings/workflow-tool/internal/api/models.js";

const EYEBROW =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

// LLM 卡片专属 grid：双态卡（ADR-0001）。❝叙述区 = 最近会话摘要（时间戳 + 展开变量后的
// 一句 prompt，无会话回落描述）；展开态 chips = 带预设进对话；单一主控 = 对话/对话中。
export function LlmGridView() {
  const { t } = useTranslation();
  const { actions, openLlmChat, focusRunning, isRunning, openYamlEditor } = useActionRunner();
  const { groupByPrefix, footprintLevel, getScore, topActions } = useActionUsage("llm-usage");
  // 双态：同视图内至多一张展开卡
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const llmActions = actions.filter((a) => a.llm);
  const groups = groupByPrefix(llmActions);
  const groupEntries = Object.entries(groups).sort(([a], [b]) => compareGroupKeys(a, b));

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <h1 className="text-sm font-semibold">{t("llmGrid.title")}</h1>
        </div>
        <span className="font-mono text-[11px] tracking-[0.14em] uppercase text-muted-foreground">
          {t("grid.itemsCount", { count: llmActions.length })}
          {" · "}
          {t("grid.groupsCount", { count: groupEntries.length })}
        </span>
      </header>
      <div className="p-4 space-y-6">
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
                {topActions(items, items.length).map((action) => (
                  <LlmCard
                    key={action.id}
                    action={action}
                    group={key === MISC_KEY ? "misc" : key}
                    amb={ambColorFor(action.color) ?? ambFor(groupIndex)}
                    running={isRunning(action.id)}
                    level={footprintLevel(action.id)}
                    score={getScore(action.id)}
                    expanded={expandedId === action.id}
                    onToggleExpand={() =>
                      setExpandedId((cur) => (cur === action.id ? null : action.id))
                    }
                    onCollapse={() =>
                      setExpandedId((cur) => (cur === action.id ? null : cur))
                    }
                    onOpen={() =>
                      isRunning(action.id)
                        ? focusRunning(action.id, "llm-chat")
                        : openLlmChat(action.id)
                    }
                    onOpenPreset={(name) => openLlmChat(action.id, name)}
                    onEditYaml={() => openYamlEditor(action.id, "action")}
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

// ponytail: 单一消费者，内联不外抽。
interface LlmCardProps {
  action: ActionItem;
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
  onEditYaml: () => void;
}

function LlmCard({
  action, group, amb, running, level, score, expanded, onToggleExpand, onCollapse, onOpen, onOpenPreset, onEditYaml,
}: LlmCardProps) {
  const { t } = useTranslation();
  const { entries } = useLlmHistory(action.id); // 倒序：最新在前
  const presets = action.presets ?? [];
  const last = entries[0];
  // ❝ 摘要：最近会话 prompt 展开变量后一句话；无会话回落描述。运行中切实时读数。
  const summary = running
    ? t("llmChat.liveSummary")
    : last
      ? expandVars(last.prompt, last.params)
      : action.description || action.id;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={action.title}
      aria-expanded={expanded}
      title={expanded ? undefined : action.description || action.title}
      onClick={onToggleExpand}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleExpand(); }
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
              <ActionIcon name={action.icon} className="size-4" />
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[13.5px] font-semibold leading-tight -tracking-[0.01em]">
              {action.title}
            </span>
            <PresetDots count={presets.length} />
          </div>
          <span className="truncate text-xs leading-relaxed text-muted-foreground">
            {action.description || <span className="text-muted-foreground/50">{action.id}</span>}
          </span>
          <div className="mt-auto flex items-center justify-end border-t border-dashed
            border-[color-mix(in_oklab,var(--amb)_30%,var(--border))] pt-2
            font-mono text-[10px] tracking-[0.06em] uppercase">
            {running ? (
              // 读数态仍可点：focusRunning 切回聊天页（会话还在流式输出）
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onOpen(); }}
                className="flex cursor-pointer items-center gap-1.5 font-mono text-[10px] tracking-[0.06em] text-primary"
              >
                <span className="size-1.5 rounded-full bg-primary live-pulse" />
                {t("grid.chatting")} ▸
              </button>
            ) : (
              <QuickHint label={t("grid.chat")} onClick={onOpen} />
            )}
          </div>
        </>
      )}

      {/* —— 展开态：意图 —— */}
      {expanded && (
        <>
          <div className="flex items-center gap-3">
            <span className="dual-hub flex size-10 shrink-0 items-center justify-center rounded-[27.5%]">
              <ActionIcon name={action.icon} className="size-5" />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-mono text-base font-bold leading-tight -tracking-[0.01em] break-all">
                {action.title}
              </span>
              <span className="truncate font-mono text-[11px] tracking-[0.015em] text-muted-foreground">
                {group} · {action.id}
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
            <RunPill
              label={t("grid.chat")}
              running={running}
              runningLabel={t("grid.chatting")}
              onClick={onOpen}
            />
          </div>
        </>
      )}
    </div>
  );
}
