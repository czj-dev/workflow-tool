import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlayIcon } from "@hugeicons/core-free-icons";
import { useActionRunner } from "../hooks/useActionRunner";
import { useActionUsage } from "../hooks/useActionUsage";
import { ParamFields } from "./ParamFields";
import { missingRequired } from "../lib/params";
import { WorkflowStepsOverview } from "./WorkflowStepsOverview";

// WorkflowParamForm 渲染 workflow 的参数表单，上方展示步骤概览。
export function WorkflowParamForm() {
  const { t } = useTranslation();
  const {
    workflows,
    currentId,
    workflowFormValues,
    setWorkflowFormValue,
    runWorkflow,
    setView,
  } = useActionRunner();

  const { recordUsage } = useActionUsage("workflow-usage");

  const workflow = workflows.find((w) => w.id === currentId);
  if (!workflow) return null;

  const params = workflow.params ?? [];
  const canRun = missingRequired(params, workflowFormValues).length === 0;

  const onRun = () => {
    if (!canRun) return;
    const p: Record<string, string> = {};
    params.forEach((spec) => {
      p[spec.id] = workflowFormValues[spec.id] ?? spec.default ?? "";
    });
    runWorkflow(workflow.id, p);
    recordUsage(workflow.id);
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <SidebarTrigger />
        {/* 标题点击进入 yaml 编辑态（与 WorkflowView 一致） */}
        <button
          type="button"
          className="cursor-pointer font-semibold hover:underline"
          title={t("edit.tooltip")}
          onClick={() => currentId && setView("workflow-edit")}
        >
          {workflow.title}
        </button>
      </header>
      <div className="flex flex-col gap-4 p-4">
        <WorkflowStepsOverview steps={workflow.steps ?? []} />
        {params.length > 0 && (
          <FieldGroup>
            <ParamFields
              params={params}
              values={workflowFormValues}
              setValue={setWorkflowFormValue}
            />
            <div className="flex items-center justify-end">
              <Button disabled={!canRun} onClick={onRun}>
                <HugeiconsIcon icon={PlayIcon} strokeWidth={1.75} className="size-4" />
                {t("main.run")}
              </Button>
            </div>
          </FieldGroup>
        )}
      </div>
    </main>
  );
}
