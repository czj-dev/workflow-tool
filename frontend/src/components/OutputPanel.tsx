import { Card } from "@/components/ui/card";
import { useActionRunner } from "../hooks/useActionRunner";
import { OutputToolbar } from "./OutputToolbar";
import { OutputConsole } from "./OutputConsole";
import { ParamForm } from "./ParamForm";
import { GlobalConfigEditor } from "./GlobalConfigEditor";
import { FragmentsView } from "./FragmentsView";
import { LlmView } from "./LlmView";

// 右栏容器：按 view 切换 output（工具栏+终端）/ form（工具栏+参数表单）/ global（全局配置编辑）/ fragments
export function OutputPanel() {
  const { view } = useActionRunner();
  if (view === "global") {
    return (
      <main className="flex min-w-0 flex-1 flex-col">
        <GlobalConfigEditor />
      </main>
    );
  }
  if (view === "fragments") {
    return <FragmentsView />;
  }
  if (view === "llm") {
    return <LlmView />;
  }
  if (view === "form") {
    return (
      <main className="flex min-w-0 flex-1 flex-col">
        <OutputToolbar />
        <ParamForm />
      </main>
    );
  }
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <OutputToolbar />
      <Card className="m-4 flex-1 overflow-hidden p-0">
        <OutputConsole />
      </Card>
    </main>
  );
}
