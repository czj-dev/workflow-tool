import { useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
} from "@/components/ui/sidebar";
import type { WorkflowItem as WorkflowItemType } from "../../bindings/workflow-tool/internal/api/models.js";
import { useActionRunner } from "../hooks/useActionRunner";
import { ActionIcon } from "./ActionIcon";

const DOUBLE_CLICK_DELAY = 250; // ms

// 侧边栏单个 workflow 项：
// 单击 —— 有 params 进配置表单，无 params 直接运行。
// 双击 —— 始终直接运行（用默认参数）。
export function WorkflowItem({ workflow }: { workflow: WorkflowItemType }) {
  const { currentId, status, view, runWorkflow, selectWorkflow, setView } =
    useActionRunner();
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isWorkflowView =
    view === "workflow" || view === "workflow-form" || view === "workflow-edit";
  const isCurrent = currentId === workflow.id && isWorkflowView;
  const isRunning = isCurrent && status === "running";

  const handleClick = () => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      if (isRunning) {
        setView("workflow");
        return;
      }
      // selectWorkflow：有 params 进表单，无 params 直接跑
      selectWorkflow(workflow.id);
    }, DOUBLE_CLICK_DELAY);
  };

  const handleDoubleClick = () => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    if (isRunning) {
      setView("workflow");
      return;
    }
    runWorkflow(workflow.id, {});
  };

  const statusIcon = isRunning ? (
    <HugeiconsIcon
      icon={Loading03Icon}
      strokeWidth={1.75}
      className="size-3.5 animate-spin text-muted-foreground"
    />
  ) : isCurrent && status === "done" ? (
    <HugeiconsIcon
      icon={Tick02Icon}
      strokeWidth={1.75}
      className="size-3.5 text-muted-foreground"
    />
  ) : isCurrent && status === "error" ? (
    <HugeiconsIcon
      icon={Cancel01Icon}
      strokeWidth={1.75}
      className="size-3.5 text-destructive"
    />
  ) : null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isCurrent}
        tooltip={workflow.description || workflow.title}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      >
        <ActionIcon name={workflow.icon || "hi:workflow"} className="shrink-0" />
        <span>{workflow.title}</span>
        {statusIcon && <SidebarMenuBadge>{statusIcon}</SidebarMenuBadge>}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
