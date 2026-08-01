import { useTranslation } from "react-i18next";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";
import { ActionItem } from "./ActionItem";

// 左侧可折叠侧边栏：渲染动作列表 + 加载错误 + 底部「全局配置」入口
export function AppSidebar() {
  const { t } = useTranslation();
  const { actions, errors, setView } = useActionRunner();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* 折叠为 icon 时只显⚡图标，展开时显⚡+标题（由 SidebarMenuButton 自带样式控制） */}
            <SidebarMenuButton size="lg" tooltip={t("sidebar.title")}>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground text-base">
                ⚡
              </span>
              <span className="text-base font-semibold">
                {t("sidebar.title")}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {actions.length === 0 && errors.length === 0 && (
                <p className="px-2 text-sm text-muted-foreground">
                  {t("empty.noActions")}
                </p>
              )}
              {actions.map((a) => (
                <ActionItem key={a.id} action={a} />
              ))}
              {errors.map((e, i) => (
                <SidebarMenuItem key={`err-${i}`}>
                  <span className="px-2 text-sm text-destructive">⚠ {e}</span>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => setView("fragments")} tooltip={t("fragments.title")}>
              <span className="shrink-0">📋</span>
              <span>{t("fragments.title")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => setView("global")} tooltip={t("global.title")}>
              <span className="shrink-0">⚙</span>
              <span>{t("global.title")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
