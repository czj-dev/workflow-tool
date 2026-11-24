// 运行详情的回放器：把一条运行的运行日志（events.ndjson）还原成与实时渲染同构的状态。
// 纯函数，无 React 依赖。
//
// 同一个归约器有两种喂法：
//   - 回放：replayRun 一次喂完整份运行日志，每条事件的时刻取日志里的相对偏移 t；
//   - 实时：打开一条仍在运行的记录时逐条 applyRunEvent，时刻由调用方按到达时刻给出。
// 两种喂法得到同一个结果——回放看到的就是当时前端归约出来的样子。
//
// seq 帧门与前端实时路径同一套契约：output 自带递增 seq，按 seq 逐号出队。三种目标都设门
// ——动作的退出码行接入同一条队列（done 独占一个号，可能抢跑在还没落盘的 output 前面），
// AI 运行把 done 的号登记为已消耗后跨过，工作流的 done 不取号、直接应用。不带号的事件
// （兼容旧日志）原样按落盘顺序应用。
// 实时跟踪时「先订阅、后读盘」会让读盘之前的事件重送一遍，帧门据 seq 去重。
import type {
  DoneEventData,
  LogcatEntry,
  LogcatReplaceFrame,
  OutputEventData,
  OutputLineItem,
  RunEvent,
  RunTargetKind,
  WorkflowStepState,
} from "../types/events";
import { finalizePanel } from "./reduceStream";
import { EMPTY_AI_VIEW, reduceAiOutput, type AiViewState } from "./aiStream";
import { foldOutputLine, type FoldOpts } from "./outputFold";
import { reduceWorkflowOutput } from "./workflowStream";

export interface RunPlayerOpts extends FoldOpts {
  /** 动作运行的退出码行文案（与会话页同一句话，i18n 由调用方注入）。 */
  exitLine: (exitCode: number, err: string) => string;
}

export interface RunPlayerState {
  kind: RunTargetKind;
  /** 动作运行的输出桶（文本 / 进度 / 树帧 / logcat 条目）。 */
  lines: OutputLineItem[];
  /** seq 帧门：pending 等待补洞的 output，consumed 是已跨过的 done 号（仅 AI 运行）。 */
  gate: { nextSeq: number; pending: Map<number, { ev: RunEvent; atMs: number }>; consumed: Set<number> };
  lastWasProgress: boolean;
  treeSeq: number;
  /** AI 运行的会话视图（工序段 + 诊断行）。 */
  ai: AiViewState;
  /** 工作流运行的步骤桶（AI 步骤带工序段）。 */
  steps: WorkflowStepState[];
  done: DoneEventData | null;
  /** 运行日志到达上限：其后的输出没有落盘，回放不完整。 */
  truncated: boolean;
}

export function newRunPlayer(kind: RunTargetKind): RunPlayerState {
  return {
    kind,
    lines: [],
    gate: { nextSeq: 1, pending: new Map(), consumed: new Set() },
    lastWasProgress: false,
    treeSeq: 0,
    ai: EMPTY_AI_VIEW,
    steps: [],
    done: null,
    truncated: false,
  };
}

/** 整份运行日志一次性回放。 */
export function replayRun(kind: RunTargetKind, events: RunEvent[], opts: RunPlayerOpts): RunPlayerState {
  let state = newRunPlayer(kind);
  for (const ev of events) {
    state = applyRunEvent(state, ev, ev.t, opts);
  }
  return state;
}

/**
 * 应用一条运行日志行。atMs 是该事件相对运行起点的时刻（回放取 ev.t；实时由调用方
 * 按到达时刻给出）。不修改传入的状态。
 */
export function applyRunEvent(state: RunPlayerState, ev: RunEvent, atMs: number, opts: RunPlayerOpts): RunPlayerState {
  if (ev.event === "truncated") {
    return { ...state, truncated: true };
  }
  return feed(state, { ev, atMs }, opts);
}

/**
 * 实时跟踪时应用一条刚到达的事件（运行详情打开一条仍在运行的记录）。
 *
 * 与回放的不同只在去重：跟踪是「先订阅、后读盘」的，读盘之前产生的输出也会被送来一遍
 * ——它们已经在快照里。帧门的 nextSeq 就是「快照已经应用到哪」，号比它小的事件跳过。
 * 反过来「先读盘、后订阅」会留下一个窗口：服务端读盘到订阅生效之间的输出两头落空，
 * 号段里出现永久的洞，之后的实时事件全部挂在门后。
 */
export function applyLiveEvent(state: RunPlayerState, ev: RunEvent, atMs: number, opts: RunPlayerOpts): RunPlayerState {
  if (ev.seq != null && ev.seq > 0 && ev.seq < state.gate.nextSeq) return state;
  return applyRunEvent(state, ev, atMs, opts);
}

/** 过帧门：带 seq 的事件先入队再从 nextSeq 逐号出队应用；没有 seq 的直接应用。 */
function feed(state: RunPlayerState, item: { ev: RunEvent; atMs: number }, opts: RunPlayerOpts): RunPlayerState {
  const ev = item.ev;
  const isDone = ev.event === "done";
  const seq = ev.seq != null && ev.seq > 0 ? ev.seq : null;
  // 不带号的事件（早退的 done、旧日志）不设门；工作流的 done 不取号，带着号也不设门
  // （它总在最后）。
  if (seq === null || (isDone && state.kind === "workflow")) {
    return isDone ? finish(state, item, opts, state.kind === "action") : applyOutput(state, ev, item.atMs, opts);
  }
  const pending = new Map(state.gate.pending);
  const consumed = new Set(state.gate.consumed);
  let nextSeq = state.gate.nextSeq;
  if (isDone) {
    if (state.kind === "action") {
      // 退出码行接入与 output 同一条 seq 队列（与前端实时路径一致）：done 可能抢跑在
      // 还没落盘的 output 前面，它必须排在那些行之后。
      pending.set(seq, {
        ev: { event: "output", stream: "stdout", line: opts.exitLine(ev.exitCode ?? 0, ev.err ?? ""), seq, t: item.atMs },
        atMs: item.atMs,
      });
    } else {
      // 会话页没有退出码行：done 只占号，登记为已消耗、跨过去
      consumed.add(seq);
    }
  } else {
    pending.set(seq, item);
  }
  let cur = state;
  for (;;) {
    if (consumed.delete(nextSeq)) {
      nextSeq++;
      continue;
    }
    const head = pending.get(nextSeq);
    if (!head) break;
    pending.delete(nextSeq);
    nextSeq++;
    cur = applyOutput(cur, head.ev, head.atMs, opts);
  }
  cur = { ...cur, gate: { nextSeq, pending, consumed } };
  if (isDone) cur = finish(cur, item, opts, false);
  return cur;
}

/** done 行：登记结论，并按运行种类收尾（动作补退出码行、AI 结算工序段）。 */
function finish(state: RunPlayerState, item: { ev: RunEvent; atMs: number }, opts: RunPlayerOpts, appendExit: boolean): RunPlayerState {
  const ev = item.ev;
  const payload: DoneEventData = { exitCode: ev.exitCode ?? 0, err: ev.err ?? "", duration: ev.duration ?? "" };
  if (ev.readout) payload.readout = ev.readout;
  if (ev.seq) payload.seq = ev.seq;
  let next: RunPlayerState = { ...state, done: payload };
  if (state.kind === "action" && appendExit) {
    next = { ...next, lines: [...next.lines, { kind: "text", text: opts.exitLine(payload.exitCode, payload.err) }], lastWasProgress: false };
  } else if (state.kind === "ai") {
    const readout = payload.readout;
    next = {
      ...next,
      ai: {
        ...next.ai,
        panel: finalizePanel(next.ai.panel, {
          durationMs: readout?.durationMs ?? item.atMs,
          inputTokens: readout?.inputTokens,
          outputTokens: readout?.outputTokens,
          costUsd: readout?.costUsd,
          sessionId: readout?.sessionId,
          isError: payload.exitCode !== 0,
        }),
      },
    };
  }
  return next;
}

function applyOutput(state: RunPlayerState, ev: RunEvent, atMs: number, opts: RunPlayerOpts): RunPlayerState {
  const d = ev as OutputEventData;
  if (state.kind === "workflow") {
    const steps = reduceWorkflowOutput(state.steps, d, atMs, opts);
    return steps === state.steps ? state : { ...state, steps };
  }
  if (state.kind === "ai") {
    const ai = reduceAiOutput(state.ai, d, atMs);
    return ai === state.ai ? state : { ...state, ai };
  }
  if (d.stream === "logcat") {
    return appendLines(state, logcatEntries(d.line || ""));
  }
  if (d.stream === "logcat-replace") {
    // 重放首帧整体替换（规则变更后的全量重筛），后续帧追加：还原当时屏幕上的内容
    const frame = parseReplace(d.line || "");
    if (!frame) return state;
    const base = frame.head ? { ...state, lines: [], lastWasProgress: false } : state;
    return appendLines(base, frame.entries ?? []);
  }
  const folded = foldOutputLine({ lines: state.lines, lastWasProgress: state.lastWasProgress, treeSeq: state.treeSeq }, d, opts);
  return { ...state, lines: folded.lines, lastWasProgress: folded.lastWasProgress, treeSeq: folded.treeSeq ?? 0 };
}

function appendLines(state: RunPlayerState, entries: LogcatEntry[]): RunPlayerState {
  if (entries.length === 0) return state;
  return { ...state, lines: [...state.lines, ...entries.map(formatLogcatEntry).map((text) => ({ kind: "text" as const, text }))], lastWasProgress: false };
}

// logcat 帧的 line 是后端批量下发的 JSON 数组（偶发单对象兼容）；解析失败退化为单条原文。
function logcatEntries(line: string): LogcatEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [{ date: "", time: "", pid: 0, tid: 0, level: "V", tag: "", message: line }];
  }
  return Array.isArray(parsed) ? (parsed as LogcatEntry[]) : [parsed as LogcatEntry];
}

function parseReplace(line: string): LogcatReplaceFrame | null {
  try {
    return JSON.parse(line) as LogcatReplaceFrame;
  } catch {
    return null;
  }
}

/** logcat 条目的一行文本：日期 时间 PID TID 级别 tag: message。 */
export function formatLogcatEntry(e: LogcatEntry): string {
  const head = [e.date, e.time].filter(Boolean).join(" ");
  const proc = `${String(e.pid ?? 0).padStart(5)} ${String(e.tid ?? 0).padStart(5)}`;
  const tail = [e.tag ? `${e.tag}:` : "", e.message].filter(Boolean).join(" ");
  return [head, proc, e.level, tail].filter(Boolean).join(" ");
}
