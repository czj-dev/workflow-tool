// 输出行折叠：把一次后端 output 事件应用到已有 lines[] 上，返回新 lines[]。
// 抽离出来是为了让 action 和 workflow 的 stdout/stderr/progress 处理逻辑共用一份：
// - stderr 加前缀
// - progress 原地覆盖上一条 progress（模拟终端 \r 刷新），否则追加
// - stdout / 其他流：追加
// llm/llm-thinking/logcat/step-* 这类结构化 stream 有自己的缓冲，不走这条路径。
import type { OutputEventData } from "../types/events";

// 每桶 lines 需要跟踪「上一行是否是 progress」——单条 boolean 状态跟着桶走，
// 归属清晰（action 一桶 / 每个 workflow step 各一桶）。
export interface FoldState {
  lines: string[];
  lastWasProgress: boolean;
}

export const emptyFoldState = (): FoldState => ({ lines: [], lastWasProgress: false });

export function foldOutputLine(
  state: FoldState,
  d: OutputEventData,
  opts: { stderrPrefix: string },
): FoldState {
  if (d.stream === "progress") {
    const line = d.line || "";
    if (state.lastWasProgress && state.lines.length > 0) {
      return {
        lines: [...state.lines.slice(0, -1), line],
        lastWasProgress: true,
      };
    }
    return { lines: [...state.lines, line], lastWasProgress: true };
  }
  const prefix = d.stream === "stderr" ? opts.stderrPrefix : "";
  return {
    lines: [...state.lines, prefix + (d.line || "")],
    lastWasProgress: false,
  };
}
