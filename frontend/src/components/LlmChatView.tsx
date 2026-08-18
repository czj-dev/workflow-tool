import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Cancel01Icon, Clock01Icon, SentIcon, Tag01Icon } from "@hugeicons/core-free-icons";
import { Popover } from "radix-ui";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Kbd } from "@/components/ui/kbd";
import { IconButton } from "./IconButton";
import { ActionIcon } from "./ActionIcon";
import { ParamFields } from "./ParamFields";
import { useActionRunner } from "../hooks/useActionRunner";
import { missingRequired } from "../lib/params";
import { expandVars } from "../lib/vars";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { Thread, ThreadContent, ThreadScrollToBottom } from "@/components/nexus-ui/thread";
import { LlmOutputPanel } from "@/components/llm/LlmOutputPanel";
import { panelFromHistory } from "@/components/llm/reduceStream";
import type { ParamSpec } from "../../bindings/workflow-tool/internal/registry/models.js";
import { type LlmHistoryEntry } from "../hooks/useLlmHistory";

// 聊天式单页：底部输入框（绑 promptParam）+ 上方流式回答。单轮替换，每次发送清空上一轮。
export function LlmChatView() {
  const { t } = useTranslation();
  const {
    actions, currentId, formValues, setFormValue,
    runAction, cancel, setView, status, exitInfo, llmText, thinkingText, llmPanel,
    llmHistory, clearLlmHistory,
  } = useActionRunner();
  const action = actions.find((a) => a.id === currentId);
  const running = status === "running";

  // 历史抽屉 + 只读查看态
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewing, setViewing] = useState<LlmHistoryEntry | null>(null);
  // prompt 快照：send 时冻结，避免流式中编辑 textarea 导致 user 气泡漂移
  const [sentPrompt, setSentPrompt] = useState("");
  // 发送时刻：指令工单的时间读数（历史查看态用 entry.timestamp）
  const [sentAt, setSentAt] = useState<number | null>(null);

  // 切换卡片（currentId 变化）时重置查看态，避免 viewing/sentPrompt 跨卡片残留。
  // 用 render-time setState 模式（参见 ActionYamlEditor、React 官方「You Might Not Need an Effect」）：
  // 比 useEffect 早一帧生效，且不触发级联渲染（react-hooks/set-state-in-effect）。
  const [prevId, setPrevId] = useState(currentId);
  if (currentId !== prevId) {
    setPrevId(currentId);
    setViewing(null);
    setSentPrompt("");
    setSentAt(null);
  }

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

  // canRun 用 default 兜底后再判必填，与 onSend 里 `formValues[p.id] ?? p.default` 的合并语义对齐；
  // 否则带 default 的必填 param（如 claude-card-transfrom 的 ROLE/TASK）用户没点开编辑时按钮会一直置灰。
  const effectiveValues: Record<string, string> = {};
  action.params.forEach((p) => {
    effectiveValues[p.id] = formValues[p.id] ?? p.default ?? "";
  });
  const canRun = missingRequired(action.params, effectiveValues).length === 0;
  const promptValue = formValues[promptParam] ?? promptSpec.default ?? "";
  const hasConversation = running || llmText !== "" || thinkingText !== "" || !!exitInfo || !!viewing;

  // viewing 非空时渲染只读历史条目，否则渲染当前轮
  // 历史条目存的是发送时的原始模板（可能含 ${VAR}）；只读查看时按其 params 快照展开，
  // 与实时气泡（sentPrompt 已 expandVars）保持一致，避免历史里出现 "处理 ${CARD_ID}"。
  const shownPrompt = viewing ? expandVars(viewing.prompt, viewing.params) : sentPrompt || promptValue;
  // 工序段面板：实时态用归约状态；历史态由条目重建（无段级计时，读数只有总时长）
  const shownPanel = viewing ? panelFromHistory(viewing) : llmPanel;
  const shownAt = viewing ? viewing.timestamp : sentAt;
  const sentAtLabel = shownAt != null ? new Date(shownAt).toLocaleTimeString([], { hour12: false }) : undefined;

  const onSend = () => {
    if (!canRun || running) return;
    const params: Record<string, string> = {};
    action.params!.forEach((p) => {
      params[p.id] = formValues[p.id] ?? p.default ?? "";
    });
    // 展示用 prompt 要和后端 ExpandParams 一致地替换 ${VAR}——否则气泡里出现原始模板
    // （如 "处理 ${CARD_ID} 卡片"）。expandVars 与 runner.Expand 行为对齐：未命中保留原样。
    setSentPrompt(expandVars(params[promptParam] ?? "", params));
    // 事件处理器内取当前时刻（非 render 路径），purity 规则误报，局部豁免
    // eslint-disable-next-line react-hooks/purity
    setSentAt(Date.now());
    setViewing(null);
    runAction(action.id, params);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSend();
    }
  };

  // 应用预设：把 preset.values 写入对应 param 的 formValue（同 selectPreset 的合并语义，
  // 但不切视图/不动 currentId——聊天页留在原地，只是把值填进 composer）。
  const applyPreset = (values: Record<string, string | undefined>) => {
    Object.entries(values).forEach(([id, v]) => setFormValue(id, v ?? ""));
  };

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {viewing && (
        <div className="flex items-center gap-2 border-b border-primary/25 bg-primary/10 px-4 py-1.5 text-xs">
          <HugeiconsIcon icon={Clock01Icon} strokeWidth={1.75} className="size-3.5" />
          <span>{t("llmChat.viewingHistory")} · {new Date(viewing.timestamp).toLocaleString()}</span>
          {viewing.sessionId && (
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(viewing.sessionId!)}
              title={t("llmChat.sessionIdCopy", { id: viewing.sessionId })}
              className="max-w-56 truncate rounded font-mono text-[10.5px] tracking-[0.03em] text-muted-foreground hover:text-foreground cursor-pointer"
            >
              {t("llmChat.sessionId")} {viewing.sessionId}
            </button>
          )}
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
          <button
            type="button"
            onClick={() => setView("edit")}
            title={t("edit.tooltip")}
            className="flex items-center gap-1.5 rounded px-1 font-semibold hover:bg-accent cursor-pointer"
          >
            <ActionIcon name={action.icon ?? "hi:play"} />
            {action.title}
          </button>
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

      {/* min-h-0：Thread 基类带 h-full（height:100%），作为 flex 子项且 min-height:auto 时
          会被 100% 高度托底而不收缩，把 composer 挤出视口、末尾读数行被裁掉。 */}
      <Thread className="flex min-h-0 min-w-0 flex-1">
        {/* 历史查看切换时 ThreadContent 整段替换，stick-to-bottom 的贴底状态可能在替换瞬间
            失效（滚动位置被钳制），显式滚到底保证「完成 · 时长」读数行可见。 */}
        <ThreadViewingScroll trigger={viewing?.id ?? null} />
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
            <LlmOutputPanel prompt={shownPrompt} sentAtLabel={sentAtLabel} state={shownPanel} />
          )}
        </ThreadContent>
        <ThreadScrollToBottom />
      </Thread>

      <div className="border-t bg-muted/20 px-4 pt-2.5 pb-3">
        {action.presets && action.presets.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {action.presets.map((p) => (
              <button
                key={p.name}
                type="button"
                title={p.description || p.name}
                onClick={() => applyPreset(p.values as Record<string, string | undefined>)}
                className="inline-flex items-center gap-1 rounded-md border border-dashed bg-muted/60 px-2 py-1 font-mono text-[11px] tracking-[0.02em] text-muted-foreground hover:border-primary/60 hover:bg-primary/8 hover:text-foreground"
              >
                <HugeiconsIcon icon={Tag01Icon} strokeWidth={1.75} className="size-3" />
                {p.name}
              </button>
            ))}
          </div>
        )}
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

// Thread 内挂载的滚动控制点：trigger 变化（进入/切换/退出历史查看）时滚到底。
// 必须在 <Thread> 内部使用（依赖 useStickToBottomContext）。
function ThreadViewingScroll({ trigger }: { trigger: string | null }) {
  const { scrollToBottom } = useStickToBottomContext();
  useEffect(() => {
    scrollToBottom();
  }, [trigger, scrollToBottom]);
  return null;
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
              <span className="line-clamp-2 text-xs">{expandVars(e.prompt, e.params)}</span>
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
  const summary = filled ? configuredLabel ?? value : emptyLabel;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`inline-flex max-w-56 items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] ${dashed ? "border-dashed" : ""} ${filled ? "border-success/40" : "border-border"} bg-muted/55 text-muted-foreground hover:border-primary/55 hover:text-foreground`}
        >
          <span className="shrink-0">{label}</span>
          <b className={`min-w-0 truncate font-medium ${filled ? "text-foreground" : "italic opacity-60"}`}>{summary}</b>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          // 固定向上开：chip 位于底部 composer，向下没有空间，翻转会导致方向忽上忽下。
          // align="start" 锚定左边缘，chip 宽度随输入变化时弹窗不再横向漂移。
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 w-96 rounded-lg border bg-popover p-3 shadow-md"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <ParamFields params={[spec]} values={values} setValue={setValue} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
