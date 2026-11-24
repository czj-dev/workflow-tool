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
import { Thread, ThreadContent, ThreadScrollToBottom } from "@/components/nexus-ui/thread";
import { AiDiagBlock } from "@/components/ai/AiDiagBlock";
import { AiOutputPanel } from "@/components/ai/AiOutputPanel";
import { fmtDuration } from "../lib/duration";
import { RunStatusBadge } from "./GridCardParts";
import { aiRunSummary, runDurationMs } from "../lib/runs";
import type { ParamSpec } from "../../bindings/workflow-tool/internal/registry/models.js";
import type { RunItem } from "../types/events";

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
//
// 右上角「运行记录」打开这个任务的运行记录抽屉（后端 runs/，跨重启保留）：历次运行，
// 不论是谁发起的（会话页、网格卡、调度）。点一条即把它的会话 id 回填到「续接会话」，
// 并进运行详情查看那一轮的过程——运行详情是全应用唯一查看运行过程的地方。
export function AiChatView() {
  const { t } = useTranslation();
  const {
    aiTasks, currentId, aiDraft, globalConfig, setAiDraftValue,
    runAi, cancel, setView, status, exitInfo, aiText, thinkingText, aiPanel,
    sentPrompt, sentAt, aiDiag, openYamlEditor,
    runsRevision, listRuns, openRun,
  } = useActionRunner();
  const task = aiTasks.find((item) => item.id === currentId);
  const running = status === "running";

  // 运行记录抽屉的开合 + 这个任务的运行记录。runsRevision 变化（任何运行开始 / 结束）时重拉：
  // 调度发起的运行前端没有订阅其输出，只能从这里得知。
  const [runsOpen, setRunsOpen] = useState(false);
  const [runs, setRuns] = useState<RunItem[]>([]);
  useEffect(() => {
    if (!task) return;
    let cancelled = false;
    listRuns({ targetKind: "ai", targetId: task.id })
      .then((items) => { if (!cancelled) setRuns(items); })
      .catch(() => undefined);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, runsRevision]);
  // sentPrompt/sentAt 由 Provider 持有（起跑时冻结在运行捕获里，切走再切回仍在，见
  // ActionRunnerProvider）；组件本地不另存。

  if (!task) return null;

  const initial = initialAiDraft(task, globalConfig);
  const promptValue = aiDraft[AI_PROMPT] ?? "";
  const canRun = aiCanRun(task, aiDraft);
  const hasConversation = running || aiText !== "" || thinkingText !== "" || !!exitInfo;

  // 改一个键：与初值相同就不留补丁（定义 / 全局配置之后变了能自动跟随），否则记入草稿补丁。
  const setDraftValue = (key: string, value: string) => {
    setAiDraftValue(key, value === initial[key] ? undefined : value);
  };

  // 点一条运行记录即「准备续接该会话」：把它的 session id 回填到续接 chip，进运行详情后
  // 也不撤——chip 上看得见、点 × 可清，下一次发送就接着这个会话。
  const showRun = (run: RunItem) => {
    const sessionId = run.outputs?.session_id;
    if (sessionId) setAiDraftValue(AI_RESUME, sessionId);
    openRun(run.id);
  };

  // 当前轮的气泡回显与工序段面板：都来自 Provider 持有的这一轮捕获。
  const shownPrompt = sentPrompt || promptValue;
  const sentAtLabel = sentAt != null ? new Date(sentAt).toLocaleTimeString([], { hour12: false }) : undefined;

  // 诊断输出：本轮运行失败，或 runner 往 stderr 写过东西时展示（后端把 runner 的
  // stdout/stderr 一并下发）。
  const failed = status === "error";
  const showDiag = failed || aiDiag.some((line) => line.stream === "stderr");

  const onSend = () => {
    if (!canRun || running) return;
    // prompt 快照与发送时刻由 Provider 在起跑时冻结（含 ${VAR} 展开），组件不自行维护——
    // 否则切走再切回会丢失气泡回显。
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
          {/* 运行记录入口：右上角 badge + label 并入「运行记录 · N」（aria-label 同步可读） */}
          <IconButton
            icon={Clock01Icon}
            label={
              runs.length > 0
                ? `${t("aiChat.runs")} · ${runs.length}`
                : t("aiChat.runs")
            }
            variant="outline"
            badge={runs.length}
            onClick={() => setRunsOpen((v) => !v)}
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
              <AiOutputPanel prompt={shownPrompt} sentAtLabel={sentAtLabel} state={aiPanel} />
              {showDiag && (
                <AiDiagBlock className="mt-2" failed={failed} error={failed ? exitInfo?.err : undefined} lines={aiDiag} />
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

      {runsOpen && (
        <AiRunsDrawer runs={runs} onSelect={(run) => { showRun(run); setRunsOpen(false); }} onClose={() => setRunsOpen(false)} />
      )}
    </main>
  );
}

interface AiRunsDrawerProps {
  runs: RunItem[];
  onSelect: (run: RunItem) => void;
  onClose: () => void;
}

// 这个任务的运行记录抽屉（最新在前）。每条显示状态、时刻、耗时与发起来源，正文是当次
// 提示词的摘要。运行记录由后端保留策略管理（每个目标 50 次、30 天），这里不提供清空。
function AiRunsDrawer({ runs, onSelect, onClose }: AiRunsDrawerProps) {
  const { t } = useTranslation();
  return (
    <aside className="absolute right-0 top-0 bottom-0 z-40 flex w-80 flex-col border-l bg-card/95 shadow-xl">
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {t("aiChat.runsTitle")} · {runs.length}
        </span>
        <IconButton icon={Cancel01Icon} label={t("main.clear")} onClick={onClose} />
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {runs.length === 0 ? (
          <div className="p-3 text-center text-xs text-muted-foreground">{t("aiChat.runsEmpty")}</div>
        ) : (
          runs.map((run) => {
            const durationMs = runDurationMs(run);
            const summary = aiRunSummary(run);
            return (
              <button
                key={run.id}
                type="button"
                onClick={() => onSelect(run)}
                title={run.reason || undefined}
                className="mb-1.5 flex w-full cursor-pointer flex-col gap-1 rounded-lg border border-border p-2.5 text-left hover:border-primary/50"
              >
                <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                  <RunStatusBadge status={run.status} label={t(`runs.status.${run.status}`, run.status)} />
                  {run.startedAt && <span>{new Date(run.startedAt).toLocaleString()}</span>}
                  {durationMs !== null && <span>· {fmtDuration(durationMs)}</span>}
                  {run.origin !== "manual" && <span>· {t(`runs.origin.${run.origin}`, run.origin)}</span>}
                </span>
                <span className="line-clamp-2 text-xs">{summary ?? t("runs.noPrompt")}</span>
              </button>
            );
          })
        )}
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
