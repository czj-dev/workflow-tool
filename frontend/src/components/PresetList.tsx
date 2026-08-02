import { useRef } from "react";
import {
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
import type { ActionItem } from "../../bindings/workflow-tool/internal/api/models.js";
import { useActionRunner } from "../hooks/useActionRunner";

const DOUBLE_CLICK_DELAY = 250; // ms

// 动作的预设子项：单击进表单（预填该预设值）、双击直接运行。
// 用 SidebarMenuSub 渲染为父动作的子菜单（左侧竖线 + 缩进），与父项的层级关系一目了然。
export function PresetList({ action }: { action: ActionItem }) {
  const { selectPreset, runAction, currentId, selectedPreset } =
    useActionRunner();
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!action.presets || action.presets.length === 0) return null;

  const handleClick = (presetName: string) => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      selectPreset(action.id, presetName);
      clickTimer.current = null;
    }, DOUBLE_CLICK_DELAY);
  };

  const handleDoubleClick = (values: Record<string, string | undefined>) => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    runAction(action.id, values);
  };

  return (
    <SidebarMenuSub>
      {action.presets.map((p, i) => (
        <SidebarMenuSubItem key={p.name}>
          <SidebarMenuButton
            size="sm"
            isActive={currentId === action.id && selectedPreset === p.name}
            tooltip={p.description || p.name}
            onClick={() => handleClick(p.name)}
            onDoubleClick={() => handleDoubleClick(p.values)}
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded text-xs font-medium bg-sidebar-accent text-sidebar-accent-foreground">
              {i + 1}
            </span>
            <span>{p.name}</span>
          </SidebarMenuButton>
        </SidebarMenuSubItem>
      ))}
    </SidebarMenuSub>
  );
}
