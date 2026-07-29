import {
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
} from "@/components/ui/sidebar";
import type { ActionItem as ActionItemType } from "../../bindings/workflow-tool/internal/api/models.js";
import { useActionRunner } from "../hooks/useActionRunner";

// 侧边栏单个动作项：图标 + 标题 + 运行状态灯，点击运行
export function ActionItem({ action }: { action: ActionItemType }) {
  const { currentId, status, runAction } = useActionRunner();
  const isCurrent = currentId === action.id;
  const mark =
    status === "running"
      ? "●"
      : status === "done"
        ? "✓"
        : status === "error"
          ? "✗"
          : "";

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isCurrent}
        tooltip={action.description || action.title}
        onClick={() => runAction(action.id)}
      >
        {action.icon && <span className="shrink-0">{action.icon}</span>}
        <span>{action.title}</span>
        {isCurrent && mark && <SidebarMenuBadge>{mark}</SidebarMenuBadge>}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
