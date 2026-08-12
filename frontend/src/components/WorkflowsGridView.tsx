import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Edit02Icon } from "@hugeicons/core-free-icons";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";
import {
  useActionUsage,
  groupLabel,
  MISC_KEY,
} from "../hooks/useActionUsage";
import { ActionIcon } from "./ActionIcon";
import { TickRuler, StatusRail, ParamSummary, RunningFlow } from "./GridCardParts";
import type { WorkflowItem as WorkflowItemType } from "../../bindings/workflow-tool/internal/api/models.js";

// 等宽大写 eyebrow(与 ActionsGridView 一致)
const EYEBROW =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

// Grid 页:按 id 前缀分组展示所有 workflow。同构 ActionCard 布局，无 preset。
export function WorkflowsGridView() {
  const { t } = useTranslation();
  const { workflows, runWorkflow, selectWorkflow, runningWorkflowId } =
    useActionRunner();
  const { groupByPrefix, footprintLevel, getScore, recordUsage, topActions } =
    useActionUsage("workflow-usage");

  const groups = groupByPrefix(workflows);
  const groupEntries = Object.entries(groups).sort(([a], [b]) => {
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
          <h1 className="text-sm font-semibold">{t("grid.wfTitle")}</h1>
        </div>
        <span className="font-mono text-[11px] tracking-[0.14em] uppercase text-muted-foreground">
          {t("grid.itemsCount", { count: workflows.length })}
          {" · "}
          {t("grid.groupsCount", { count: groupCount })}
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
                {topActions(items, items.length).map((wf) => (
                  <WorkflowCard
                    key={wf.id}
                    workflow={wf}
                    running={runningWorkflowId === wf.id}
                    level={footprintLevel(wf.id)}
                    score={getScore(wf.id)}
                    onRun={(params, background) => {
                      runWorkflow(wf.id, params, background);
                      recordUsage(wf.id);
                    }}
                    onEdit={() => selectWorkflow(wf.id)}
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

// ——— 内联 WorkflowCard（与 ActionCard 同构，去掉 preset）———
interface WorkflowCardProps {
  workflow: WorkflowItemType;
  running: boolean;
  level: number;
  score: number;
  onRun: (params: Record<string, string>, background?: boolean) => void;
  onEdit: () => void;
}

function WorkflowCard({
  workflow,
  running,
  level,
  score,
  onRun,
  onEdit,
}: WorkflowCardProps) {
  const { t } = useTranslation();
  const hasParams = (workflow.params?.length ?? 0) > 0;
  const stepCount = workflow.steps?.length ?? 0;
  const paramIds = workflow.params?.map((p) => p.id) ?? [];

  const handleCardClick = () => {
    if (hasParams) {
      onEdit(); // 进 workflow-form
    } else {
      onRun({});
    }
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

      <StatusRail level={level} score={score} />

      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/14 text-primary">
          <ActionIcon name={workflow.icon || "hi:workflow"} className="size-4" />
        </span>
        <span className="font-mono text-[13.5px] font-semibold leading-tight -tracking-[0.01em] break-all">
          {workflow.title}
        </span>
      </div>

      {workflow.description && (
        <span className="text-xs leading-relaxed text-muted-foreground line-clamp-2 group-hover:line-clamp-none group-focus-within:line-clamp-none">
          {workflow.description}
        </span>
      )}

      {hasParams && <ParamSummary ids={paramIds} />}

      {/* 底部 read-out */}
      <div className="flex items-center justify-between gap-2 border-t border-dashed border-border pt-2 mt-auto
        font-mono text-[10px] tracking-[0.06em] uppercase text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 opacity-70 text-foreground tabular-nums">
          {t("grid.stepsCount", { count: stepCount })}
          {hasParams
            ? ` · ${t("grid.paramsCount", { count: workflow.params!.length })}`
            : ` · ${t("grid.noParams")}`}
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
            <button
              type="button"
              aria-label={hasParams ? t("grid.open") : t("grid.run")}
              title={hasParams ? t("grid.open") : t("grid.run")}
              onClick={(e) => {
                e.stopPropagation();
                if (hasParams) onEdit();
                else onRun({}, true);
              }}
              className="text-primary tracking-[0.14em] hover:opacity-70"
            >
              ▸ {hasParams ? t("grid.open") : t("grid.run")}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
