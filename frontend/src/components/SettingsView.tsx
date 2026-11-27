import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FloppyDiskIcon } from "@hugeicons/core-free-icons";
import { IconButton } from "./IconButton";
import { useTheme } from "@/components/theme-provider";
import { useActionRunner } from "../hooks/useActionRunner";

// 等宽大写 eyebrow：和 AppSidebar / GlobalConfigEditor 同构
const EYEBROW =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

// Agent 三键表单草稿（auth.json 已知三字段；未知键由后端保存时原样保留，前端不感知）
type AgentDraft = { baseUrl: string; authKey: string; model: string };
const draftOf = (cfg: { baseUrl: string; authKey: string; model: string }): AgentDraft => ({
  baseUrl: cfg.baseUrl,
  authKey: cfg.authKey,
  model: cfg.model,
});

// 设置页：主题 segmented (Light/Dark/System) + 语言 segmented (中文/English) +
// Agent 三键（用户级 auth.json，密钥遮蔽输入）+ 内容管理。
// 原先散落在侧边栏 Footer 的 cycleTheme + 语言切换归拢于此，释放 Sidebar 空间。
export function SettingsView() {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const { setView, agentConfig, saveAgentConfig } = useActionRunner();
  const lang = i18n.language?.startsWith("zh") ? "zh" : "en";

  const handleLang = (v: string) => {
    i18n.changeLanguage(v);
    localStorage.setItem("lang", v);
  };

  // Agent 三键本地草稿：dirty 期间不跟随 provider（agentConfig 异步加载/保存回写），
  // 模式同 GlobalConfigEditor 的 render-time 同步。
  const [draft, setDraft] = useState<AgentDraft>(() => draftOf(agentConfig));
  const [dirty, setDirty] = useState(false);
  const [prevAgent, setPrevAgent] = useState(agentConfig);
  if (agentConfig !== prevAgent) {
    setPrevAgent(agentConfig);
    if (!dirty) setDraft(draftOf(agentConfig));
  }

  const updateAgent = (field: keyof AgentDraft, v: string) => {
    setDraft((prev) => ({ ...prev, [field]: v }));
    setDirty(true);
  };

  const saveAgent = async () => {
    await saveAgentConfig(draft);
    setDirty(false);
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
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

        {/* Agent：三键存用户级 auth.json（0600），不进 config.yaml / 应用打包 */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <label className={EYEBROW}>{t("settings.agent")}</label>
            <IconButton
              icon={FloppyDiskIcon}
              label={t("settings.agentSave")}
              variant={dirty ? "default" : "outline"}
              dot={dirty}
              disabled={!dirty}
              onClick={saveAgent}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t("settings.agentBaseUrl")}</label>
            <Input
              className="h-8 font-mono text-xs"
              value={draft.baseUrl}
              onChange={(e) => updateAgent("baseUrl", e.target.value)}
              placeholder={t("settings.agentBaseUrlPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t("settings.agentAuthKey")}</label>
            <Input
              className="h-8 font-mono text-xs"
              type="password"
              value={draft.authKey}
              onChange={(e) => updateAgent("authKey", e.target.value)}
              placeholder={t("settings.agentAuthKeyPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t("settings.agentModel")}</label>
            <Input
              className="h-8 font-mono text-xs"
              value={draft.model}
              onChange={(e) => updateAgent("model", e.target.value)}
              placeholder={t("settings.agentModelPlaceholder")}
            />
          </div>
          <p className="font-mono text-[11px] leading-relaxed text-muted-foreground/80">
            {t("settings.agentHint")}
          </p>
        </section>

        {/* 内容管理：全页片段视图的唯一入口（日常取用走 ⌘/Ctrl+K 抽屉） */}
        <section className="space-y-2">
          <label className={EYEBROW}>{t("settings.content")}</label>
          <Button variant="outline" onClick={() => setView("fragments")}>
            {t("settings.manageFragments")}
          </Button>
        </section>
      </div>
    </main>
  );
}
