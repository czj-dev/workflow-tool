import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiBrain01Icon,
  ArrowDown01Icon,
  Tick02Icon,
  Cancel01Icon,
  Settings02Icon,
} from "@hugeicons/core-free-icons"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { MessageMarkdown } from "@/components/nexus-ui/message"
import { TextShimmer } from "@/components/nexus-ui/text-shimmer"
import { cn } from "@/lib/utils"
import type { LlmPanelState, LlmSegment } from "./reduceStream"

/** 段间距（px）——轨道线段按此值向下延伸补齐 gap，形成连续轨道 */
const SEG_GAP = 16

function fmtDur(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/** 段头 meta：时长（无计时段省略）· 字数 */
function segMeta(t: TFunction, durationMs: number | null | undefined, chars: number): string {
  const parts = [durationMs != null ? fmtDur(durationMs) : null, t("llmChat.charsUnit", { n: chars })]
  return parts.filter(Boolean).join(" · ")
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function fmtCost(usd: number): string {
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`
}

/**
 * LLM 输出面板（mockup）：把一次 LLM 会话渲染为「指令工单 + 同轨多段读数」。
 * 段序列 = 工序序列（思考 → 工具调用 → 思考 → 回答），共享一条左侧纵向轨道，
 * 运行中的段轨道流动琥珀光斑（复用全局 spine 流光语言），终点是会话读数行。
 */
export function LlmOutputPanel({
  prompt,
  sentAtLabel,
  state,
}: {
  prompt: string
  sentAtLabel?: string
  state: LlmPanelState
}) {
  const { t } = useTranslation()
  const last = state.segments[state.segments.length - 1]
  // 三态契约：null = 进行中，undefined = 历史重建段无计时。必须严格 === null，
  // 宽松 == null 会把历史段误判为 live，导致查看历史时永远显示“生成中”而非完成态。
  const liveIndex = last && last.durationMs === null ? state.segments.length - 1 : -1

  return (
    <div className="flex flex-col" style={{ gap: `${SEG_GAP}px` }}>
      <PromptTicket prompt={prompt} sentAtLabel={sentAtLabel} />

      <div className="flex flex-col" style={{ gap: `${SEG_GAP}px` }}>
        {state.segments.map((seg, i) => (
          <SegmentView key={i} seg={seg} live={i === liveIndex} last={i === state.segments.length - 1} />
        ))}
        {state.readout && <ReadoutLine readout={state.readout} />}
      </div>

      {!state.streaming && !state.readout && state.segments.length === 0 && (
        <div className="flex items-center gap-2 pl-1 font-mono text-[11px] tracking-[0.12em] text-muted-foreground">
          <span className="size-1.5 rounded-full bg-primary/70" />
          {t("llmChat.ready")}
        </div>
      )}
    </div>
  )
}

/** 指令工单：琥珀左竖线 + 等宽 eyebrow + prompt 正文（长文折叠 2 行，点击展开） */
function PromptTicket({ prompt, sentAtLabel }: { prompt: string; sentAtLabel?: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="border-l-2 border-primary/70 bg-primary/6 py-1.5 pe-3 ps-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-start font-mono text-[11px] tracking-[0.12em] text-primary/90"
      >
        <span>{t("llmChat.ticketPrompt")}</span>
        {sentAtLabel && <span className="text-muted-foreground">{sentAtLabel}</span>}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          className={cn("ms-auto size-3.5 opacity-50 transition-transform", open && "rotate-180")}
        />
      </button>
      <div
        className={cn(
          "mt-1 cursor-pointer text-sm leading-relaxed text-foreground/90",
          !open && "line-clamp-2",
        )}
        onClick={() => setOpen((v) => !v)}
      >
        {prompt}
      </div>
    </div>
  )
}

/** 段头节点符号：◇（进行中空心，完成实心小点） */
function NodeDot({ live, tone }: { live?: boolean; tone?: "success" | "destructive" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative z-1 mt-1 grid size-2.5 shrink-0 place-items-center",
        // 白底遮挡轨道线，形成「串在线上的节点」
        "bg-background",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          live ? "bg-primary live-pulse" : tone === "success" ? "bg-success" : tone === "destructive" ? "bg-destructive" : "bg-muted-foreground/60",
        )}
      />
    </span>
  )
}

/** 单段：左侧轨道片段（运行段流光）+ 段头（标签 + 点线 + meta）+ 段体 */
function SegmentView({ seg, live, last }: { seg: LlmSegment; live: boolean; last: boolean }) {
  return (
    <div className="relative ps-5">
      {/* 轨道片段：贯穿本段并向下补齐 gap；运行中流光，其余静态 */}
      <span
        aria-hidden
        className={cn(
          "absolute left-[4px] top-0 w-0.5 rounded-full",
          !last && "h-[calc(100%+16px)]",
          last && "h-full",
          live ? "spine-running" : "bg-border",
        )}
      />
      <span className="absolute left-0 top-0">
        <NodeDot live={live} tone={seg.kind === "tool" && seg.isError ? "destructive" : undefined} />
      </span>
      {seg.kind === "thinking" && <ThinkingSegmentView seg={seg} live={live} />}
      {seg.kind === "tool" && <ToolSegmentView seg={seg} live={live} />}
      {seg.kind === "answer" && <AnswerSegmentView seg={seg} live={live} />}
    </div>
  )
}

/** 段头通用骨架：图标+标签+（点线）+meta。点线把 meta 推到行尾（读数行的 leader dots） */
function SegmentHeader({
  icon,
  label,
  meta,
  live,
  asTrigger,
  open,
}: {
  icon: React.ReactNode
  label: React.ReactNode
  meta?: React.ReactNode
  live?: boolean
  asTrigger?: boolean
  open?: boolean
}) {
  return (
    <div
      data-slot="llm-seg-header"
      className={cn(
        "flex items-center gap-2 font-mono text-[11px] tracking-[0.08em]",
        asTrigger && "cursor-pointer select-none",
      )}
    >
      {icon}
      <span className="text-muted-foreground">{label}</span>
      {meta && (
        <>
          <span aria-hidden className="mb-0.5 h-px flex-1 border-b border-dotted border-border" />
          <span className="shrink-0 text-muted-foreground/90 tabular-nums">{meta}</span>
        </>
      )}
      {asTrigger && (
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          className={cn("size-3.5 opacity-50 transition-transform", open && "rotate-180")}
        />
      )}
      {live && !meta && <span aria-hidden className="mb-0.5 h-px flex-1 border-b border-dotted border-border" />}
    </div>
  )
}

function liveLabel(text: string) {
  return (
    <TextShimmer className="text-[11px] leading-4" spread={8} disableShimmer={false}>
      {text}
    </TextShimmer>
  )
}

function ThinkingSegmentView({ seg, live }: { seg: Extract<LlmSegment, { kind: "thinking" }>; live: boolean }) {
  const { t } = useTranslation()
  const [override, setOverride] = useState<boolean | null>(null)
  const defaultOpen = live // 流式中展开，结算后自动收起
  const open = override ?? defaultOpen
  const meta = live
    ? liveLabel(t("llmChat.thinkingLive"))
    : segMeta(t, seg.durationMs, seg.text.length)

  return (
    <Collapsible open={open} onOpenChange={(v) => setOverride(v)}>
      <CollapsibleTrigger
        render={
          <div>
            <SegmentHeader
              asTrigger
              open={open}
              icon={<HugeiconsIcon icon={AiBrain01Icon} strokeWidth={1.75} className="size-3.5 text-muted-foreground" />}
              label={t("llmChat.segThinking")}
              meta={meta}
            />
          </div>
        }
      />
      <CollapsibleContent className="animate-collapsible-down data-[state=closed]:animate-collapsible-up">
        <div className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          <MessageMarkdown className="text-[13px] leading-relaxed text-muted-foreground">
            {seg.text || "…"}
          </MessageMarkdown>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ToolSegmentView({ seg, live }: { seg: Extract<LlmSegment, { kind: "tool" }>; live: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const meta = live ? (
    liveLabel(t("llmChat.toolRunning"))
  ) : seg.isError ? (
    <span className="text-destructive">✗ {t("llmChat.toolFailed")}</span>
  ) : (
    <span className="inline-flex items-center gap-1">
      <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-3 text-success" />
      {seg.durationMs != null && fmtDur(seg.durationMs)}
    </span>
  )

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={
          <div>
            <SegmentHeader
              asTrigger
              open={open}
              icon={<HugeiconsIcon icon={Settings02Icon} strokeWidth={1.75} className="size-3.5 text-muted-foreground" />}
              label={
                <span className="text-foreground/80">
                  {seg.name}
                  {seg.summary && <span className="text-muted-foreground"> · {seg.summary}</span>}
                </span>
              }
              meta={meta}
            />
          </div>
        }
      />
      <CollapsibleContent className="animate-collapsible-down data-[state=closed]:animate-collapsible-up">
        {seg.result != null && (
          <pre className="mt-1.5 max-h-64 overflow-auto rounded-md bg-muted/60 p-2.5 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
            {seg.result}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function AnswerSegmentView({ seg, live }: { seg: Extract<LlmSegment, { kind: "answer" }>; live: boolean }) {
  const { t } = useTranslation()
  const meta = live
    ? liveLabel(t("llmChat.generatingLive"))
    : segMeta(t, seg.durationMs, seg.text.length)
  return (
    <div>
      <SegmentHeader
        icon={
          <span aria-hidden className="grid size-3.5 place-items-center">
            <span className={cn("size-1.5 rounded-full", live ? "bg-primary" : "bg-foreground/50")} />
          </span>
        }
        label={t("llmChat.segAnswer")}
        meta={meta}
      />
      <div className="mt-1 min-h-4">
        <MessageMarkdown>{seg.text || (live ? "" : "…")}</MessageMarkdown>
      </div>
    </div>
  )
}

/** 轨道终点：会话读数行（总耗时 · tokens · 成本） */
function ReadoutLine({ readout }: { readout: NonNullable<LlmPanelState["readout"]> }) {
  const { t } = useTranslation()
  // 读数分段拼接：后端给了才显示（历史条目只有总时长，无 cost/tokens）
  const parts = [
    readout.durationMs != null ? fmtDur(readout.durationMs) : null,
    readout.inputTokens != null || readout.outputTokens != null
      ? `↑ ${fmtTokens(readout.inputTokens ?? 0)} ↓ ${fmtTokens(readout.outputTokens ?? 0)}`
      : null,
    readout.costUsd != null ? fmtCost(readout.costUsd) : null,
  ].filter(Boolean)
  return (
    <div className="relative ps-5">
      <span
        aria-hidden
        className={cn(
          "absolute left-[4px] top-[5px] size-2.5 rounded-full",
          readout.isError ? "bg-destructive" : "bg-success",
        )}
      />
      <div className="flex items-center gap-2 font-mono text-[11px] tracking-[0.08em] text-muted-foreground tabular-nums">
        {readout.isError ? (
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5 text-destructive" />
        ) : (
          <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-3.5 text-success" />
        )}
        <span className={readout.isError ? "text-destructive" : "text-success"}>{t("llmChat.doneReadout")}</span>
        <span aria-hidden className="mb-0.5 h-px flex-1 border-b border-dotted border-border" />
        {parts.length > 0 && <span>{parts.join(" · ")}</span>}
      </div>
    </div>
  )
}
