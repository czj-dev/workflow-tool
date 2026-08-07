import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useActionRunner } from "../hooks/useActionRunner";
import type { WorkflowStepState } from "../types/events";
import { ActionIcon } from "./ActionIcon";
import { IconButton } from "./IconButton";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";

// step status → i18n key 映射
const STATUS_I18N: Record<WorkflowStepState["status"], string> = {
  pending: "workflow.stepPending",
  running: "workflow.stepRunning",
  done: "workflow.stepDone",
  error: "workflow.stepError",
  skipped: "workflow.stepSkipped",
};

// 合并后的步骤视图：定义态（name）+ 运行态（status/lines/exitCode）
interface StepView {
  index: number;
  name: string;
  status: WorkflowStepState["status"];
  exitCode?: number;
  lines: string[];
}

// Pipeline Spine：定义态步骤全部预展示，运行态状态覆盖（无运行态→pending）。
// 卡片复刻 mockup：序号(01) + 名称 + 状态 Badge + exitCode。线状态由该 step status 决定；
// content 列 mb 撑大 row，使 spine 线贯穿到下一节点（视觉连续）。
export function WorkflowView() {
  const { t } = useTranslation();
  const { workflows, currentId, workflowSteps, status, cancelWorkflow, setView } =
    useActionRunner();

  const current = workflows.find((w) => w.id === currentId);
  const currentTitle = current?.title;
  const defined = current?.steps ?? [];

  // 合并：定义态全展示，运行态状态覆盖
  const steps: StepView[] =
    defined.length > 0
      ? defined.map((info, i) => {
          const st = workflowSteps.find((s) => s.index === i);
          return {
            index: i,
            name:
              (info as { name?: string }).name ||
              (info.kind === "sleep"
                ? t("workflow.stepSleep", {
                    seconds: info.label.replace(/s$/, ""),
                  })
                : info.label),
            status: st?.status ?? "pending",
            exitCode: st?.exitCode,
            lines: st?.lines ?? [],
          };
        })
      : workflowSteps.map((s) => ({
          index: s.index,
          name: t("workflow.step", { index: s.index + 1 }),
          status: s.status,
          exitCode: s.exitCode,
          lines: s.lines,
        }));

  const isEmpty = steps.length === 0 && status !== "running";

  return (
    <main className="flex min-w-0 flex-1 flex-col">
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
          {status === "running" && (
            <span className="inline-flex items-center gap-1.5 font-mono text-xs text-primary">
              <span className="size-1.5 rounded-full bg-primary live-pulse" />
              {t("workflow.running")}
            </span>
          )}
        </div>
        <Button
          variant="destructive"
          size="sm"
          disabled={status !== "running"}
          onClick={cancelWorkflow}
        >
          {t("main.stop")}
        </Button>
      </header>

      {isEmpty ? (
        <Empty className="m-4">
          <EmptyDescription>{t("main.selectAction")}</EmptyDescription>
        </Empty>
      ) : (
        <ScrollArea className="flex-1 p-4">
          <div className="flex flex-col">
            {steps.map((step, i) => {
              const last = i === steps.length - 1;
              const st = step.status;
              const nodeCls = {
                pending: "bg-transparent border-2 border-muted-foreground/40",
                running:
                  "bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_22%,transparent)] live-pulse",
                done: "bg-success",
                error: "bg-destructive",
                skipped:
                  "bg-transparent border-2 border-dashed border-muted-foreground/40 opacity-50",
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
              return (
                <div key={step.index} className="flex gap-3.5">
                  {/* spine 列：节点 + 连线，self-stretch 拉满 row 高度 */}
                  <div className="flex w-4 flex-none flex-col items-center self-stretch">
                    <span className={cn("mt-1 size-2.5 rounded-full", nodeCls)} />
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
                              {step.lines.join("\n")}
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
