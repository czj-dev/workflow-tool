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
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Loading03Icon,
  Tick02Icon,
  Cancel01Icon,
  Clock01Icon,
} from "@hugeicons/core-free-icons";
import { useActionRunner } from "../hooks/useActionRunner";

const STATUS_ICON = {
  pending: Clock01Icon,
  running: Loading03Icon,
  done: Tick02Icon,
  error: Cancel01Icon,
} as const;

// step status → i18n key 映射
const STATUS_I18N = {
  pending: "workflow.stepPending",
  running: "workflow.stepRunning",
  done: "workflow.stepDone",
  error: "workflow.stepError",
} as const;

// Workflow 工具链 timeline：分步输出，可展开/折叠每步日志
export function WorkflowView() {
  const { t } = useTranslation();
  const { workflows, currentId, workflowSteps, status, cancelWorkflow, setView } =
    useActionRunner();

  const currentTitle = workflows.find((w) => w.id === currentId)?.title;
  const isEmpty = workflowSteps.length === 0 && status !== "running";

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          {/* 点击标题进入 yaml 编辑态（与 action 一致的交互） */}
          <button
            type="button"
            className="cursor-pointer font-semibold hover:underline"
            title={t("edit.tooltip")}
            onClick={() => currentId && setView("workflow-edit")}
          >
            {currentTitle ?? t("sidebar.workflows")}
          </button>
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
          <div className="flex flex-col gap-2">
            {workflowSteps.map((step) => (
              <Collapsible
                key={step.index}
                defaultOpen={
                  step.status === "running" || step.status === "error"
                }
              >
                <Card className="overflow-hidden p-0">
                  <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-muted/50">
                    <HugeiconsIcon
                      icon={STATUS_ICON[step.status]}
                      strokeWidth={1.75}
                      className={`size-4 shrink-0 ${
                        step.status === "running"
                          ? "animate-spin text-primary"
                          : step.status === "error"
                            ? "text-destructive"
                            : step.status === "done"
                              ? "text-green-600"
                              : "text-muted-foreground"
                      }`}
                    />
                    <span className="flex-1 text-left text-sm font-medium">
                      {t("workflow.step", { index: step.index + 1 })}
                    </span>
                    <Badge
                      variant={
                        step.status === "error"
                          ? "destructive"
                          : step.status === "done"
                            ? "secondary"
                            : "outline"
                      }
                    >
                      {t(STATUS_I18N[step.status])}
                    </Badge>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    {step.lines.length > 0 && (
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap border-t bg-zinc-100 px-4 py-2 font-mono text-xs leading-relaxed text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
                        {step.lines.join("\n")}
                      </pre>
                    )}
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            ))}
          </div>
        </ScrollArea>
      )}
    </main>
  );
}
