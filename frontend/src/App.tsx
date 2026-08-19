import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ActionRunnerProvider } from "./context/ActionRunnerProvider";
import { AppSidebar } from "./components/AppSidebar";
import { OutputPanel } from "./components/OutputPanel";
import { FragmentsSheet } from "./components/FragmentsSheet";

// 双栏骨架：ActionRunnerProvider 提供运行状态，TooltipProvider 供侧边栏折叠态 tooltip，
// SidebarProvider 管理侧边栏布局，AppSidebar 左栏，SidebarInset 右栏主区
export default function App() {
  return (
    <ActionRunnerProvider>
      <TooltipProvider>
        <SidebarProvider className="h-svh overflow-hidden">
          <AppSidebar />
          <SidebarInset>
            <OutputPanel />
          </SidebarInset>
          {/* 非模态片段抽屉：portaled 到 body，与任意视图同屏共存 */}
          <FragmentsSheet />
        </SidebarProvider>
      </TooltipProvider>
    </ActionRunnerProvider>
  );
}
