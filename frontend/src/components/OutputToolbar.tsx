import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";
import { LangSwitch } from "./LangSwitch";

// 输出区工具栏：折叠触发 + 当前动作标题 + 停止/清空/复制 + 语言切换
export function OutputToolbar() {
  const { t } = useTranslation();
  const { actions, currentId, status, cancel, clearOutput, copyOutput } =
    useActionRunner();
  const [copied, setCopied] = useState(false);
  const current = actions.find((a) => a.id === currentId);
  const running = status === "running";

  const onCopy = async () => {
    await copyOutput();
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <header className="flex items-center justify-between border-b px-4 py-2">
      <div className="flex items-center gap-2">
        <SidebarTrigger />
        <span className="font-semibold">
          {current
            ? `${current.icon || "▶"} ${current.title}`
            : t("main.selectAction")}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onCopy}>
          {copied ? t("main.copied") : t("main.copy")}
        </Button>
        <Button variant="outline" size="sm" onClick={clearOutput}>
          {t("main.clear")}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={!running}
          onClick={cancel}
        >
          {t("main.stop")}
        </Button>
        <LangSwitch />
      </div>
    </header>
  );
}
