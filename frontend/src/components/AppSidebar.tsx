import { useTranslation } from "react-i18next";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";
import { ActionItem } from "./ActionItem";

// 左侧可折叠侧边栏：渲染动作列表 + 加载错误
export function AppSidebar() {
  const { t } = useTranslation();
  const { actions, errors } = useActionRunner();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <span className="px-2 text-xs font-semibold text-muted-foreground">
              {t("sidebar.title")}
            </span>
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
    </Sidebar>
  );
}
