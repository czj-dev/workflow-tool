import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
import type { ActionItem } from "../../bindings/workflow-tool/internal/api/models.js";
import { useActionRunner } from "../hooks/useActionRunner";

// 动作的预设子项：单击进表单（预填该预设值）、双击直接运行
export function PresetList({ action }: { action: ActionItem }) {
  const { selectPreset, runAction } = useActionRunner();
  if (!action.presets || action.presets.length === 0) return null;
  return (
    <SidebarMenu>
      {action.presets.map((p) => (
        <SidebarMenuItem key={p.name}>
          <SidebarMenuButton
            size="sm"
            onClick={() => selectPreset(action.id, p.name)}
            onDoubleClick={() => runAction(action.id, p.values)}
          >
            <span className="pl-4">{p.name}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
