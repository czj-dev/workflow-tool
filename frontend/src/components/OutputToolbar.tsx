import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { HugeiconsIcon } from "@hugeicons/react";
import { Edit02Icon } from "@hugeicons/core-free-icons";
import { useActionRunner } from "../hooks/useActionRunner";
import { ActionIcon } from "./ActionIcon";

// 输出区工具栏：折叠触发 + 当前动作标题 + 停止/清空/复制 + 语言切换
export function OutputToolbar() {
  const { t } = useTranslation();
  const { actions, currentId, status, cancel, clearOutput, copyOutput, setView } =
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
        <button
          type="button"
          onClick={() => setView("edit")}
          title={t("edit.tooltip")}
          className="flex items-center gap-1.5 rounded px-1 font-semibold hover:bg-accent cursor-pointer"
        >
          {current ? (
            <>
              <ActionIcon name={current.icon ?? "hi:play"} />
              {current.title}
            </>
          ) : (
            t("main.selectAction")
          )}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => setView("edit")}
          title={t("edit.tooltip")}
        >
          <HugeiconsIcon icon={Edit02Icon} strokeWidth={1.75} />
        </Button>
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
      </div>
    </header>
  );
}
