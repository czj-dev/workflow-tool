import { Card } from "@/components/ui/card";
import { OutputToolbar } from "./OutputToolbar";
import { OutputConsole } from "./OutputConsole";

// 右栏容器：工具栏 + 终端区
export function OutputPanel() {
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <OutputToolbar />
      <Card className="m-4 flex-1 overflow-hidden p-0">
        <OutputConsole />
      </Card>
    </main>
  );
}
