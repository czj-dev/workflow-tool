import { useTranslation } from "react-i18next";
import { useActionRunner } from "../hooks/useActionRunner";
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
  const { llmText, thinkingText, status } = useActionRunner();
  return (
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
  );
}
