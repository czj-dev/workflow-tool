import { useTranslation } from "react-i18next";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";
import { useActionUsage, groupLabel, MISC_KEY } from "../hooks/useActionUsage";
import { ActionIcon } from "./ActionIcon";
import { TickRuler, StatusRail, ParamSummary, RunningFlow } from "./GridCardParts";
import type { ActionItem } from "../../bindings/workflow-tool/internal/api/models.js";

const EYEBROW =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

// LLM 卡片专属 grid：只展示 command.llm 形态动作，点卡片进聊天页空态（不直接运行）。
export function LlmGridView() {
  const { t } = useTranslation();
  const { actions, openLlmChat, focusRunning, isRunning } = useActionRunner();
  const { groupByPrefix, footprintLevel, getScore, topActions } = useActionUsage("llm-usage");

  const llmActions = actions.filter((a) => a.llm);
  const groups = groupByPrefix(llmActions);
  const groupEntries = Object.entries(groups).sort(([a], [b]) => {
    if (a === MISC_KEY) return 1;
    if (b === MISC_KEY) return -1;
    return a.localeCompare(b);
  });

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
        {groupEntries.map(([key, items]) => {
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
                {topActions(items, items.length).map((action) => {
                  const running = isRunning(action.id);
                  return (
                    <LlmCard
                      key={action.id}
                      action={action}
                      running={running}
                      level={footprintLevel(action.id)}
                      score={getScore(action.id)}
                      onOpen={() =>
                        running ? focusRunning(action.id, "llm-chat") : openLlmChat(action.id)
                      }
                    />
                  );
                })}
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
  running: boolean;
  level: number;
  score: number;
  onOpen: () => void;
}

function LlmCard({ action, running, level, score, onOpen }: LlmCardProps) {
  const { t } = useTranslation();
  const paramIds = action.params?.map((p) => p.id) ?? [];
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      data-running={running || undefined}
      className={`group relative flex flex-col gap-2.5 rounded-lg border p-3.5 cursor-pointer bg-card transition-colors duration-150 ease-out hover:border-primary/55 hover:shadow-[inset_0_0_0_1px] hover:shadow-primary/30 focus-visible:outline-none focus-visible:border-primary/55 ${running ? "border-primary" : "border-border"}`}
    >
      {running && <RunningFlow />}
      <StatusRail level={level} score={score} />
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/14 text-primary">
          <ActionIcon name={action.icon} className="size-4" />
        </span>
        <span className="font-mono text-[13.5px] font-semibold leading-tight -tracking-[0.01em] break-all">
          {action.title}
        </span>
      </div>
      {action.description && (
        <span className="text-xs leading-relaxed text-muted-foreground line-clamp-2 group-hover:line-clamp-none group-focus-within:line-clamp-none">
          {action.description}
        </span>
      )}
      {paramIds.length > 0 && <ParamSummary ids={paramIds} />}
      <div className="flex items-center justify-between gap-2 border-t border-dashed border-border pt-2 mt-auto font-mono text-[10px] tracking-[0.06em] uppercase text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 opacity-70 text-foreground tabular-nums">
          {action.params?.length
            ? t("grid.paramsCount", { count: action.params.length })
            : t("grid.noParams")}
        </span>
        {running ? (
          <span className="flex items-center gap-1.5 text-primary normal-case tracking-normal">
            <span className="size-1.5 rounded-full bg-primary live-pulse" />
            running
          </span>
        ) : (
          <span className="text-primary tracking-[0.14em] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            ▸ {t("main.choose")}
          </span>
        )}
      </div>
    </div>
  );
}
