// 输出行折叠：把一次后端 output 事件应用到已有 lines[] 上，返回新 lines[]。
// 抽离出来是为了让 action 和 workflow 的 stdout/stderr/progress 处理逻辑共用一份：
// - stderr 加前缀
// - progress 原地覆盖上一条 progress（模拟终端 \r 刷新），否则追加
// - stdout / 其他流：追加
// llm/llm-thinking/logcat/step-* 这类结构化 stream 有自己的缓冲，不走这条路径。
import type { OutputEventData } from "../types/events";

// 每桶 lines 需要跟踪「上一行是否是 progress」——单条 boolean 状态跟着桶走，
// 归属清晰（action 一桶 / 每个 workflow step 各一桶）。
// nextSeq/pending 只有 action 桶用（重排 seq，见下）；workflow 按 step 索引落桶已规避
// 乱序问题，调用时可不传，此时退化为原样按到达顺序应用。
export interface FoldState {
  lines: string[];
  lastWasProgress: boolean;
  nextSeq?: number;
  pending?: Map<number, OutputEventData>;
}

export const emptyFoldState = (): FoldState => ({
  lines: [],
  lastWasProgress: false,
  nextSeq: 1,
  pending: new Map(),
});

function applyOne(
  state: FoldState,
  d: OutputEventData,
  opts: { stderrPrefix: string },
): FoldState {
  if (d.stream === "progress") {
    const line = d.line || "";
    if (state.lastWasProgress && state.lines.length > 0) {
      return {
        ...state,
        lines: [...state.lines.slice(0, -1), line],
        lastWasProgress: true,
      };
    }
    return { ...state, lines: [...state.lines, line], lastWasProgress: true };
  }
  const prefix = d.stream === "stderr" ? opts.stderrPrefix : "";
  return {
    ...state,
    lines: [...state.lines, prefix + (d.line || "")],
    lastWasProgress: false,
  };
}

export function foldOutputLine(
  state: FoldState,
  d: OutputEventData,
  opts: { stderrPrefix: string },
): FoldState {
  // 无 seq（workflow 桶、旧数据）或桶未启用重排（nextSeq 缺失）：原样按到达顺序应用。
  if (d.seq == null || state.nextSeq == null) {
    return applyOne(state, d, opts);
  }
  const pending = state.pending ?? new Map<number, OutputEventData>();
  if (d.seq !== state.nextSeq) {
    // 还没轮到它：先缓存，等空洞补齐再回放。
    const next = new Map(pending);
    next.set(d.seq, d);
    return { ...state, pending: next };
  }
  let next = applyOne(state, d, opts);
  let expect = state.nextSeq + 1;
  const rest = new Map(pending);
  while (rest.has(expect)) {
    const queued = rest.get(expect)!;
    rest.delete(expect);
    next = applyOne(next, queued, opts);
    expect++;
  }
  return { ...next, nextSeq: expect, pending: rest };
}
