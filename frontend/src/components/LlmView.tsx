import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";
import { ActionIcon } from "./ActionIcon";
import {
  Message,
  MessageContent,
  MessageMarkdown,
} from "@/components/nexus-ui/message";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/components/nexus-ui/reasoning";
import {
  Thread,
  ThreadContent,
  ThreadScrollToBottom,
} from "@/components/nexus-ui/thread";
import { Skeleton } from "@/components/ui/skeleton";

// LLM 输出区：Thread 自动滚到底；assistant 消息内 Reasoning 展示思考过程（可折叠，
// 流式时展开、完成后收起并显示「Thought for N seconds」），MessageMarkdown 渲染回复正文。
// thinkingText/llmText 由 Provider 按 stream（llm-thinking / llm）分别累加。
export function LlmView() {
  const { t } = useTranslation();
  const { actions, currentId, llmText, thinkingText, status, exitInfo, cancel, setView } = useActionRunner();
  const current = actions.find((a) => a.id === currentId);
  const running = status === "running";

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
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <button
            type="button"
            onClick={() => setView("actions-grid")}
            title={t("sidebar.allActions")}
            className="flex items-center gap-1 rounded px-1 text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={1.75} className="size-4" />
          </button>
          {current && (
            <span className="flex items-center gap-1.5 rounded px-1 font-semibold">
              <ActionIcon name={current.icon ?? "hi:play"} />
              {current.title}
            </span>
          )}
          {statusNode}
        </div>
        {running && (
          <Button variant="destructive" size="sm" onClick={cancel}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.75} className="size-4" />
            {t("main.stop")}
          </Button>
        )}
      </header>
      <Thread className="flex min-w-0 flex-1">
        <ThreadContent className="p-4">
          <Message from="assistant">
            <MessageContent>
              {thinkingText && (
                <Reasoning isStreaming={status === "running"}>
                  <ReasoningTrigger />
                  <ReasoningContent>{thinkingText}</ReasoningContent>
                </Reasoning>
              )}
              <MessageMarkdown>{llmText}</MessageMarkdown>
              {status === "running" && llmText === "" && !thinkingText && (
                <div role="status" className="flex items-center gap-2">
                  <Skeleton className="h-4 w-32" />
                  <span className="sr-only">{t("llm.thinking")}</span>
                </div>
              )}
            </MessageContent>
          </Message>
        </ThreadContent>
        {/* 贴底时自动隐藏，离底时显示悬浮「回到底部」按钮 */}
        <ThreadScrollToBottom />
      </Thread>
    </main>
  );
}
