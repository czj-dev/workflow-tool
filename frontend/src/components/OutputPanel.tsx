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
import { ProtoHost, ProtoPage } from "./config-pages.prototype/slot";

// 右栏容器：按 view 分派到对应视图。
export function OutputPanel() {
  const { view } = useActionRunner();
  return (
    <>
      {/* PROTOTYPE（一次性）：原型切换条宿主。非原型会话同步返回 null，不产生任何 DOM。 */}
      <ProtoHost />
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
  // PROTOTYPE（一次性）：两页各插一个插槽；非原型会话同步回落到原组件（见 config-pages.prototype/slot.tsx）。
  if (view === "global") return <ProtoPage id="global" fallback={<GlobalConfigEditor />} />;
  if (view === "fragments") return <ProtoPage id="fragments" fallback={<FragmentsView />} />;
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
