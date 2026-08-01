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
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  CommandIcon,
  NoteIcon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import { useActionRunner } from "../hooks/useActionRunner";
import { ActionItem } from "./ActionItem";

// 左侧可折叠侧边栏：渲染动作列表 + 加载错误 + 底部「片段 / 全局配置」入口
export function AppSidebar() {
  const { t } = useTranslation();
  const { actions, errors, setView } = useActionRunner();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* 折叠为 icon 时只显命令图标，展开时显图标+标题（由 SidebarMenuButton 自带样式控制） */}
            <SidebarMenuButton size="lg" tooltip={t("sidebar.title")}>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-primary ring-1 ring-white/10">
                <HugeiconsIcon
                  icon={CommandIcon}
                  strokeWidth={1.75}
                  className="size-4.5"
                />
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
                  <span className="flex items-center gap-1 px-2 text-sm text-destructive">
                    <HugeiconsIcon
                      icon={Alert02Icon}
                      strokeWidth={1.75}
                      className="size-4"
                    />
                    {e}
                  </span>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
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
