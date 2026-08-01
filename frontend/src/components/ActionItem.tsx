import { useRef, useState } from "react";
import {
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
} from "@/components/ui/sidebar";
import type { ActionItem as ActionItemType } from "../../bindings/workflow-tool/internal/api/models.js";
import { useActionRunner } from "../hooks/useActionRunner";
import { PresetList } from "./PresetList";

const DOUBLE_CLICK_DELAY = 250; // ms

// 侧边栏单个动作项：
// 单击 —— 有子项则展开/收起；无子项但有参数则进表单；两者都无则直接运行。
// 双击 —— 始终尝试直接运行（用默认参数）。
export function ActionItem({ action }: { action: ActionItemType }) {
  const { currentId, status, runAction, selectPreset } = useActionRunner();
  const [expanded, setExpanded] = useState(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isCurrent = currentId === action.id;
  const mark =
    status === "running"
      ? "●"
      : status === "done"
        ? "✓"
        : status === "error"
          ? "✗"
          : "";
  const hasPresets = (action.presets?.length ?? 0) > 0;
  const hasParams = (action.params?.length ?? 0) > 0;

  const handleClick = () => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      if (hasPresets) {
        setExpanded((v) => !v);
      } else if (hasParams) {
        // 无子项但有参数：进表单（selectPreset 预填 default + 切 form 视图 + 设 currentId）
        selectPreset(action.id, "");
      } else {
        // 既无子项也无参数：无表单可进，直接运行
        runAction(action.id, {});
      }
    }, DOUBLE_CLICK_DELAY);
  };

  const handleDoubleClick = () => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    runAction(action.id, {});
  };

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isCurrent}
        tooltip={action.description || action.title}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      >
        {action.icon && <span className="shrink-0">{action.icon}</span>}
        <span>{action.title}</span>
        {isCurrent && mark && <SidebarMenuBadge>{mark}</SidebarMenuBadge>}
      </SidebarMenuButton>
      {expanded && hasPresets && <PresetList action={action} />}
    </SidebarMenuItem>
  );
}
