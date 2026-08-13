import { useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import {
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
} from "@/components/ui/sidebar";
import type { ActionItem as ActionItemType } from "../../bindings/workflow-tool/internal/api/models.js";
import { useActionRunner } from "../hooks/useActionRunner";
import { useActionUsage } from "../hooks/useActionUsage";
import { PresetList } from "./PresetList";
import { ActionIcon } from "./ActionIcon";

const DOUBLE_CLICK_DELAY = 250; // ms

// 侧边栏单个动作项：
// 单击 —— 有子项则展开/收起；无子项但有参数则进表单；两者都无则直接运行。
// 双击 —— 始终尝试直接运行（用默认参数）。
// 运行指示用 Live Pulse（呼吸点）替代转圈；完成用 success 色，失败 destructive。
export function ActionItem({ action }: { action: ActionItemType }) {
  const { currentId, status, isRunning, focusRunning, selectedPreset, runAction, selectPreset } =
    useActionRunner();
  const { recordUsage } = useActionUsage();
  const [expanded, setExpanded] = useState(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isCurrent = currentId === action.id;
  const active = isCurrent && !selectedPreset;
  const hasPresets = (action.presets?.length ?? 0) > 0;
  const hasParams = (action.params?.length ?? 0) > 0;
  // 该动作是否仍在后台运行（即使 currentId 已切走）
  const actionRunning = isRunning(action.id);

  // 回到运行中动作：把它设回 currentId（重订阅输出 + 停止按钮作用于它）并切视图。
  // ponytail: 历史输出行不恢复——lines 是单缓冲，被其他 action 运行时清掉了；
  // scrcpy 这类只关心「在跑/能停」，够用。要留存历史需 per-id buffer，YAGNI。
  const backToRunning = () => {
    // llm 形态（command.llm）→llm-chat、logcat→logcat、其余→output。
    // 漏掉 logcat 会让「抓取日志」等后台运行时点击落入通用 output 视图（看不到实时日志）。
    const target = action.llm
      ? "llm-chat"
      : action.stream === "logcat"
        ? "logcat"
        : "output";
    focusRunning(action.id, target);
  };

  const handleClick = () => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      if (actionRunning) {
        backToRunning();
        return;
      }
      if (hasPresets) {
        setExpanded((v) => !v);
      } else if (hasParams) {
        selectPreset(action.id, "");
      } else {
        runAction(action.id, {});
        recordUsage(action.id);
      }
    }, DOUBLE_CLICK_DELAY);
  };

  const handleDoubleClick = () => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    if (actionRunning) {
      backToRunning();
      return;
    }
    runAction(action.id, {});
    recordUsage(action.id);
  };

  // 运行状态徽标：呼吸点（运行中，不看 currentId）/ 完成 / 失败（仅 current）
  const statusNode = actionRunning ? (
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
        isActive={active}
        tooltip={action.description || action.title}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        className={
          active
            ? "relative before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-primary before:content-['']"
            : ""
        }
      >
        <ActionIcon name={action.icon} className="shrink-0" />
        <span>{action.title}</span>
        {statusNode && (
          <SidebarMenuBadge className="right-2.5">{statusNode}</SidebarMenuBadge>
        )}
      </SidebarMenuButton>
      {expanded && hasPresets && <PresetList action={action} />}
    </SidebarMenuItem>
  );
}
