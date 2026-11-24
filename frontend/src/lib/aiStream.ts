// AI 输出流 → 会话视图态的归约器（纯函数，无 React 依赖）。
// 实时会话（Provider 的每次运行捕获）与运行详情回放共用这一份归约：回放看到的就是
// 当时前端归约出来的样子。
import type { OutputEventData } from "../types/events";
import {
  applyEvent,
  parseToolEvent,
  EMPTY_PANEL_STATE,
  type AiPanelState,
} from "./reduceStream";

/** 单个 AI 运行的会话视图态（回放用）。 */
export interface AiViewState {
  text: string;
  thinking: string;
  panel: AiPanelState;
  // 本轮发送的 prompt 快照（已展开 ${VAR}）与发送时刻：会话页气泡回显用
  sentPrompt: string;
  sentAt: number | null;
  // 运行期间 runner 的 stdout/stderr 行（诊断用：失败时展示）
  diag: { stream: "stdout" | "stderr"; text: string }[];
}

export const EMPTY_AI_VIEW: AiViewState = {
  text: "",
  thinking: "",
  panel: EMPTY_PANEL_STATE,
  sentPrompt: "",
  sentAt: null,
  diag: [],
};

// 诊断行缓冲上限（只留尾部，够失败时回看）与单行长度上限
export const MAX_AI_DIAG = 200;
export const MAX_AI_DIAG_LINE = 2000;

/**
 * 把一条 AI output 事件并入视图态。atMs 是该事件相对运行起点的时刻（实时 =
 * Date.now() - 起跑时刻；回放 = 运行日志里的相对偏移），工序段的时间轴据此结算。
 * 与 AI 无关的流原样返回同一引用。
 */
export function reduceAiOutput(view: AiViewState, d: OutputEventData, atMs: number): AiViewState {
  if (d.stream === "ai" || d.stream === "ai-thinking") {
    const delta = d.line || "";
    const isText = d.stream === "ai";
    return {
      ...view,
      text: isText ? view.text + delta : view.text,
      thinking: isText ? view.thinking : view.thinking + delta,
      panel: applyEvent(view.panel, { kind: isText ? "text" : "thinking", delta }, atMs),
    };
  }
  if (d.stream === "ai-tool") {
    const ev = parseToolEvent(d.line || "");
    if (!ev) return view;
    return { ...view, panel: applyEvent(view.panel, ev, atMs) };
  }
  if (d.stream === "stdout" || d.stream === "stderr") {
    const text = (d.line || "").slice(0, MAX_AI_DIAG_LINE);
    return { ...view, diag: [...view.diag.slice(1 - MAX_AI_DIAG), { stream: d.stream, text }] };
  }
  return view;
}
