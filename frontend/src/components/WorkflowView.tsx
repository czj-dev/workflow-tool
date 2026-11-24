import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ButtonGroup } from "@/components/ui/button-group";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useActionRunner } from "../hooks/useActionRunner";
import { fmtDuration } from "../lib/duration";
import { mergeStepViews } from "../lib/workflowSteps";
import type { WorkflowStepState } from "../types/events";
import { ActionIcon } from "./ActionIcon";
import { IconButton } from "./IconButton";
import { WorkflowStepList } from "./WorkflowStepList";
import {
  ArrowLeft01Icon,
  ArrowReloadHorizontalIcon,
  Cancel01Icon,
  PreferenceHorizontalIcon,
} from "@hugeicons/core-free-icons";

// 仪表带光柱分段：段 = 步骤，填充 = 进度（结构即信息，与 TickRuler 同语言）
const SEG_CLS: Record<WorkflowStepState["status"], string> = {
  pending: "h-1.5 self-center bg-foreground/10",
  running: "self-stretch spine-flow-h",
  done: "h-1.5 self-center bg-success/80",
  error: "h-1.5 self-center bg-destructive",
  skipped: "h-1.5 self-center bg-foreground/25",
};

// Pipeline Spine：定义态步骤全部预展示，运行态状态覆盖（无运行态→pending）。
// spine 列 mb 撑大 row，使 spine 线贯穿到下一节点（视觉连续）。
// 头部仪表带 = 签名元素：分段进度光柱 + 当前步/总步读数 + 总耗时（运行中 live 递增）。
// 步骤卡本体在 WorkflowStepList（与运行详情回放共用）。
export function WorkflowView() {
  const { t } = useTranslation();
  const { workflows, currentId, workflowSteps, wfStartedAt, status, cancelWorkflow, setView, lastRunParams, rerun, editRerun } =
    useActionRunner();

  const current = workflows.find((w) => w.id === currentId);
  const currentTitle = current?.title;
  const defined = current?.steps ?? [];
  const running = status === "running";
  const canRerun = !running && !!current && currentId! in lastRunParams;
  const hasParams = (current?.params?.length ?? 0) > 0;

  // 合并：定义态全展示，运行态状态覆盖
  const steps = mergeStepViews(defined, workflowSteps, t);
  const isEmpty = steps.length === 0 && status !== "running";


  // ——— 仪表带读数 ———
  // 总 elapsed：运行中用 ticker 当前时刻，终态用最后一个 step 的 endedAt 打点
  // （全前端打点，自洽，不借道 exitInfo 规避跨 action/workflow 的归属歧义）
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== "running") return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  const total = steps.length;
  const runningIdx = steps.findIndex((s) => s.status === "running");
  const settledMax = steps.reduce(
    (m, s) => (s.status !== "pending" ? Math.max(m, s.index) : m),
    -1,
  );
  const cur = runningIdx >= 0 ? runningIdx + 1 : settledMax + 1;
  const lastEnded = steps.reduce((m, s) => Math.max(m, s.endedAt ?? 0), 0);
  const elapsedMs =
    wfStartedAt && lastEnded
      ? running
        ? now - wfStartedAt
        : lastEnded - wfStartedAt
      : wfStartedAt && running
        ? now - wfStartedAt
        : null;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <IconButton
            icon={ArrowLeft01Icon}
            label={t("sidebar.allWorkflows")}
            onClick={() => setView("workflows-grid")}
          />
          {/* 点击标题进入 yaml 编辑态；hover/icon 样式与 action OutputToolbar 一致 */}
          <button
            type="button"
            className="flex items-center gap-1.5 rounded px-1 font-semibold hover:bg-accent cursor-pointer"
            title={t("edit.tooltip")}
            onClick={() => currentId && setView("workflow-edit")}
          >
            <ActionIcon name={current?.icon || "hi:workflow"} />
            {currentTitle ?? t("sidebar.workflows")}
          </button>
        </div>
        <ButtonGroup>
          {canRerun && (
            <IconButton
              icon={ArrowReloadHorizontalIcon}
              label={t("main.rerun")}
              variant="outline"
              onClick={() => rerun(currentId!)}
            />
          )}
          {canRerun && hasParams && (
            <IconButton
              icon={PreferenceHorizontalIcon}
              label={t("main.editRerun")}
              variant="outline"
              onClick={() => editRerun(currentId!)}
            />
          )}
          <IconButton
            icon={Cancel01Icon}
            label={t("main.stop")}
            variant="destructive"
            disabled={!running}
            onClick={cancelWorkflow}
          />
        </ButtonGroup>
      </header>

      {/* 管线仪表带：eyebrow + 当前步/总步 + 分段光柱 + 总耗时。
          running 段略高于其余段（当前游标），流光与 spine 连线同一动效语言。 */}
      {!isEmpty && (
        <div className="flex items-center gap-3 border-b bg-muted/30 px-4 py-2">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
            {t("workflow.progressLabel")}
          </span>
          <span className="font-mono text-xs font-semibold tabular-nums text-foreground/80">
            {String(cur).padStart(2, "0")}/{String(total).padStart(2, "0")}
          </span>
          <div
            className="flex h-2 min-w-0 flex-1 items-center gap-[3px]"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={total}
            aria-valuenow={Math.min(Math.max(cur, 1), total)}
          >
            {steps.map((step) => (
              <span
                key={step.index}
                className={cn("min-w-0.5 flex-1 overflow-hidden rounded-full", SEG_CLS[step.status])}
              />
            ))}
          </div>
          {elapsedMs !== null && (
            <span
              className={cn(
                "font-mono text-xs font-semibold tabular-nums",
                running
                  ? "text-primary"
                  : status === "error"
                    ? "text-destructive"
                    : "text-success",
              )}
            >
              {fmtDuration(elapsedMs)}
            </span>
          )}
        </div>
      )}

      {isEmpty ? (
        <Empty className="m-4">
          <EmptyDescription>{t("main.selectAction")}</EmptyDescription>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1 p-4">
          <WorkflowStepList steps={steps} running={running} now={now} />
        </ScrollArea>
      )}
    </main>
  );
}
