import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { ButtonGroup } from "@/components/ui/button-group";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useActionRunner } from "../hooks/useActionRunner";
import { fmtDuration } from "../lib/duration";
import type { WorkflowStepState } from "../types/events";
import { ActionIcon } from "./ActionIcon";
import { IconButton } from "./IconButton";
import { OutputLines } from "./OutputLines";
import {
  ArrowLeft01Icon,
  ArrowReloadHorizontalIcon,
  Cancel01Icon,
  PreferenceHorizontalIcon,
} from "@hugeicons/core-free-icons";

// step status → i18n key 映射
const STATUS_I18N: Record<WorkflowStepState["status"], string> = {
  pending: "workflow.stepPending",
  running: "workflow.stepRunning",
  done: "workflow.stepDone",
  error: "workflow.stepError",
  skipped: "workflow.stepSkipped",
};

// 仪表带光柱分段：段 = 步骤，填充 = 进度（结构即信息，与 TickRuler 同语言）
const SEG_CLS: Record<WorkflowStepState["status"], string> = {
  pending: "h-1.5 self-center bg-foreground/10",
  running: "self-stretch spine-flow-h",
  done: "h-1.5 self-center bg-success/80",
  error: "h-1.5 self-center bg-destructive",
  skipped: "h-1.5 self-center bg-foreground/25",
};

// 合并后的步骤视图：定义态（name）+ 运行态（status/lines/exitCode/耗时打点）
interface StepView {
  index: number;
  name: string;
  status: WorkflowStepState["status"];
  exitCode?: number;
  lines: string[];
  startedAt?: number;
  endedAt?: number;
}

// Pipeline Spine：定义态步骤全部预展示，运行态状态覆盖（无运行态→pending）。
// spine 列 mb 撑大 row，使 spine 线贯穿到下一节点（视觉连续）。
// 头部仪表带 = 签名元素：分段进度光柱 + 当前步/总步读数 + 总耗时（运行中 live 递增）。
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
  const steps: StepView[] =
    defined.length > 0
      ? defined.map((info, i) => {
          const st = workflowSteps.find((s) => s.index === i);
          return {
            index: i,
            name:
              info.name ||
              (info.kind === "sleep"
                ? t("workflow.stepSleep", {
                    seconds: info.label.replace(/s$/, ""),
                  })
                : info.label),
            status: st?.status ?? "pending",
            exitCode: st?.exitCode,
            lines: st?.lines ?? [],
            startedAt: st?.startedAt,
            endedAt: st?.endedAt,
          };
        })
      : workflowSteps.map((s) => ({
          index: s.index,
          name: t("workflow.step", { index: s.index + 1 }),
          status: s.status,
          exitCode: s.exitCode,
          lines: s.lines,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
        }));

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
          <div className="flex flex-col">
            {steps.map((step, i) => {
              const last = i === steps.length - 1;
              const st = step.status;
              const nodeCls = {
                pending: "size-2 bg-transparent border-2 border-muted-foreground/40",
                running:
                  "size-2.5 bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_22%,transparent)] live-pulse",
                done: "size-2 bg-success",
                error: "size-2 bg-destructive",
                skipped:
                  "size-2 bg-transparent border-2 border-dashed border-muted-foreground/40 opacity-50",
              }[st];
              const lineCls = {
                pending: "spine-pending",
                running: "spine-running",
                done: "bg-border",
                error: "bg-border",
                skipped: "spine-pending opacity-50",
              }[st];
              const badgeCls = {
                pending: "text-muted-foreground",
                running: "border-primary/40 text-primary bg-primary/10",
                done: "border-success/40 text-success bg-success/10",
                error: "border-destructive/40 text-destructive bg-destructive/10",
                skipped: "border-dashed text-muted-foreground opacity-70",
              }[st];
              // 耗时读数：终态取打点差值，运行态用 ticker 当前时刻 live 递增
              const durMs =
                step.startedAt !== undefined
                  ? (step.endedAt ?? (running ? now : step.startedAt)) - step.startedAt
                  : undefined;
              return (
                <div key={step.index} className="flex gap-3.5">
                  {/* spine 列：节点 + 连线，self-stretch 拉满 row 高度 */}
                  <div className="flex w-4 flex-none flex-col items-center self-stretch">
                    <span className={cn("mt-1 rounded-full", nodeCls)} />
                    {!last && (
                      <span
                        className={cn("my-1 w-0.5 flex-1 rounded-full", lineCls)}
                      />
                    )}
                  </div>
                  {/* content 列：mb-3 撑大 row，让 spine 线贯穿到下一节点 */}
                  <div className="mb-3 min-w-0 flex-1">
                    <Collapsible defaultOpen={st === "running" || st === "error"}>
                      <Card
                        className={cn(
                          "overflow-hidden p-0",
                          st === "skipped" && "border-dashed opacity-60",
                        )}
                      >
                        <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-muted/50">
                          <span className="font-mono text-xs text-muted-foreground">
                            {String(step.index + 1).padStart(2, "0")}
                          </span>
                          <span className="flex-1 truncate text-left text-sm font-medium">
                            {step.name}
                          </span>
                          {durMs !== undefined && st !== "skipped" && (
                            <span
                              className={cn(
                                "font-mono text-xs tabular-nums",
                                st === "running"
                                  ? "text-primary"
                                  : "text-muted-foreground",
                              )}
                            >
                              {fmtDuration(durMs)}
                            </span>
                          )}
                          {st === "error" && step.exitCode !== undefined && (
                            <span className="font-mono text-xs text-destructive">
                              exit {step.exitCode}
                            </span>
                          )}
                          <Badge
                            variant="outline"
                            className={cn("font-mono uppercase", badgeCls)}
                          >
                            {t(STATUS_I18N[st])}
                          </Badge>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          {step.lines.length > 0 && (
                            <pre
                              className={cn(
                                "max-h-48 overflow-auto whitespace-pre-wrap border-t bg-background px-4 py-2 font-mono text-xs leading-relaxed text-foreground",
                                st === "running" && "border-primary/60",
                              )}
                            >
                              {/* 与 action 的 OutputConsole 共用行渲染：stderr 着色语义一致 */}
                              <OutputLines lines={step.lines} />
                            </pre>
                          )}
                        </CollapsibleContent>
                      </Card>
                    </Collapsible>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </main>
  );
}
