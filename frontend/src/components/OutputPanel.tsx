import { Card } from "@/components/ui/card";
import { useActionRunner } from "../hooks/useActionRunner";
import { OutputToolbar } from "./OutputToolbar";
import { OutputConsole } from "./OutputConsole";
import { ParamForm } from "./ParamForm";
import { GlobalConfigEditor } from "./GlobalConfigEditor";
import { FragmentsView } from "./FragmentsView";
import { LlmGridView } from "./LlmGridView";
import { LlmChatView } from "./LlmChatView";
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
  const { view } = useActionRunner();
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
  if (view === "llm-grid") return <LlmGridView />;
  if (view === "llm-chat") return <LlmChatView />;
  if (view === "logcat") return <LogcatView />;
  if (view === "form") {
    // 发射台视图：装配（表单）/ 发射（摘要+输出）双形态由 ParamForm 自管，含各自滚动
    return (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <OutputToolbar />
        <ParamForm />
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
