import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";
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
  } = useActionRunner();

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
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <SidebarTrigger />
        <span className="font-semibold">{workflow.title}</span>
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
            <Button disabled={!canRun} onClick={onRun}>
              {t("main.run")}
            </Button>
          </FieldGroup>
        )}
      </div>
    </main>
  );
}
