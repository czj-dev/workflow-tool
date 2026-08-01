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
  NoteIcon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { useActionRunner } from "../hooks/useActionRunner";
import { ActionItem } from "./ActionItem";

// 左侧可折叠侧边栏：渲染动作列表 + 加载错误 + 底部「片段 / 全局配置」入口
export function AppSidebar() {
  const { t } = useTranslation();
  const { actions, errors, setView, openActionsDir } = useActionRunner();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* 折叠为 icon 时只显命令图标，展开时显图标+标题（由 SidebarMenuButton 自带样式控制） */}
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
                <span className="text-base font-semibold">
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
          <SidebarGroupLabel>{t("sidebar.title")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {actions.length === 0 && errors.length === 0 && (
                <Empty className="flex-none items-start border-none p-2 text-left">
                  <EmptyDescription>{t("empty.noActions")}</EmptyDescription>
                </Empty>
              )}
              {actions.map((a) => (
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
      </SidebarContent>
      <SidebarFooter>
        <SidebarGroupLabel>{t("sidebar.config")}</SidebarGroupLabel>
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
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
