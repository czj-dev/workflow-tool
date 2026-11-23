import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Edit02Icon, FirstBracketIcon } from "@hugeicons/core-free-icons";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";
import {
  useActionUsage,
  groupLabel,
  MISC_KEY,
  compareGroupKeys,
} from "../hooks/useActionUsage";
import { hasFormFields } from "../lib/params";
import { ActionIcon } from "./ActionIcon";
import {
  TickRuler,
  StatusRail,
  RunningFlow,
  ambFor,
  NarrativeZone,
  GhostBtn,
  RunPill,
  QuickHint,
} from "./GridCardParts";
import type { WorkflowItem as WorkflowItemType } from "../../bindings/workflow-tool/internal/api/models.js";

// 等宽大写 eyebrow(与 ActionsGridView 一致)
const EYEBROW =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

// Grid 页:按 id 前缀分组展示所有 workflow。双态卡（ADR-0001）：
// 紧凑态只承身份，单击就地展开（span 2 reflow）；展开态承意图——❝描述 + 编辑表单 + RUN 主控。
// steps/params 读数已按渐进披露原则移出卡面。
export function WorkflowsGridView() {
  const { t } = useTranslation();
  const { workflows, runWorkflow, selectWorkflow, runningWorkflowId, openYamlEditor } =
    useActionRunner();
  const { groupByPrefix, footprintLevel, getScore, topActions } =
    useActionUsage("workflow-usage");
  // 双态：同视图内至多一张展开卡（再点其他卡即切换）
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const groups = groupByPrefix(workflows);
  const groupEntries = Object.entries(groups).sort(([a], [b]) => compareGroupKeys(a, b));
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
                {topActions(items, items.length).map((wf) => (
                  <WorkflowCard
                    key={wf.id}
                    workflow={wf}
                    group={key === MISC_KEY ? "misc" : key}
                    amb={ambFor(groupIndex)}
                    running={runningWorkflowId === wf.id}
                    level={footprintLevel(wf.id)}
                    score={getScore(wf.id)}
                    expanded={expandedId === wf.id}
                    onToggleExpand={() =>
                      setExpandedId((cur) => (cur === wf.id ? null : wf.id))
                    }
                    onCollapse={() =>
                      setExpandedId((cur) => (cur === wf.id ? null : cur))
                    }
                    onRun={(params, background) => {
                      runWorkflow(wf.id, params, background);
                    }}
                    onEdit={() => selectWorkflow(wf.id)}
                    onEditYaml={() => openYamlEditor(wf.id, "workflow")}
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

// ——— 内联 WorkflowCard（双态卡；紧凑=身份，展开=意图）———
interface WorkflowCardProps {
  workflow: WorkflowItemType;
  group: string;
  /** 基础氛围色（按分组显示序循环）；运行时由卡内覆写为 primary */
  amb: string;
  running: boolean;
  level: number;
  score: number;
  expanded: boolean;
  onToggleExpand: () => void;
  onCollapse: () => void;
  onRun: (params: Record<string, string>, background?: boolean) => void;
  onEdit: () => void;
  onEditYaml: () => void;
}

function WorkflowCard({
  workflow,
  group,
  amb,
  running,
  level,
  score,
  expanded,
  onToggleExpand,
  onCollapse,
  onRun,
  onEdit,
  onEditYaml,
}: WorkflowCardProps) {
  const { t } = useTranslation();
  const hasParams = (workflow.params?.length ?? 0) > 0;
  // 是否「值得进表单」：有必填且无默认值的项。RUN 按此分派进表单或直接运行。
  const showForm = hasFormFields(workflow.params);

  const toggle = () => onToggleExpand();
  const runPrimary = () => {
    if (showForm) onEdit(); // 必填缺默认：RUN=进表单补参（与侧边栏一致）
    else onRun({});
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={workflow.title}
      title={expanded ? undefined : workflow.description || workflow.title}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
        if (e.key === "Escape" && expanded) { e.preventDefault(); onCollapse(); }
      }}
      data-running={running || undefined}
      data-expanded={expanded || undefined}
      style={{ "--amb": running ? "var(--primary)" : amb } as CSSProperties}
      className={`dual-card group relative flex cursor-pointer flex-col rounded-lg border p-3.5
        transition-[border-color,box-shadow,background-color] duration-150 ease-out
        ${expanded ? "col-span-2 gap-3.5 p-5" : "gap-2.5"}
        hover:border-[color-mix(in_oklch,var(--amb)_55%,transparent)]
        focus-visible:border-[color-mix(in_oklch,var(--amb)_55%,transparent)] focus-visible:outline-none
        data-[expanded]:border-[color-mix(in_oklch,var(--amb)_40%,transparent)]
        ${running ? "border-primary" : "border-border"}`}
    >
      {running && <RunningFlow />}

      <StatusRail level={level} score={score} />

      {/* —— 紧凑态：身份 —— */}
      {!expanded && (
        <>
          <div className="flex items-center gap-2.5">
            <span className="dual-hub flex size-8 shrink-0 items-center justify-center rounded-lg">
              <ActionIcon name={workflow.icon || "hi:workflow"} className="size-4" />
            </span>
            <span className="font-mono text-[13.5px] font-semibold leading-tight -tracking-[0.01em] break-all line-clamp-2">
              {workflow.title}
            </span>
          </div>
          {workflow.description ? (
            <span className="truncate text-xs leading-relaxed text-muted-foreground">
              {workflow.description}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground/50">&nbsp;</span>
          )}
          <div className="mt-auto flex items-center justify-end gap-3 border-t border-dashed
            border-[color-mix(in_oklch,var(--amb)_30%,var(--border))] pt-2
            font-mono text-[10px] tracking-[0.06em] uppercase">
            {running ? (
              <span className="flex items-center gap-1.5 text-primary normal-case tracking-normal">
                <span className="size-1.5 rounded-full bg-primary live-pulse" />
                {t("workflow.running")}
              </span>
            ) : (
              <QuickHint
                label={showForm ? t("grid.open") : t("grid.run")}
                onClick={() => (showForm ? onEdit() : onRun({}, true))}
              />
            )}
          </div>
        </>
      )}

      {/* —— 展开态：意图 —— */}
      {expanded && (
        <>
          <div className="flex items-center gap-3">
            <span className="dual-hub flex size-10 shrink-0 items-center justify-center rounded-[27.5%]">
              <ActionIcon name={workflow.icon || "hi:workflow"} className="size-5" />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-mono text-base font-bold leading-tight -tracking-[0.01em] break-all">
                {workflow.title}
              </span>
              <span className="truncate font-mono text-[11px] tracking-[0.015em] text-muted-foreground">
                {group} · {workflow.id}
              </span>
            </span>
          </div>
          <NarrativeZone>
            {workflow.description || t("workflow.empty")}
          </NarrativeZone>
          <div className="mt-auto flex flex-wrap items-center gap-2.5 border-t border-dashed
            border-[color-mix(in_oklch,var(--amb)_30%,var(--border))] pt-3.5">
            {hasParams && (
              <GhostBtn
                label={t("grid.editForm")}
                onClick={onEdit}
                icon={<HugeiconsIcon icon={Edit02Icon} strokeWidth={2} className="size-3" />}
              />
            )}
            <GhostBtn
              label={t("grid.editConfig")}
              onClick={onEditYaml}
              icon={<HugeiconsIcon icon={FirstBracketIcon} strokeWidth={2} className="size-3" />}
            />
            <RunPill
              label={t("grid.run")}
              running={running}
              runningLabel={t("workflow.running")}
              onClick={runPrimary}
            />
          </div>
        </>
      )}
    </div>
  );
}
