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
} from "@/components/ui/sidebar";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  FlashIcon,
  GridViewIcon,
  NoteIcon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { useActionRunner } from "../hooks/useActionRunner";
import { useActionUsage } from "../hooks/useActionUsage";
import { ActionItem } from "./ActionItem";
import { WorkflowItem } from "./WorkflowItem";

// 等宽大写 eyebrow：控制台分区标签，结构即信息
const EYEBROW = "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

// 左侧可折叠侧边栏：渲染工作流 + 常用 top 3 动作 + 全部动作入口 + 底部「片段 / 全局配置 / 设置」
export function AppSidebar() {
  const { t } = useTranslation();
  const { actions, errors, workflows, workflowErrors, setView, openActionsDir } =
    useActionRunner();
  const { topActions } = useActionUsage();

  const top3 = topActions(actions, 3);

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
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className={EYEBROW}>
            {t("sidebar.workflows")}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {workflows.length === 0 && workflowErrors.length === 0 && (
                <Empty className="flex-none items-start border-none p-2 text-left">
                  <EmptyDescription>{t("workflow.empty")}</EmptyDescription>
                </Empty>
              )}
              {workflows.map((w) => (
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
        <SidebarGroup>
          <SidebarGroupLabel className={EYEBROW}>
            {t("sidebar.frequentActions")}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {actions.length === 0 && errors.length === 0 && (
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
              {/* 全部动作入口 */}
              {actions.length > 0 && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => setView("actions-grid")}
                    tooltip={t("sidebar.allActions")}
                  >
                    <HugeiconsIcon
                      icon={GridViewIcon}
                      strokeWidth={1.75}
                      className="size-4 shrink-0"
                    />
                    <span>{t("sidebar.allActions")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarGroupLabel className={EYEBROW}>
          {t("sidebar.config")}
        </SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => setView("fragments")}
              tooltip={t("fragments.title")}
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
                icon={Settings02Icon}
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
