import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { fmtDuration } from "../lib/duration";
import { STEP_STATUS_I18N, type StepView } from "../lib/workflowSteps";
import type { WorkflowStepState } from "../types/events";
import { AiOutputPanel } from "@/components/ai/AiOutputPanel";
import { OutputLines } from "./OutputLines";

// 步骤卡的内容区：
//   - AI 步骤（有工序段）：回复 / 思考 / 工具调用以工序段面板呈现（与 AI 会话页同一套
//     渲染，只是不带头部的指令工单与终点读数），stdout/stderr 诊断行另起一块；
//   - 其余步骤：文本输出行（与 action 的 OutputConsole 共用行渲染，stderr 着色语义一致）。
function StepBody({ step, live }: { step: StepView; live: boolean }) {
  if (step.aiPanel) {
    return (
      <div className={cn("border-t bg-background px-4 py-3", live && "border-primary/60")}>
        <AiOutputPanel prompt="" state={step.aiPanel} footer={false} />
        {step.lines.length > 0 && (
          <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2.5 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
            <OutputLines lines={step.lines} />
          </pre>
        )}
      </div>
    );
  }
  if (step.lines.length === 0) return null;
  return (
    <pre
      className={cn(
        "max-h-48 overflow-auto whitespace-pre-wrap border-t bg-background px-4 py-2 font-mono text-xs leading-relaxed text-foreground",
        live && "border-primary/60",
      )}
    >
      <OutputLines lines={step.lines} />
    </pre>
  );
}

// 步骤卡的开合是受控的。base-ui 的非受控 defaultOpen 只在首次挂载时生效，而步骤卡总是
// 以 pending 态先挂载——running / 出错 / 拿到工序段都发生在之后，所以「默认展开」得自己盯：
// wantOpen 为真时自动展开；用户点过之后以其选择为准，直到它又与默认一致时回到跟随默认。
function StepCollapsible({ wantOpen, children }: { wantOpen: boolean; children: ReactNode }) {
  const [override, setOverride] = useState<boolean | null>(null);
  return (
    <Collapsible
      open={override ?? wantOpen}
      onOpenChange={(open) => setOverride(open === wantOpen ? null : open)}
    >
      {children}
    </Collapsible>
  );
}

const NODE_CLS: Record<WorkflowStepState["status"], string> = {
  pending: "size-2 bg-transparent border-2 border-muted-foreground/40",
  running: "size-2.5 bg-primary shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_22%,transparent)] live-pulse",
  done: "size-2 bg-success",
  error: "size-2 bg-destructive",
  skipped: "size-2 bg-transparent border-2 border-dashed border-muted-foreground/40 opacity-50",
};

const LINE_CLS: Record<WorkflowStepState["status"], string> = {
  pending: "spine-pending",
  running: "spine-running",
  done: "bg-border",
  error: "bg-border",
  skipped: "spine-pending opacity-50",
};

const BADGE_CLS: Record<WorkflowStepState["status"], string> = {
  pending: "text-muted-foreground",
  running: "border-primary/40 text-primary bg-primary/10",
  done: "border-success/40 text-success bg-success/10",
  error: "border-destructive/40 text-destructive bg-destructive/10",
  skipped: "border-dashed text-muted-foreground opacity-70",
};

/**
 * Pipeline Spine 的步骤列表：spine 列（节点 + 连线）+ 步骤卡（序号 / 名称 / 耗时 /
 * 退出码 / 状态徽标 / 输出）。实时的 WorkflowView 与运行详情回放共用——回放只是把
 * 时刻换成运行日志里的偏移。now 是 ticker 的当前时刻（运行中的步骤耗时 live 递增）。
 */
export function WorkflowStepList({ steps, running, now }: { steps: StepView[]; running: boolean; now: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col">
      {steps.map((step, i) => {
        const last = i === steps.length - 1;
        const st = step.status;
        // 耗时读数：终态取打点差值，运行态用 ticker 当前时刻 live 递增
        const durMs =
          step.startedAt !== undefined
            ? (step.endedAt ?? (running ? now : step.startedAt)) - step.startedAt
            : undefined;
        return (
          <div key={step.index} className="flex gap-3.5">
            {/* spine 列：节点 + 连线，self-stretch 拉满 row 高度 */}
            <div className="flex w-4 flex-none flex-col items-center self-stretch">
              <span className={cn("mt-1 rounded-full", NODE_CLS[st])} />
              {!last && <span className={cn("my-1 w-0.5 flex-1 rounded-full", LINE_CLS[st])} />}
            </div>
            {/* content 列：mb-3 撑大 row，让 spine 线贯穿到下一节点 */}
            <div className="mb-3 min-w-0 flex-1">
              {/* AI 步骤与出错步骤默认展开；其余要点开才看输出 */}
              <StepCollapsible wantOpen={st === "running" || st === "error" || !!step.aiPanel}>
                <Card className={cn("overflow-hidden p-0", st === "skipped" && "border-dashed opacity-60")}>
                  <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-muted/50">
                    <span className="font-mono text-xs text-muted-foreground">
                      {String(step.index + 1).padStart(2, "0")}
                    </span>
                    <span className="flex-1 truncate text-left text-sm font-medium">
                      {step.name}
                    </span>
                    {durMs !== undefined && st !== "skipped" && (
                      <span className={cn("font-mono text-xs tabular-nums", st === "running" ? "text-primary" : "text-muted-foreground")}>
                        {fmtDuration(durMs)}
                      </span>
                    )}
                    {st === "error" && step.exitCode !== undefined && (
                      <span className="font-mono text-xs text-destructive">exit {step.exitCode}</span>
                    )}
                    <Badge variant="outline" className={cn("font-mono uppercase", BADGE_CLS[st])}>
                      {t(STEP_STATUS_I18N[st])}
                    </Badge>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <StepBody step={step} live={st === "running"} />
                  </CollapsibleContent>
                </Card>
              </StepCollapsible>
            </div>
          </div>
        );
      })}
    </div>
  );
}
