import { useRef, useState } from "react";
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
import type { ActionItem as ActionItemType } from "../../bindings/workflow-tool/internal/api/models.js";
import { useActionRunner } from "../hooks/useActionRunner";
import { PresetList } from "./PresetList";
import { ActionIcon } from "./ActionIcon";

const DOUBLE_CLICK_DELAY = 250; // ms

// 侧边栏单个动作项：
// 单击 —— 有子项则展开/收起；无子项但有参数则进表单；两者都无则直接运行。
// 双击 —— 始终尝试直接运行（用默认参数）。
export function ActionItem({ action }: { action: ActionItemType }) {
  const { currentId, status, selectedPreset, runAction, selectPreset, setView } =
    useActionRunner();
  const [expanded, setExpanded] = useState(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isCurrent = currentId === action.id;
  const hasPresets = (action.presets?.length ?? 0) > 0;
  const hasParams = (action.params?.length ?? 0) > 0;

  const handleClick = () => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      // 若该动作正在运行：回到其输出视图（llm 流回 llm，否则回 output）
      if (isCurrent && status === "running") {
        setView(action.stream === "llm" ? "llm" : "output");
        return;
      }
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
    // 正在运行时后端会拒绝并发运行，双击同样只回到输出视图
    if (isCurrent && status === "running") {
      setView(action.stream === "llm" ? "llm" : "output");
      return;
    }
    runAction(action.id, {});
  };

  // 运行状态徽标图标（仅 current 动作显示）
  const statusIcon =
    status === "running" ? (
      <HugeiconsIcon
        icon={Loading03Icon}
        strokeWidth={1.75}
        className="size-3.5 animate-spin text-muted-foreground"
      />
    ) : status === "done" ? (
      <HugeiconsIcon
        icon={Tick02Icon}
        strokeWidth={1.75}
        className="size-3.5 text-muted-foreground"
      />
    ) : status === "error" ? (
      <HugeiconsIcon
        icon={Cancel01Icon}
        strokeWidth={1.75}
        className="size-3.5 text-destructive"
      />
    ) : null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isCurrent && !selectedPreset}
        tooltip={action.description || action.title}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      >
        <ActionIcon name={action.icon} className="shrink-0" />
        <span>{action.title}</span>
        {isCurrent && statusIcon && <SidebarMenuBadge>{statusIcon}</SidebarMenuBadge>}
      </SidebarMenuButton>
      {expanded && hasPresets && <PresetList action={action} />}
    </SidebarMenuItem>
  );
}
