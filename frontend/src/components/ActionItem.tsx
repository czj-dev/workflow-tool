import {
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
} from "@/components/ui/sidebar";
import type { ActionItem as ActionItemType } from "../../bindings/workflow-tool/internal/api/models.js";
import { useActionRunner } from "../hooks/useActionRunner";
import { PresetList } from "./PresetList";

// 侧边栏单个动作项：无参数点击直接运行；有参数点击进表单；当前动作展开预设子项
export function ActionItem({ action }: { action: ActionItemType }) {
  const { currentId, status, runAction, selectPreset } = useActionRunner();
  const isCurrent = currentId === action.id;
  const mark =
    status === "running"
      ? "●"
      : status === "done"
        ? "✓"
        : status === "error"
          ? "✗"
          : "";
  const hasParams = (action.params?.length ?? 0) > 0;

  const onClick = () => {
    if (hasParams) {
      // 有参数：进表单（selectPreset 内部预填 default + 切 form 视图 + 设 currentId）
      selectPreset(action.id, "");
    } else {
      runAction(action.id, {});
    }
  };

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isCurrent}
        tooltip={action.description || action.title}
        onClick={onClick}
      >
        {action.icon && <span className="shrink-0">{action.icon}</span>}
        <span>{action.title}</span>
        {isCurrent && mark && <SidebarMenuBadge>{mark}</SidebarMenuBadge>}
      </SidebarMenuButton>
      {isCurrent && hasParams && <PresetList action={action} />}
    </SidebarMenuItem>
  );
}
