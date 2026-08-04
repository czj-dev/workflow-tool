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

// 侧边栏单个 workflow 项：单击直接运行（workflow 无参数/预设）
export function WorkflowItem({ workflow }: { workflow: WorkflowItemType }) {
  const { currentId, status, view, runWorkflow } = useActionRunner();
  const isCurrent = currentId === workflow.id && view === "workflow";
  const isRunning = isCurrent && status === "running";

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
        onClick={() => runWorkflow(workflow.id)}
      >
        <ActionIcon name={workflow.icon || "hi:workflow"} className="shrink-0" />
        <span>{workflow.title}</span>
        {statusIcon && <SidebarMenuBadge>{statusIcon}</SidebarMenuBadge>}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
