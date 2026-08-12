import { Card } from "@/components/ui/card";
import { useActionRunner } from "../hooks/useActionRunner";
import { OutputToolbar } from "./OutputToolbar";
import { OutputConsole } from "./OutputConsole";
import { ParamForm } from "./ParamForm";
import { LlmForm } from "./LlmForm";
import { GlobalConfigEditor } from "./GlobalConfigEditor";
import { FragmentsView } from "./FragmentsView";
import { LlmView } from "./LlmView";
import { LogcatView } from "./LogcatView";
import { ActionYamlEditor } from "./ActionYamlEditor";
import { WorkflowView } from "./WorkflowView";
import { WorkflowParamForm } from "./WorkflowParamForm";
import { WorkflowYamlEditor } from "./WorkflowYamlEditor";
import { SettingsView } from "./SettingsView";
import { ActionsGridView } from "./ActionsGridView";
import { WorkflowsGridView } from "./WorkflowsGridView";

// 右栏容器：按 view 分派到对应视图。
export function OutputPanel() {
  const { view, actions, currentId } = useActionRunner();
  if (view === "settings") return <SettingsView />;
  if (view === "actions-grid") return <ActionsGridView />;
  if (view === "workflows-grid") return <WorkflowsGridView />;
  if (view === "workflow") return <WorkflowView />;
  if (view === "workflow-form") return <WorkflowParamForm />;
  if (view === "workflow-edit") return <WorkflowYamlEditor />;
  if (view === "edit") {
    return (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ActionYamlEditor />
      </main>
    );
  }
  if (view === "global") return <GlobalConfigEditor />;
  if (view === "fragments") return <FragmentsView />;
  if (view === "llm") return <LlmView />;
  if (view === "logcat") return <LogcatView />;
  if (view === "form") {
    // command.llm 一等形态走 LlmForm（system 折叠 + prompt 主位）；其余走通用 ParamForm。
    const action = actions.find((a) => a.id === currentId);
    const FormComp = action?.llm ? LlmForm : ParamForm;
    return (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <OutputToolbar />
        <div className="min-h-0 flex-1 overflow-auto">
          <FormComp />
        </div>
      </main>
    );
  }
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <OutputToolbar />
      <Card className="m-4 min-h-0 flex-1 overflow-hidden p-0">
        <OutputConsole />
      </Card>
    </main>
  );
}
