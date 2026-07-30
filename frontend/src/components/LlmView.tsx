import { useActionRunner } from "../hooks/useActionRunner";
import {
  Message,
  MessageContent,
  MessageMarkdown,
} from "@/components/nexus-ui/message";

// LLM 输出区：用 nexus-ui Message 渲染累积的 llmText（MessageMarkdown 基于 Streamdown，流式 markdown）。
export function LlmView() {
  const { llmText, status } = useActionRunner();
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-2 overflow-auto p-4">
      <Message from="assistant">
        <MessageContent>
          <MessageMarkdown>{llmText}</MessageMarkdown>
        </MessageContent>
      </Message>
      {status === "running" && llmText === "" && (
        <p className="text-sm text-muted-foreground">思考中…</p>
      )}
    </main>
  );
}
