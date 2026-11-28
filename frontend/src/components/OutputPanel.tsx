import { Card } from "@/components/ui/card";
import { useActionRunner } from "../hooks/useActionRunner";
import { OutputToolbar } from "./OutputToolbar";
import { OutputConsole } from "./OutputConsole";
import { GlobalConfigEditor } from "./GlobalConfigEditor";
import { FragmentsView } from "./FragmentsView";
import { AiGridView } from "./AiGridView";
import { AiChatView } from "./AiChatView";
import { LogcatView } from "./LogcatView";
import { ActionYamlEditor } from "./ActionYamlEditor";
import { WorkflowView } from "./WorkflowView";
import { WorkflowYamlEditor } from "./WorkflowYamlEditor";
import { AiYamlEditor } from "./AiYamlEditor";
import { SettingsView } from "./SettingsView";
import { SchedulerView } from "./SchedulerView";
import { ActionsGridView } from "./ActionsGridView";
import { RunsView } from "./RunsView";
import { RunDetailView } from "./RunDetailView";
import { WorkflowsGridView } from "./WorkflowsGridView";

// 右栏容器：按 view 分派到对应视图。
export function OutputPanel() {
  const { view } = useActionRunner();
  return (
    <>
      <SchedulerView active={view === "schedules"} />
      {view !== "schedules" && <OtherView />}
    </>
  );
}

function OtherView() {
  const { view } = useActionRunner();
  if (view === "settings") return <SettingsView />;
  if (view === "actions-grid") return <ActionsGridView />;
  if (view === "workflows-grid") return <WorkflowsGridView />;
  if (view === "workflow") return <WorkflowView />;
  if (view === "workflow-edit") return <WorkflowYamlEditor />;
  if (view === "ai-edit") return <AiYamlEditor />;
  if (view === "edit") {
    return (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ActionYamlEditor />
      </main>
    );
  }
  if (view === "global") return <GlobalConfigEditor />;
  if (view === "fragments") return <FragmentsView />;
  if (view === "ai-grid") return <AiGridView />;
  if (view === "ai-chat") return <AiChatView />;
  // 运行记录（M3）：全部目标的运行列表与单条运行详情
  if (view === "runs") return <RunsView />;
  if (view === "run-detail") return <RunDetailView />;
  if (view === "logcat") return <LogcatView />;
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <OutputToolbar />
      <Card className="m-4 min-h-0 flex-1 overflow-hidden p-0">
        <OutputConsole />
      </Card>
    </main>
  );
}
