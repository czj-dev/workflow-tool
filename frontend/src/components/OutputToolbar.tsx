import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Edit02Icon, ArrowReloadHorizontalIcon, PreferenceHorizontalIcon } from "@hugeicons/core-free-icons";
import { IconButton } from "./IconButton";
import { useActionRunner } from "../hooks/useActionRunner";
import { ActionIcon } from "./ActionIcon";

// 输出区工具栏：折叠触发 + 返回 Grid + 当前动作标题 + 运行状态/耗时 + 再次运行/编辑再跑 + 停止/清空/复制 + 编辑
export function OutputToolbar() {
  const { t } = useTranslation();
  const {
    actions,
    currentId,
    status,
    exitInfo,
    cancel,
    clearOutput,
    copyOutput,
    setView,
    lastRunParams,
    rerun,
    editRerun,
  } = useActionRunner();
  const [copied, setCopied] = useState(false);
  const current = actions.find((a) => a.id === currentId);
  const running = status === "running";
  // 跑过至少一次（有记录）且当前不在运行 → 显示再跑入口
  const canRerun = !running && !!current && currentId! in lastRunParams;
  const hasParams = (current?.params?.length ?? 0) > 0;

  const onCopy = async () => {
    await copyOutput();
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  // 状态/耗时指示：运行中→琥珀呼吸点；完成→success + 耗时；失败→destructive + 耗时
  const statusNode = running ? (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs text-primary">
      <span className="size-1.5 rounded-full bg-primary live-pulse" />
      {t("workflow.running")}
    </span>
  ) : exitInfo && current ? (
    <span
      className={`inline-flex items-center gap-1.5 font-mono text-xs ${
        exitInfo.exitCode === 0 ? "text-success" : "text-destructive"
      }`}
    >
      {exitInfo.exitCode === 0 ? t("workflow.done") : t("workflow.error")}
      {exitInfo.duration && (
        <span className="text-muted-foreground">· {exitInfo.duration}</span>
      )}
    </span>
  ) : null;

  return (
    <header className="flex shrink-0 items-center justify-between border-b px-4 py-2">
      <div className="flex items-center gap-2">
        <SidebarTrigger />
        <IconButton
          icon={ArrowLeft01Icon}
          label={t("sidebar.allActions")}
          onClick={() => setView("actions-grid")}
        />
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
        {statusNode}
      </div>
      <ButtonGroup>
        {canRerun && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => rerun(currentId!)}
            title={t("main.rerun")}
          >
            <HugeiconsIcon icon={ArrowReloadHorizontalIcon} strokeWidth={1.75} />
            {t("main.rerun")}
          </Button>
        )}
        {canRerun && hasParams && (
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => editRerun(currentId!)}
            title={t("main.editRerun")}
          >
            <HugeiconsIcon icon={PreferenceHorizontalIcon} strokeWidth={1.75} />
          </Button>
        )}
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
      </ButtonGroup>
    </header>
  );
}
