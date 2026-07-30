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
import { Thread, ThreadContent } from "@/components/nexus-ui/thread";

// LLM 输出区：Thread 自动滚到底；assistant 消息内 Reasoning 展示思考过程（可折叠，
// 流式时展开、完成后收起并显示「Thought for N seconds」），MessageMarkdown 渲染回复正文。
// thinkingText/llmText 由 Provider 按 stream（llm-thinking / llm）分别累加。
export function LlmView() {
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
              <p className="text-sm text-muted-foreground">思考中…</p>
            )}
          </MessageContent>
        </Message>
      </ThreadContent>
    </Thread>
  );
}
