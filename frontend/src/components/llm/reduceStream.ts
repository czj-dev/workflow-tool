// stream-json 事件 → LLM 输出面板渲染状态的归约器（纯函数，无 React 依赖）。
// 这是后端 runner.parseLLMLine 的前端扩展版：除 text/thinking 增量外，还归约
// tool_use / tool_result（工具调用对）与 result（会话读数）——后端目前丢弃这三类事件，
// 接入时由 Provider 按同样规则喂事件即可，面板组件不感知 mock/真实来源。

/** 一行 stream-json 解析出的语义事件；null = 该行无面板关心的内容（init/hook 等）。 */
export type ParsedEvent =
  | { kind: "thinking"; delta: string }
  | { kind: "text"; delta: string }
  | { kind: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; id: string; content: string; isError?: boolean }
  | {
      kind: "result"
      durationMs: number
      inputTokens: number
      outputTokens: number
      costUsd: number
      isError: boolean
    }

interface StreamContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

interface StreamLine {
  type?: string
  subtype?: string
  message?: { content?: StreamContentBlock[] }
  duration_ms?: number
  total_cost_usd?: number
  usage?: { input_tokens?: number; output_tokens?: number }
}

/** 解析一行 stream-json。与 runner.parseLLMLine 同构，但保留工具调用对与 result 读数。 */
export function parseStreamLine(line: string): ParsedEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let ev: StreamLine
  try {
    ev = JSON.parse(trimmed) as StreamLine
  } catch {
    return null
  }

  if (ev.type === "assistant" && ev.message?.content) {
    for (const c of ev.message.content) {
      if (c.type === "text" && c.text) return { kind: "text", delta: c.text }
      if (c.type === "thinking" && c.thinking) return { kind: "thinking", delta: c.thinking }
      if (c.type === "tool_use" && c.id && c.name)
        return { kind: "tool_use", id: c.id, name: c.name, input: c.input ?? {} }
    }
    return null
  }

  if (ev.type === "user" && ev.message?.content) {
    for (const c of ev.message.content) {
      if (c.type === "tool_result" && c.tool_use_id) {
        return {
          kind: "tool_result",
          id: c.tool_use_id,
          content: extractContent(c.content),
          isError: c.is_error === true,
        }
      }
    }
    return null
  }

  if (ev.type === "result") {
    return {
      kind: "result",
      durationMs: ev.duration_ms ?? 0,
      inputTokens: ev.usage?.input_tokens ?? 0,
      outputTokens: ev.usage?.output_tokens ?? 0,
      costUsd: ev.total_cost_usd ?? 0,
      isError: ev.subtype != null && ev.subtype !== "success",
    }
  }

  return null
}

/** 面板渲染段：thinking 与 tool 交替出现时各自新开一段（工序序列，不续接旧段）。 */
export interface SegmentBase {
  /** 本段开始时刻（ms，事件时间轴）；历史重建段为 0 */
  startedAt: number
  /** 结算后的段耗时；null = 进行中，undefined = 无计时（历史重建段，段头只显示字数） */
  durationMs: number | null | undefined
}

export interface ThinkingSegment extends SegmentBase {
  kind: "thinking"
  text: string
}

export interface ToolSegment extends SegmentBase {
  kind: "tool"
  id: string
  name: string
  /** 工具主参数摘要（如 Read → package.json） */
  summary: string
  result?: string
  isError?: boolean
}

export interface AnswerSegment extends SegmentBase {
  kind: "answer"
  text: string
}

export type LlmSegment = ThinkingSegment | ToolSegment | AnswerSegment

/** 会话终点读数（done 事件附带）；字段后端给了才显示 */
export interface SessionReadout {
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  isError: boolean
}

export interface LlmPanelState {
  segments: LlmSegment[]
  readout: SessionReadout | null
  streaming: boolean
}

export const EMPTY_PANEL_STATE: LlmPanelState = { segments: [], readout: null, streaming: false }

/** 结算 segments 末段（若有）的耗时 */
function settleLast(segments: LlmSegment[], atMs: number): LlmSegment[] {
  if (segments.length === 0) return segments
  const last = segments[segments.length - 1]
  if (last.durationMs != null) return segments
  const settled = { ...last, durationMs: Math.max(0, atMs - last.startedAt) }
  return [...segments.slice(0, -1), settled]
}

/** 从 tool input 提取主参数摘要：第一个字符串值；路径取末段 */
function summarizeInput(input: Record<string, unknown>): string {
  for (const v of Object.values(input)) {
    if (typeof v !== "string" || !v) continue
    const parts = v.split(/[\\/]/).filter(Boolean)
    return parts.length > 1 ? (parts[parts.length - 1] ?? v) : v
  }
  return ""
}

/**
 * 应用一个事件（atMs 为该事件的时间轴时刻）。
 * 规则：
 *  - thinking/text：末段同 kind 则续接，否则结算末段并新开
 *  - tool_use：结算末段，新开 tool 段（等待结果）
 *  - tool_result：按 id 回填对应 tool 段（不一定是末段——交错思考时）
 *  - result：结算末段、写入读数、流式结束
 */
export function applyEvent(state: LlmPanelState, ev: ParsedEvent, atMs: number): LlmPanelState {
  switch (ev.kind) {
    case "thinking":
    case "text": {
      const segments = [...state.segments]
      const last = segments[segments.length - 1]
      const wantKind = ev.kind === "thinking" ? "thinking" : "answer"
      if (last && last.kind === wantKind && last.durationMs == null) {
        segments[segments.length - 1] = { ...last, text: last.text + ev.delta }
        return { ...state, segments, streaming: true }
      }
      const settled = settleLast(segments, atMs)
      const seg: LlmSegment =
        wantKind === "thinking"
          ? { kind: "thinking", startedAt: atMs, durationMs: null, text: ev.delta }
          : { kind: "answer", startedAt: atMs, durationMs: null, text: ev.delta }
      return { segments: [...settled, seg], readout: null, streaming: true }
    }
    case "tool_use": {
      const settled = settleLast(state.segments, atMs)
      const seg: ToolSegment = {
        kind: "tool",
        startedAt: atMs,
        durationMs: null,
        id: ev.id,
        name: ev.name,
        summary: summarizeInput(ev.input),
      }
      return { ...state, segments: [...settled, seg], streaming: true }
    }
    case "tool_result": {
      // 回填对应 tool 段并结算其耗时；期间若开了新 thinking 段则保留（真实交错）
      const segments = state.segments.map((s) => {
        if (s.kind === "tool" && s.id === ev.id && s.result == null) {
          return { ...s, result: ev.content, isError: ev.isError, durationMs: Math.max(0, atMs - s.startedAt) }
        }
        return s
      })
      return { ...state, segments }
    }
    case "result": {
      const settled = settleLast(state.segments, atMs)
      return {
        segments: settled,
        readout: {
          durationMs: ev.durationMs,
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
          costUsd: ev.costUsd,
          isError: ev.isError,
        },
        streaming: false,
      }
    }
  }
}

/** content 提取：stream-json 的 tool result 内容可能是字符串或 [{type:"text",text}] 块数组 */
function extractContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .map((b) => (typeof b === "object" && b && "text" in b ? String((b as { text?: string }).text ?? "") : ""))
      .join("")
  return ""
}

/**
 * 解析后端 llm-tool 事件的 payload（runner.parseLLMLine 产出的 JSON 字符串）：
 * tool_use → {"id","name","input"}；tool_result → {"id","content","isError"}。
 * 与 parseStreamLine 不同源：那个吃 CLI 原始行（mockup 用），这个吃后端已裁好的 payload（线上用）。
 */
export function parseToolEvent(line: string): ParsedEvent | null {
  try {
    const p = JSON.parse(line) as {
      id?: string
      name?: string
      input?: Record<string, unknown>
      content?: unknown
      isError?: boolean
    }
    if (p.id && p.name)
      return { kind: "tool_use", id: p.id, name: p.name, input: p.input ?? {} }
    if (p.id)
      return { kind: "tool_result", id: p.id, content: extractContent(p.content), isError: p.isError === true }
    return null
  } catch {
    return null
  }
}

/**
 * done 事件收尾：结算末段（以 readout.durationMs 为终点时刻，比前端到达时刻更准）
 * 并写入读数。readout 缺 durationMs 时退化为不结算时长（仅停止流式态）。
 */
export function finalizePanel(state: LlmPanelState, readout: SessionReadout): LlmPanelState {
  const end = readout.durationMs
  const settled = end != null ? settleLast(state.segments, end) : state.segments
  return { segments: settled, readout, streaming: false }
}

/** 历史条目 → 面板状态重建：段无计时（durationMs undefined，段头只显示字数），读数取总时长 */
export interface HistoryPanelSource {
  thinking: string
  response: string
  tools?: Array<{
    id: string
    name: string
    summary: string
    result?: string
    isError?: boolean
    durationMs?: number
  }>
  exitCode: number
  duration?: string // "1.2s" 形式（后端 time.Duration.String()）
}

export function panelFromHistory(e: HistoryPanelSource): LlmPanelState {
  const segments: LlmSegment[] = []
  if (e.thinking)
    segments.push({ kind: "thinking", startedAt: 0, durationMs: undefined, text: e.thinking })
  for (const t of e.tools ?? [])
    segments.push({ kind: "tool", startedAt: 0, durationMs: t.durationMs, ...t })
  if (e.response)
    segments.push({ kind: "answer", startedAt: 0, durationMs: undefined, text: e.response })
  const secs = e.duration ? Number.parseFloat(e.duration) : NaN
  return {
    segments,
    readout: { durationMs: Number.isFinite(secs) ? secs * 1000 : undefined, isError: e.exitCode !== 0 },
    streaming: false,
  }
}
