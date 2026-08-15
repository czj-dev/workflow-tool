import { useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import {
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
} from "@/components/ui/sidebar";
import type { WorkflowItem as WorkflowItemType } from "../../bindings/workflow-tool/internal/api/models.js";
import { useActionRunner } from "../hooks/useActionRunner";
import { useActionUsage } from "../hooks/useActionUsage";
import { hasFormFields } from "../lib/params";
import { ActionIcon } from "./ActionIcon";

const DOUBLE_CLICK_DELAY = 250; // ms

// 侧边栏单个 workflow 项：
// 单击 —— 有「必填且无默认值」的 params 进配置表单，否则直接运行（默认值由后端回填）。
// 双击 —— 始终直接运行（用默认参数）。
// 运行指示用 Live Pulse；完成用 success 色。
export function WorkflowItem({ workflow }: { workflow: WorkflowItemType }) {
  const { currentId, status, view, runningWorkflowId, runWorkflow, selectWorkflow, focusWorkflow } =
    useActionRunner();
  const { recordUsage } = useActionUsage("workflow-usage");
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 是否「值得进表单」：有必填且无默认值的项。否则单击直接运行（不弹空表单）。
  const showForm = hasFormFields(workflow.params);

  const isWorkflowView =
    view === "workflow" || view === "workflow-form" || view === "workflow-edit";
  const isCurrent = currentId === workflow.id && isWorkflowView;
  // 该 workflow 正在运行（无论 currentId 是否已切走）
  const isRunning = runningWorkflowId === workflow.id;

  const handleClick = () => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      if (isRunning) {
        focusWorkflow(workflow.id);
        return;
      }
      if (showForm) {
        selectWorkflow(workflow.id); // 进 workflow-form
      } else {
        runWorkflow(workflow.id, {});
        recordUsage(workflow.id);
      }
    }, DOUBLE_CLICK_DELAY);
  };

  const handleDoubleClick = () => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    if (isRunning) {
      focusWorkflow(workflow.id);
      return;
    }
    runWorkflow(workflow.id, {});
    recordUsage(workflow.id);
  };

  const statusNode = isRunning ? (
    <span className="size-1.5 shrink-0 rounded-full bg-primary live-pulse" />
  ) : isCurrent && status === "done" ? (
    <HugeiconsIcon
      icon={Tick02Icon}
      strokeWidth={1.75}
      className="size-3.5 text-success"
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
        className={
          isCurrent
            ? "relative before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-primary before:content-['']"
            : ""
        }
      >
        <ActionIcon name={workflow.icon || "hi:workflow"} className="shrink-0" />
        <span>{workflow.title}</span>
        {statusNode && (
          <SidebarMenuBadge className="right-2.5">{statusNode}</SidebarMenuBadge>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
