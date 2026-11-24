import { useTranslation } from "react-i18next";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiChat02Icon,
  Alert02Icon,
  ArrowRight01Icon,
  Calendar03Icon,
  FlashIcon,
  FlowIcon,
  NoteIcon,
  PreferenceHorizontalIcon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { useActionRunner } from "../hooks/useActionRunner";
import { useActionUsage } from "../hooks/useActionUsage";
import { ActionIcon } from "./ActionIcon";
import { ActionItem } from "./ActionItem";
import { DeviceSelector } from "./DeviceSelector";
import { WorkflowItem } from "./WorkflowItem";

// 等宽大写 eyebrow：控制台分区标签，结构即信息
const EYEBROW = "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

// —— Warp 式分组头（原型 D 变体定档：染色 轻 / 当前组提亮 / 安静分组头 / 色块 浅）——
// 两行分组头（mini-hub + 板块名 / 全部X · N ›）整块可点 = 该板块 Grid 入口；折叠态换成 rail 簇首的入口色块。
// 板块固定色由分组上的 data-amb 声明（工作流=蓝 / 动作=绿 / AI=紫；amber 留给 primary 的运行/激活），
// 数值 token（染色 12% / 色块 +14% / 字形墨色）见 index.css 的 .side-sec 段。
function SectionEntry({
  icon,
  label,
  entry,
  count,
  running,
  onOpen,
}: {
  icon: typeof FlowIcon;
  label: string;
  entry: string;
  count: number;
  running: boolean;
  onOpen: () => void;
}) {
  const { state, isMobile } = useSidebar();
  // 结构恒定：空态→加载完成不换元素（div↔button 互换会让 React 重建节点，
  // 已渲染的板块名脱挂）；空态仅收掉入口行并 disabled（无内容可进时入口不存在，与旧「全部X」按钮同一语义）
  return (
    <>
      <button
        type="button"
        onClick={() => count > 0 && onOpen()}
        aria-label={count > 0 ? entry : undefined}
        title={count > 0 ? entry : undefined}
        disabled={count === 0}
        className="side-head group-data-[collapsible=icon]:hidden mb-2 flex h-9 w-full shrink-0
          cursor-pointer items-center gap-1.5 rounded-md pl-1.5 pr-1 text-left ring-sidebar-ring
          outline-hidden transition-colors duration-150 focus-visible:ring-2 disabled:cursor-default"
      >
        <span
          className="side-hub-mini grid size-5 shrink-0 place-items-center rounded-[27.5%]"
          aria-hidden="true"
        >
          <HugeiconsIcon icon={icon} strokeWidth={1.75} className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-[18px] font-semibold text-foreground">
            <span className="truncate">{label}</span>
            {running && <span className="side-led size-1.5 shrink-0 rounded-full" aria-hidden="true" />}
          </span>
          {count > 0 && (
            <span className="side-sub flex min-w-0 items-center gap-1 text-xs leading-[18px]">
              <span className="truncate font-medium">{entry}</span>
              <span className="side-count shrink-0 font-mono">·{count}</span>
            </span>
          )}
        </span>
        {count > 0 && (
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            strokeWidth={2.25}
            className="side-chev size-4.5 shrink-0 text-foreground"
            aria-hidden="true"
          />
        )}
      </button>
      {count > 0 && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={onOpen}
                aria-label={entry}
                className="side-hub group-data-[collapsible=icon]:grid mb-2 hidden size-8 shrink-0
                  cursor-pointer place-items-center rounded-[27.5%] ring-sidebar-ring outline-hidden
                  transition-[background-color,box-shadow,transform] duration-150 focus-visible:ring-2
                  active:scale-95"
              />
            }
          >
            <HugeiconsIcon icon={icon} strokeWidth={1.75} className="size-4.5" />
            {running && <span className="side-run-dot" aria-hidden="true" />}
          </TooltipTrigger>
          <TooltipContent side="right" align="center" hidden={state !== "collapsed" || isMobile}>
            {entry}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

// 左侧可折叠侧边栏：渲染工作流 + 常用 top 3 动作 + 全部动作入口 + 底部「片段 / 全局配置 / 设置」
export function AppSidebar() {
  const { t } = useTranslation();
  const { actions, errors, workflows, workflowErrors, setView, openActionsDir, openLlmChat, focusRunning, isRunning, toggleFragments, fragmentsOpen, view, currentId, runningWorkflowId } =
    useActionRunner();
  const { topActions } = useActionUsage();
  const { topActions: topWorkflows } = useActionUsage("workflow-usage");
  const { topActions: topLlm } = useActionUsage("llm-usage");

  const shellActions = actions.filter((a) => !a.llm);
  const llmActions = actions.filter((a) => a.llm);
  const top3 = topActions(shellActions, 3);
  const top3Wf = topWorkflows(workflows, 3);
  const top3Llm = topLlm(llmActions, 3);

  // 分组「点亮」（gp=live）：当前视图或当前项落在该板块 → 整组提亮（样式在 index.css .side-sec[data-lit]）
  const litWf =
    view === "workflows-grid" || view === "workflow" || view === "workflow-edit" ||
    workflows.some((w) => w.id === currentId);
  const litAct = view === "actions-grid" || shellActions.some((a) => a.id === currentId);
  const litLlm =
    view === "llm-grid" || view === "llm-chat" || llmActions.some((a) => a.id === currentId);
  // 运行 LED：该板块有在跑条目（primary 只留给运行态）
  const runWf = runningWorkflowId !== null;
  const runAct = shellActions.some((a) => isRunning(a.id));
  const runLlm = llmActions.some((a) => isRunning(a.id));

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={openActionsDir}
              tooltip={t("sidebar.openDir")}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <HugeiconsIcon
                  icon={FlashIcon}
                  strokeWidth={1.75}
                  className="size-4.5"
                />
              </span>
              <div className="flex flex-col gap-0.5 leading-none">
                <span className="text-sm font-semibold font-mono uppercase tracking-[0.14em]">
                  {t("sidebar.brand")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("sidebar.openDir")}
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <DeviceSelector />
      </SidebarHeader>
      <SidebarContent className="gap-0 group-data-[collapsible=icon]:pt-3">
        <SidebarGroup
          data-amb="blue"
          data-lit={litWf || undefined}
          className="side-sec group-data-[collapsible=icon]:border-t-0 group-data-[collapsible=icon]:p-2 group-data-[collapsible=icon]:pb-7 gap-0 border-t border-sidebar-border px-2 pt-2 pb-4"
        >
          <SectionEntry
            icon={FlowIcon}
            label={t("sidebar.frequentWorkflows")}
            entry={t("sidebar.allWorkflows")}
            count={workflows.length}
            running={runWf}
            onOpen={() => setView("workflows-grid")}
          />
          <SidebarGroupContent>
            <SidebarMenu>
              {workflows.length === 0 && workflowErrors.length === 0 && (
                <Empty className="flex-none items-start border-none p-2 text-left">
                  <EmptyDescription>{t("workflow.empty")}</EmptyDescription>
                </Empty>
              )}
              {top3Wf.map((w) => (
                <WorkflowItem key={w.id} workflow={w} />
              ))}
              {workflowErrors.map((e, i) => (
                <SidebarMenuItem key={`wf-err-${i}`}>
                  <Alert variant="destructive" className="py-2">
                    <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.75} />
                    <AlertDescription>{e}</AlertDescription>
                  </Alert>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup
          data-amb="green"
          data-lit={litAct || undefined}
          className="side-sec group-data-[collapsible=icon]:border-t-0 group-data-[collapsible=icon]:p-2 group-data-[collapsible=icon]:pb-7 gap-0 border-t border-sidebar-border px-2 pt-2 pb-4"
        >
          <SectionEntry
            icon={FlashIcon}
            label={t("sidebar.frequentActions")}
            entry={t("sidebar.allActions")}
            count={shellActions.length}
            running={runAct}
            onOpen={() => setView("actions-grid")}
          />
          <SidebarGroupContent>
            <SidebarMenu>
              {shellActions.length === 0 && errors.length === 0 && (
                <Empty className="flex-none items-start border-none p-2 text-left">
                  <EmptyDescription>{t("empty.noActions")}</EmptyDescription>
                </Empty>
              )}
              {top3.map((a) => (
                <ActionItem key={a.id} action={a} />
              ))}
              {errors.map((e, i) => (
                <SidebarMenuItem key={`err-${i}`}>
                  <Alert variant="destructive" className="py-2">
                    <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.75} />
                    <AlertDescription>{e}</AlertDescription>
                  </Alert>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {/* AI 对话：llm 卡片单击直接进聊天页，不复用 ActionItem（那会进 form 视图） */}
        {llmActions.length > 0 && (
          <SidebarGroup
            data-amb="violet"
            data-lit={litLlm || undefined}
            className="side-sec group-data-[collapsible=icon]:border-t-0 group-data-[collapsible=icon]:p-2 group-data-[collapsible=icon]:pb-7 gap-0 border-t border-sidebar-border px-2 pt-2 pb-4"
          >
            <SectionEntry
              icon={AiChat02Icon}
              label={t("sidebar.aiChat")}
              entry={t("sidebar.allLlm")}
              count={llmActions.length}
              running={runLlm}
              onOpen={() => setView("llm-grid")}
            />
            <SidebarGroupContent>
              <SidebarMenu>
                {top3Llm.map((a) => (
                  <SidebarMenuItem key={a.id}>
                    <SidebarMenuButton
                      tooltip={a.description || a.title}
                      // 在跑的卡片要切回运行中态（重订阅输出），否则会落进全新空态
                      onClick={() =>
                        isRunning(a.id) ? focusRunning(a.id, "llm-chat") : openLlmChat(a.id)
                      }
                    >
                      <ActionIcon name={a.icon} className="shrink-0" />
                      <span>{a.title}</span>
                      {isRunning(a.id) && (
                        <SidebarMenuBadge className="right-2.5">
                          <span className="size-1.5 shrink-0 rounded-full bg-primary live-pulse" />
                        </SidebarMenuBadge>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter className="group-data-[collapsible=icon]:border-t-0 border-t border-sidebar-border">
        <SidebarGroupLabel className={EYEBROW}>
          {t("sidebar.config")}
        </SidebarGroupLabel>
        <SidebarMenu>
          {/* 片段：开关非模态抽屉（不再进全页视图）；开着时按钮高亮 */}
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={toggleFragments}
              isActive={fragmentsOpen}
              tooltip={t("sidebar.fragmentsHint")}
            >
              <HugeiconsIcon
                icon={NoteIcon}
                strokeWidth={1.75}
                className="size-4 shrink-0"
              />
              <span>{t("fragments.title")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => setView("schedules")}
              tooltip={t("scheduler.title")}
            >
              <HugeiconsIcon
                icon={Calendar03Icon}
                strokeWidth={1.75}
                className="size-4 shrink-0"
              />
              <span>{t("scheduler.title")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => setView("global")}
              tooltip={t("global.title")}
            >
              <HugeiconsIcon
                icon={Settings02Icon}
                strokeWidth={1.75}
                className="size-4 shrink-0"
              />
              <span>{t("global.title")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => setView("settings")}
              tooltip={t("sidebar.settings")}
            >
              <HugeiconsIcon
                icon={PreferenceHorizontalIcon}
                strokeWidth={1.75}
                className="size-4 shrink-0"
              />
              <span>{t("sidebar.settings")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
