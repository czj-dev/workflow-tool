import { useTranslation } from "react-i18next";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTheme } from "@/components/theme-provider";

// 等宽大写 eyebrow：和 AppSidebar / GlobalConfigEditor 同构
const EYEBROW =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

// 设置页：主题 segmented (Light/Dark/System) + 语言 segmented (中文/English)。
// 原先散落在侧边栏 Footer 的 cycleTheme + 语言切换归拢于此，释放 Sidebar 空间。
export function SettingsView() {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const lang = i18n.language?.startsWith("zh") ? "zh" : "en";

  const handleLang = (v: string) => {
    i18n.changeLanguage(v);
    localStorage.setItem("lang", v);
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <SidebarTrigger />
        <h1 className="text-sm font-semibold">{t("settings.title")}</h1>
      </header>
      <div className="p-6 space-y-8 max-w-md">
        {/* 主题 */}
        <section className="space-y-2">
          <label className={EYEBROW}>{t("settings.theme")}</label>
          <Tabs value={theme} onValueChange={(v) => setTheme(v as "light" | "dark" | "system")}>
            <TabsList>
              <TabsTrigger value="light">{t("theme.light")}</TabsTrigger>
              <TabsTrigger value="dark">{t("theme.dark")}</TabsTrigger>
              <TabsTrigger value="system">{t("theme.system")}</TabsTrigger>
            </TabsList>
          </Tabs>
        </section>

        {/* 语言 */}
        <section className="space-y-2">
          <label className={EYEBROW}>{t("settings.language")}</label>
          <Tabs value={lang} onValueChange={handleLang}>
            <TabsList>
              <TabsTrigger value="zh">中文</TabsTrigger>
              <TabsTrigger value="en">English</TabsTrigger>
            </TabsList>
          </Tabs>
        </section>
      </div>
    </main>
  );
}
