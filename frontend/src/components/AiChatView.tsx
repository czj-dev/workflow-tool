import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  Cancel01Icon,
  Clock01Icon,
  SentIcon,
  Tag01Icon,
} from "@hugeicons/core-free-icons";
import { Popover } from "radix-ui";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Kbd } from "@/components/ui/kbd";
import { IconButton } from "./IconButton";
import { ActionIcon } from "./ActionIcon";
import { ParamFields } from "./ParamFields";
import { useActionRunner } from "../hooks/useActionRunner";
import {
  AI_PROMPT,
  AI_RESUME,
  AI_SYSTEM,
  aiCanRun,
  initialAiDraft,
  taskParams,
} from "../lib/ai";
import { expandVars } from "../lib/vars";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { Thread, ThreadContent, ThreadScrollToBottom } from "@/components/nexus-ui/thread";
import { AiOutputPanel } from "@/components/ai/AiOutputPanel";
import { panelFromHistory } from "@/components/ai/reduceStream";
import type { ParamSpec } from "../../bindings/workflow-tool/internal/registry/models.js";
import { type AiHistoryEntry } from "../hooks/useAiHistory";

// 系统提示词 chip 的字段规格：system 是 RunAi 的保留参数，不在任务 params 里声明，
// 这里合成一份只为复用 ParamFields 的多行输入。
const SYSTEM_SPEC: ParamSpec = {
  id: AI_SYSTEM,
  label: "",
  type: "textarea",
  required: false,
  default: "",
  options: [],
  description: undefined,
};

// 某个 AI 任务的会话页：底部输入框（绑 prompt 草稿）+ 上方流式回答。单轮替换，每次发送
// 清空上一轮。草稿（prompt / system / 续接会话 / 已声明参数）由 Provider 按任务持有，
// 本组件只读写；缺必填输入时发送按钮置灰。
export function AiChatView() {
  const { t } = useTranslation();
  const {
    aiTasks, currentId, aiDraft, globalConfig, setAiDraftValue,
    runAi, cancel, setView, status, exitInfo, aiText, thinkingText, aiPanel,
    sentPrompt, sentAt, aiDiag, aiHistory, clearAiHistory, openYamlEditor,
  } = useActionRunner();
  const task = aiTasks.find((item) => item.id === currentId);
  const running = status === "running";

  // 历史抽屉 + 只读查看态
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewing, setViewing] = useState<AiHistoryEntry | null>(null);
  // sentPrompt/sentAt 由 Provider 持有（起跑时冻结在运行捕获里，切走再切回仍在，见
  // ActionRunnerProvider）——组件本地只保留 viewing（与本组件生命周期绑定即可）。

  // 切换卡片（currentId 变化）时重置查看态，避免 viewing 跨卡片残留。
  // 用 render-time setState 模式（参见 ActionYamlEditor、React 官方「You Might Not Need an Effect」）：
  // 比 useEffect 早一帧生效，且不触发级联渲染（react-hooks/set-state-in-effect）。
  const [prevId, setPrevId] = useState(currentId);
  if (currentId !== prevId) {
    setPrevId(currentId);
    setViewing(null);
  }

  if (!task) return null;

  const initial = initialAiDraft(task, globalConfig);
  const promptValue = aiDraft[AI_PROMPT] ?? "";
  const canRun = aiCanRun(task, aiDraft);
  const hasConversation = running || aiText !== "" || thinkingText !== "" || !!exitInfo || !!viewing;

  // 改一个键：与初值相同就不留补丁（定义 / 全局配置之后变了能自动跟随），否则记入草稿补丁。
  const setDraftValue = (key: string, value: string) => {
    setAiDraftValue(key, value === initial[key] ? undefined : value);
  };

  // 查看历史即「准备续接该会话」：把条目的 session id 回填到续接 chip，退出查看也不撤——
  // chip 上看得见、点 × 可清，下一次发送就接着这个会话。
  const showHistory = (e: AiHistoryEntry | null) => {
    setViewing(e);
    if (e?.sessionId) setAiDraftValue(AI_RESUME, e.sessionId);
  };

  // viewing 非空时渲染只读历史条目，否则渲染当前轮
  // 历史条目存的是发送时的原始模板（可能含 ${VAR}）；只读查看时按其 params 快照展开，
  // 与实时气泡（sentPrompt 已 expandVars）保持一致，避免历史里出现 "处理 ${CARD_ID}"。
  const shownPrompt = viewing ? expandVars(viewing.prompt, viewing.params) : sentPrompt || promptValue;
  // 工序段面板：实时态用归约状态；历史态由条目重建（无段级计时，读数只有总时长）
  const shownPanel = viewing ? panelFromHistory(viewing) : aiPanel;
  const shownAt = viewing ? viewing.timestamp : sentAt;
  const sentAtLabel = shownAt != null ? new Date(shownAt).toLocaleTimeString([], { hour12: false }) : undefined;

  // 诊断输出：本轮运行失败，或 runner 往 stderr 写过东西时展示（后端把 runner 的
  // stdout/stderr 一并下发）。历史查看态下不展示——那是别的轮次。
  const failed = !viewing && status === "error";
  const showDiag = !viewing && (failed || aiDiag.some((line) => line.stream === "stderr"));

  const onSend = () => {
    if (!canRun || running) return;
    // prompt 快照与发送时刻由 Provider 在起跑时冻结（含 ${VAR} 展开），组件不自行维护——
    // 否则切走再切回会丢失气泡回显。
    setViewing(null);
    void runAi(task.id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSend();
    }
  };

  // 应用预设：把 preset.values 写入草稿（同 selectPreset 的合并语义，但不切视图——会话页
  // 留在原地，只是把值填进输入框 / chips）。只覆写预设显式给出的键，其余保留。
  const applyPreset = (values: Record<string, string> | undefined) => {
    Object.entries(values ?? {}).forEach(([id, v]) => setDraftValue(id, v ?? ""));
  };

  const icon = task.icon || "hi:ai";

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {viewing && (
        <div className="flex items-center gap-2 border-b border-primary/25 bg-primary/10 px-4 py-1.5 text-xs">
          <HugeiconsIcon icon={Clock01Icon} strokeWidth={1.75} className="size-3.5" />
          <span>{t("aiChat.viewingHistory")} · {new Date(viewing.timestamp).toLocaleString()}</span>
          {viewing.sessionId && (
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(viewing.sessionId!)}
              title={t("aiChat.sessionIdCopy", { id: viewing.sessionId })}
              className="max-w-56 truncate rounded font-mono text-[10.5px] tracking-[0.03em] text-muted-foreground hover:text-foreground cursor-pointer"
            >
              {t("aiChat.sessionId")} {viewing.sessionId}
            </button>
          )}
          <Button variant="ghost" size="sm" className="ml-auto h-6" onClick={() => showHistory(null)}>
            {t("aiChat.backToCurrent")}
          </Button>
        </div>
      )}
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <IconButton
            icon={ArrowLeft01Icon}
            label={t("aiChat.back")}
            onClick={() => setView("ai-grid")}
          />
          <button
            type="button"
            // 点标题进该任务的 YAML 编辑页（退出回到本会话页）
            onClick={() => openYamlEditor(task.id, "ai")}
            title={t("edit.tooltip")}
            className="flex items-center gap-1.5 rounded px-1 font-semibold hover:bg-accent cursor-pointer"
          >
            <ActionIcon name={icon} />
            {task.title}
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
        <ButtonGroup>
          {/* 历史计数：右上角 badge + label 并入「历史 · N」（aria-label 同步可读） */}
          <IconButton
            icon={Clock01Icon}
            label={
              aiHistory.length > 0
                ? `${t("aiChat.history")} · ${aiHistory.length}`
                : t("aiChat.history")
            }
            variant="outline"
            badge={aiHistory.length}
            onClick={() => setHistoryOpen((v) => !v)}
          />
          {running && (
            <IconButton
              icon={Cancel01Icon}
              label={t("aiChat.stop")}
              variant="destructive"
              onClick={cancel}
            />
          )}
        </ButtonGroup>
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
                <ActionIcon name={icon} className="size-5" />
              </span>
              <div className="text-sm font-semibold">{task.title}</div>
              <div className="max-w-100 text-xs leading-relaxed text-muted-foreground">
                {task.description || t("aiChat.emptyHint")}
              </div>
            </div>
          ) : (
            <>
              <AiOutputPanel prompt={shownPrompt} sentAtLabel={sentAtLabel} state={shownPanel} />
              {showDiag && (
                <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 font-mono text-[11px] leading-relaxed">
                  <div className="mb-1 flex items-center gap-1.5 font-semibold text-destructive">
                    <span className="size-1.5 rounded-full bg-destructive" />
                    {failed ? t("aiChat.runFailed") : t("aiChat.diagnostics")}
                  </div>
                  {failed && exitInfo?.err && (
                    <div className="mb-1 whitespace-pre-wrap break-all text-destructive">{exitInfo.err}</div>
                  )}
                  {aiDiag.map((line, i) => (
                    <div key={i} className="whitespace-pre-wrap break-all text-muted-foreground">
                      {line.stream === "stderr" ? t("output.stderrPrefix") : ""}
                      {line.text}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </ThreadContent>
        <ThreadScrollToBottom />
      </Thread>

      <div className="border-t bg-muted/20 px-4 pt-2.5 pb-3">
        {task.presets && task.presets.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {task.presets.map((p) => (
              <button
                key={p.name}
                type="button"
                title={p.description || p.name}
                onClick={() => applyPreset(p.values as Record<string, string> | undefined)}
                className="inline-flex items-center gap-1 rounded-md border border-dashed bg-muted/60 px-2 py-1 font-mono text-[11px] tracking-[0.02em] text-muted-foreground hover:border-primary/60 hover:bg-primary/8 hover:text-foreground"
              >
                <HugeiconsIcon icon={Tag01Icon} strokeWidth={1.75} className="size-3" />
                {p.name}
              </button>
            ))}
          </div>
        )}
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <ResumeChip value={aiDraft[AI_RESUME] ?? ""} onChange={(v) => setDraftValue(AI_RESUME, v)} />
          <ContextChip
            label={t("aiChat.roleField")}
            value={aiDraft[AI_SYSTEM] ?? ""}
            spec={SYSTEM_SPEC}
            values={aiDraft}
            setValue={setDraftValue}
            dashed
            configuredLabel={t("aiChat.roleConfigured")}
            emptyLabel={t("aiChat.paramEmpty")}
          />
          {taskParams(task).map((spec) => (
            <ContextChip
              key={spec.id}
              label={spec.label || spec.id}
              value={aiDraft[spec.id] ?? ""}
              spec={spec}
              values={aiDraft}
              setValue={setDraftValue}
              emptyLabel={t("aiChat.paramEmpty")}
            />
          ))}
        </div>
        <div className="flex flex-col rounded-xl border border-input bg-background focus-within:border-primary/60 focus-within:ring-3 focus-within:ring-primary/12">
          <textarea
            value={promptValue}
            onChange={(e) => setDraftValue(AI_PROMPT, e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("aiChat.placeholder")}
            className="min-h-16 w-full resize-none bg-transparent px-3 pt-3 pb-1 text-sm leading-relaxed outline-none"
          />
          <div className="flex items-center justify-between gap-2.5 px-2.5 pt-1 pb-2">
            <span className="font-mono text-[10.5px] tracking-[0.05em] text-muted-foreground">
              <Kbd>⌘</Kbd><Kbd>↵</Kbd> {t("aiChat.sendHint")} · <Kbd>⇧</Kbd><Kbd>↵</Kbd> {t("aiChat.newlineHint")}
            </span>
            {running ? (
              <Button variant="destructive" size="sm" onClick={cancel}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.75} className="size-4" />
                {t("aiChat.stop")}
              </Button>
            ) : (
              <Button size="sm" disabled={!canRun} onClick={onSend}>
                <HugeiconsIcon icon={SentIcon} strokeWidth={1.75} className="size-4" />
                {t("aiChat.send")}
              </Button>
            )}
          </div>
        </div>
      </div>

      {historyOpen && (
        <AiHistoryDrawer
          entries={aiHistory}
          viewingId={viewing?.id ?? null}
          onSelect={(e) => { showHistory(e); setHistoryOpen(false); }}
          onClose={() => setHistoryOpen(false)}
          onClear={() => { clearAiHistory(); showHistory(null); }}
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

interface AiHistoryDrawerProps {
  entries: AiHistoryEntry[];
  viewingId: string | null;
  onSelect: (e: AiHistoryEntry) => void;
  onClose: () => void;
  onClear: () => void;
}

function AiHistoryDrawer({ entries, viewingId, onSelect, onClose, onClear }: AiHistoryDrawerProps) {
  const { t } = useTranslation();
  return (
    <aside className="absolute right-0 top-0 bottom-0 z-40 flex w-80 flex-col border-l bg-card/95 shadow-xl">
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {t("aiChat.historyTitle")} · {entries.length}
        </span>
        <IconButton icon={Cancel01Icon} label={t("main.clear")} onClick={onClose} />
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {entries.length === 0 ? (
          <div className="p-3 text-center text-xs text-muted-foreground">{t("aiChat.historyEmpty")}</div>
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
        <span className="font-mono text-[10px] text-muted-foreground">{t("aiChat.historyMax")}</span>
        <button
          type="button"
          onClick={onClear}
          className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-destructive"
        >
          {t("aiChat.historyClear")}
        </button>
      </div>
    </aside>
  );
}

// 续接会话 chip：有值 = 接着该会话继续（显示会话 id，右侧 × 清除回到新会话）；
// 无值 = 虚线「新会话」。点 chip 在 Popover 里直接编辑会话 id。
function ResumeChip({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const filled = value.trim().length > 0;
  return (
    <span className="inline-flex max-w-72 items-center">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={`inline-flex min-w-0 items-center gap-1.5 border px-2 py-1 font-mono text-[11px] bg-muted/55 text-muted-foreground hover:border-primary/55 hover:text-foreground ${
              filled ? "rounded-l-md border-success/40" : "rounded-md border-dashed border-border"
            }`}
          >
            <span className="shrink-0">{t("aiChat.resumeField")}</span>
            <b className={`min-w-0 truncate font-medium ${filled ? "text-foreground" : "italic opacity-60"}`}>
              {filled ? value : t("aiChat.resumeEmpty")}
            </b>
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            className="z-50 w-96 rounded-lg border bg-popover p-3 shadow-md"
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <div className="mb-1.5 font-mono text-[11px] font-semibold text-muted-foreground">
              {t("aiChat.resumeField")}
            </div>
            <textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-md border border-input bg-background px-2.5 py-2 font-mono text-xs outline-none focus:border-primary/60"
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {filled && (
        <button
          type="button"
          title={t("aiChat.resumeClear")}
          aria-label={t("aiChat.resumeClear")}
          onClick={() => onChange("")}
          className="flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-r-md border border-l-0 border-success/40 bg-muted/55 text-muted-foreground hover:text-destructive"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.75} className="size-3" />
        </button>
      )}
    </span>
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
