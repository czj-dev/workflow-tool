import { useTranslation } from "react-i18next";
import { Edit02Icon } from "@hugeicons/core-free-icons";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { IconButton } from "./IconButton";
import { useActionRunner } from "../hooks/useActionRunner";
import {
  useActionUsage,
  groupLabel,
  FOOTPRINT_SEGMENTS,
  MISC_KEY,
} from "../hooks/useActionUsage";
import { ActionIcon } from "./ActionIcon";
import type { WorkflowItem as WorkflowItemType } from "../../bindings/workflow-tool/internal/api/models.js";

// 等宽大写 eyebrow(与 ActionsGridView 一致)
const EYEBROW =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

// Grid 页:按 id 前缀分组展示所有 workflow。点卡片 = 有参进表单 / 无参直接运行;右上 ✎ 进表单。
export function WorkflowsGridView() {
  const { t } = useTranslation();
  const { workflows, runWorkflow, selectWorkflow, runningWorkflowId } =
    useActionRunner();
  const { groupByPrefix, footprintLevel, recordUsage } =
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
        {groupEntries.map(([key, items]) => (
          <section key={key}>
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
              {items.map((wf) => (
                <WorkflowCard
                  key={wf.id}
                  workflow={wf}
                  running={runningWorkflowId === wf.id}
                  level={footprintLevel(wf.id)}
                  onRun={(params) => {
                    runWorkflow(wf.id, params);
                    recordUsage(wf.id);
                  }}
                  onEdit={() => selectWorkflow(wf.id)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

// ——— 内联 WorkflowCard ———
// 与 ActionCard 同构,去掉 preset(workflow 无 preset 概念),元信息换成 步骤数/参数数。
interface WorkflowCardProps {
  workflow: WorkflowItemType;
  running: boolean;
  level: number; // 足迹亮段数 0-5
  onRun: (params: Record<string, string>) => void;
  onEdit: () => void;
}

function WorkflowCard({
  workflow,
  running,
  level,
  onRun,
  onEdit,
}: WorkflowCardProps) {
  const { t } = useTranslation();
  const hasParams = (workflow.params?.length ?? 0) > 0;
  const stepCount = workflow.steps?.length ?? 0;

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
      className={`
        group relative flex flex-col gap-2.5 rounded-lg border p-3.5 cursor-pointer
        transition-all duration-150 ease-out
        hover:border-primary/55 hover:-translate-y-0.5 hover:shadow-[0_4px_20px_-8px] hover:shadow-primary/40
        ${running ? "border-primary" : "border-border"}
      `}
    >
      {running && (
        <span className="pointer-events-none absolute inset-[-1px] rounded-lg border border-primary/60 animate-pulse" />
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/14 text-primary">
            <ActionIcon name={workflow.icon || "hi:workflow"} className="size-4" />
          </span>
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
        {hasParams && (
          <span className="opacity-0 group-hover:opacity-100 transition-opacity">
            <IconButton
              icon={Edit02Icon}
              label={t("grid.editParams")}
              onClick={(e) => {
                e?.stopPropagation?.();
                onEdit();
              }}
            />
          </span>
        )}
      </div>

      <span className="font-mono text-sm font-semibold leading-tight tracking-[0.02em]">
        {workflow.title}
      </span>

      {workflow.description && (
        <span className="text-xs leading-relaxed text-muted-foreground line-clamp-2">
          {workflow.description}
        </span>
      )}

      <div
        className="flex items-center justify-between gap-2 border-t border-dashed border-border pt-2 mt-auto
        font-mono text-[10px] tracking-[0.06em] uppercase text-muted-foreground"
      >
        <span className="rounded bg-muted px-1.5 py-0.5 opacity-70 text-foreground">
          {t("grid.stepsCount", { count: stepCount })}
          {hasParams
            ? ` · ${t("grid.paramsCount", { count: workflow.params!.length })}`
            : ` · ${t("grid.noParams")}`}
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
