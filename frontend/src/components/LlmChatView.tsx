import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Cancel01Icon, SentIcon } from "@hugeicons/core-free-icons";
import { Popover } from "radix-ui";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { IconButton } from "./IconButton";
import { ActionIcon } from "./ActionIcon";
import { ParamFields } from "./ParamFields";
import { useActionRunner } from "../hooks/useActionRunner";
import { missingRequired } from "../lib/params";
import { Message, MessageContent, MessageMarkdown } from "@/components/nexus-ui/message";
import { Reasoning, ReasoningTrigger, ReasoningContent } from "@/components/nexus-ui/reasoning";
import { Thread, ThreadContent, ThreadScrollToBottom } from "@/components/nexus-ui/thread";
import type { ParamSpec } from "../../bindings/workflow-tool/internal/registry/models.js";

// 聊天式单页：底部输入框（绑 promptParam）+ 上方流式回答。单轮替换，每次发送清空上一轮。
export function LlmChatView() {
  const { t } = useTranslation();
  const {
    actions, currentId, formValues, setFormValue,
    runAction, cancel, setView, status, exitInfo, llmText, thinkingText,
  } = useActionRunner();
  const action = actions.find((a) => a.id === currentId);
  const running = status === "running";

  if (!action?.llm || !action.params) return null;
  const { systemParam, promptParam } = action.llm;
  const promptSpec = action.params.find((p) => p.id === promptParam);
  if (!promptSpec) return null;

  const contextSpecs = action.params.filter(
    (p) => p.id !== promptParam && p.id !== systemParam,
  );
  const systemSpec = systemParam
    ? action.params.find((p) => p.id === systemParam)
    : null;

  const canRun = missingRequired(action.params, formValues).length === 0;
  const promptValue = formValues[promptParam] ?? promptSpec.default ?? "";
  const hasConversation = running || llmText !== "" || thinkingText !== "" || !!exitInfo;

  const onSend = () => {
    if (!canRun || running) return;
    const params: Record<string, string> = {};
    action.params!.forEach((p) => {
      params[p.id] = formValues[p.id] ?? p.default ?? "";
    });
    runAction(action.id, params);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <IconButton
            icon={ArrowLeft01Icon}
            label={t("llmChat.back")}
            onClick={() => setView("llm-grid")}
          />
          <span className="flex items-center gap-1.5 rounded px-1 font-semibold">
            <ActionIcon name={action.icon ?? "hi:play"} />
            {action.title}
          </span>
          {running ? (
            <span className="inline-flex items-center gap-1.5 font-mono text-xs text-primary">
              <span className="size-1.5 rounded-full bg-primary live-pulse" />
              {t("workflow.running")}
            </span>
          ) : exitInfo ? (
            <span className={`inline-flex items-center gap-1.5 font-mono text-xs ${exitInfo.exitCode === 0 ? "text-success" : "text-destructive"}`}>
              {exitInfo.exitCode === 0 ? t("workflow.done") : t("workflow.error")}
              {exitInfo.duration && <span className="text-muted-foreground">· {exitInfo.duration}</span>}
            </span>
          ) : null}
        </div>
        {running && (
          <Button variant="destructive" size="sm" onClick={cancel}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.75} className="size-4" />
            {t("llmChat.stop")}
          </Button>
        )}
      </header>

      <Thread className="flex min-w-0 flex-1">
        <ThreadContent className="p-4">
          {!hasConversation ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <span className="grid size-11 place-items-center rounded-xl bg-primary/14 text-primary">
                <ActionIcon name={action.icon ?? "hi:play"} className="size-5" />
              </span>
              <div className="text-sm font-semibold">{action.title}</div>
              <div className="max-w-100 text-xs leading-relaxed text-muted-foreground">
                {action.description || t("llmChat.emptyHint")}
              </div>
            </div>
          ) : (
            <>
              <Message from="user">
                <MessageContent>{promptValue}</MessageContent>
              </Message>
              <Message from="assistant">
                <MessageContent>
                  {thinkingText && (
                    <Reasoning isStreaming={running}>
                      <ReasoningTrigger />
                      <ReasoningContent>{thinkingText}</ReasoningContent>
                    </Reasoning>
                  )}
                  <MessageMarkdown>{llmText}</MessageMarkdown>
                  {running && llmText === "" && !thinkingText && (
                    <div role="status" className="flex items-center gap-2">
                      <Skeleton className="h-4 w-32" />
                      <span className="sr-only">{t("llm.thinking")}</span>
                    </div>
                  )}
                </MessageContent>
              </Message>
            </>
          )}
        </ThreadContent>
        <ThreadScrollToBottom />
      </Thread>

      <div className="border-t bg-muted/20 px-4 pt-2.5 pb-3">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {systemSpec && (
            <ContextChip
              label={t("llmChat.roleField")}
              value={formValues[systemSpec.id] ?? systemSpec.default ?? ""}
              spec={systemSpec}
              values={formValues}
              setValue={setFormValue}
              dashed
              configuredLabel={t("llmChat.roleConfigured")}
              emptyLabel={t("llmChat.paramEmpty")}
            />
          )}
          {contextSpecs.map((spec) => (
            <ContextChip
              key={spec.id}
              label={spec.id}
              value={formValues[spec.id] ?? spec.default ?? ""}
              spec={spec}
              values={formValues}
              setValue={setFormValue}
              emptyLabel={t("llmChat.paramEmpty")}
            />
          ))}
        </div>
        <div className="flex flex-col rounded-xl border border-input bg-background focus-within:border-primary/60 focus-within:ring-3 focus-within:ring-primary/12">
          <textarea
            value={promptValue}
            onChange={(e) => setFormValue(promptParam, e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("llmChat.placeholder")}
            className="min-h-16 w-full resize-none bg-transparent px-3 pt-3 pb-1 text-sm leading-relaxed outline-none"
          />
          <div className="flex items-center justify-between gap-2.5 px-2.5 pt-1 pb-2">
            <span className="font-mono text-[10.5px] tracking-[0.05em] text-muted-foreground">
              <Kbd>⌘</Kbd><Kbd>↵</Kbd> {t("llmChat.sendHint")} · <Kbd>⇧</Kbd><Kbd>↵</Kbd> {t("llmChat.newlineHint")}
            </span>
            {running ? (
              <Button variant="destructive" size="sm" onClick={cancel}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.75} className="size-4" />
                {t("llmChat.stop")}
              </Button>
            ) : (
              <Button size="sm" disabled={!canRun} onClick={onSend}>
                <HugeiconsIcon icon={SentIcon} strokeWidth={1.75} className="size-4" />
                {t("llmChat.send")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

// context chip：显示 param 当前值摘要，点击 Popover 打开对应字段编辑。
interface ContextChipProps {
  label: string;
  value: string;
  spec: ParamSpec;
  values: Record<string, string>;
  setValue: (id: string, v: string) => void;
  dashed?: boolean;
  configuredLabel?: string;
  emptyLabel: string;
}

function ContextChip({
  label, value, spec, values, setValue, dashed, configuredLabel, emptyLabel,
}: ContextChipProps) {
  const [open, setOpen] = useState(false);
  const filled = value.trim().length > 0;
  const summary = filled
    ? configuredLabel ?? (value.length > 16 ? value.slice(0, 16) + "…" : value)
    : emptyLabel;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] ${dashed ? "border-dashed" : ""} ${filled ? "border-success/40" : "border-border"} bg-muted/55 text-muted-foreground hover:border-primary/55 hover:text-foreground`}
        >
          {label}
          <b className={`font-medium ${filled ? "text-foreground" : "italic opacity-60"}`}>{summary}</b>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          className="z-50 w-96 rounded-lg border bg-popover p-3 shadow-md"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <ParamFields params={[spec]} values={values} setValue={setValue} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
