import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Cancel01Icon, Clock01Icon, SentIcon } from "@hugeicons/core-free-icons";
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
import { type LlmHistoryEntry } from "../hooks/useLlmHistory";

// 聊天式单页：底部输入框（绑 promptParam）+ 上方流式回答。单轮替换，每次发送清空上一轮。
export function LlmChatView() {
  const { t } = useTranslation();
  const {
    actions, currentId, formValues, setFormValue,
    runAction, cancel, setView, status, exitInfo, llmText, thinkingText,
    llmHistory, clearLlmHistory,
  } = useActionRunner();
  const action = actions.find((a) => a.id === currentId);
  const running = status === "running";

  // 历史抽屉 + 只读查看态
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewing, setViewing] = useState<LlmHistoryEntry | null>(null);
  // prompt 快照：send 时冻结，避免流式中编辑 textarea 导致 user 气泡漂移
  const [sentPrompt, setSentPrompt] = useState("");

  // 切换卡片（currentId 变化）时重置查看态，避免 viewing/sentPrompt 跨卡片残留
  useEffect(() => {
    setViewing(null);
    setSentPrompt("");
  }, [currentId]);

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
  const hasConversation = running || llmText !== "" || thinkingText !== "" || !!exitInfo || !!viewing;

  // viewing 非空时渲染只读历史条目，否则渲染当前轮
  const shownPrompt = viewing ? viewing.prompt : sentPrompt || promptValue;
  const shownText = viewing ? viewing.response : llmText;
  const shownThinking = viewing ? viewing.thinking : thinkingText;
  const shownStreaming = viewing ? false : running;

  const onSend = () => {
    if (!canRun || running) return;
    const params: Record<string, string> = {};
    action.params!.forEach((p) => {
      params[p.id] = formValues[p.id] ?? p.default ?? "";
    });
    setSentPrompt(params[promptParam] ?? "");
    setViewing(null);
    runAction(action.id, params);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {viewing && (
        <div className="flex items-center gap-2 border-b border-primary/25 bg-primary/10 px-4 py-1.5 text-xs">
          <HugeiconsIcon icon={Clock01Icon} strokeWidth={1.75} className="size-3.5" />
          <span>{t("llmChat.viewingHistory")} · {new Date(viewing.timestamp).toLocaleString()}</span>
          <Button variant="ghost" size="sm" className="ml-auto h-6" onClick={() => setViewing(null)}>
            {t("llmChat.backToCurrent")}
          </Button>
        </div>
      )}
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
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setHistoryOpen((v) => !v)}>
            <HugeiconsIcon icon={Clock01Icon} strokeWidth={1.75} className="size-4" />
            {t("llmChat.history")}
            {llmHistory.length > 0 && (
              <span className="ml-1 font-mono text-[11px] tabular-nums">{llmHistory.length}</span>
            )}
          </Button>
          {running && (
            <Button variant="destructive" size="sm" onClick={cancel}>
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.75} className="size-4" />
              {t("llmChat.stop")}
            </Button>
          )}
        </div>
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
                <MessageContent>{shownPrompt}</MessageContent>
              </Message>
              <Message from="assistant">
                <MessageContent>
                  {shownThinking && (
                    <Reasoning isStreaming={shownStreaming}>
                      <ReasoningTrigger />
                      <ReasoningContent>{shownThinking}</ReasoningContent>
                    </Reasoning>
                  )}
                  <MessageMarkdown>{shownText}</MessageMarkdown>
                  {shownStreaming && shownText === "" && !shownThinking && (
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

      {historyOpen && (
        <LlmHistoryDrawer
          entries={llmHistory}
          viewingId={viewing?.id ?? null}
          onSelect={(e) => { setViewing(e); setHistoryOpen(false); }}
          onClose={() => setHistoryOpen(false)}
          onClear={() => { clearLlmHistory(); setViewing(null); }}
        />
      )}
    </main>
  );
}

interface LlmHistoryDrawerProps {
  entries: LlmHistoryEntry[];
  viewingId: string | null;
  onSelect: (e: LlmHistoryEntry) => void;
  onClose: () => void;
  onClear: () => void;
}

function LlmHistoryDrawer({ entries, viewingId, onSelect, onClose, onClear }: LlmHistoryDrawerProps) {
  const { t } = useTranslation();
  return (
    <aside className="absolute right-0 top-0 bottom-0 z-40 flex w-80 flex-col border-l bg-card/95 shadow-xl">
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {t("llmChat.historyTitle")} · {entries.length}
        </span>
        <IconButton icon={Cancel01Icon} label={t("main.clear")} onClick={onClose} />
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {entries.length === 0 ? (
          <div className="p-3 text-center text-xs text-muted-foreground">{t("llmChat.historyEmpty")}</div>
        ) : (
          entries.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => onSelect(e)}
              className={`mb-1.5 flex w-full flex-col gap-1 rounded-lg border p-2.5 text-left hover:border-primary/50 ${viewingId === e.id ? "border-primary bg-primary/8" : "border-border"}`}
            >
              <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                <span className={`size-1.5 rounded-full ${e.exitCode === 0 ? "bg-success" : "bg-destructive"}`} />
                {new Date(e.timestamp).toLocaleString()}
                {e.duration && <span>· {e.duration}</span>}
              </span>
              <span className="line-clamp-2 text-xs">{e.prompt}</span>
              <span className="line-clamp-1 text-[11px] text-muted-foreground">{e.response}</span>
            </button>
          ))
        )}
      </div>
      <div className="flex items-center justify-between border-t px-3 py-2">
        <span className="font-mono text-[10px] text-muted-foreground">{t("llmChat.historyMax")}</span>
        <button
          type="button"
          onClick={onClear}
          className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-destructive"
        >
          {t("llmChat.historyClear")}
        </button>
      </div>
    </aside>
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
