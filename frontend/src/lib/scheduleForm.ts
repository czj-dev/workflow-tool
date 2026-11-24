// 调度编辑器的目标种类与参数区辅助（纯函数，无 React 依赖）。编辑器组件与需要打开
// 编辑器的调用方（调度页、AI 卡）共用同一份「目标种类」「AI 目标的参数怎么存」规则。
import type { RunTargetKind } from "../types/events";
import { AI_PROMPT, AI_SYSTEM } from "./ai";

// 目标种类只有一套定义（types/events 的 RUN_TARGET_KINDS），调度编辑器直接用它
export type ScheduleTargetKind = RunTargetKind;

// AI 目标的参数区是结构化输入：这两个保留运行参数无需任务声明即可用（resume 是会话 id，
// 由会话页的 chip 管理，不在调度里提供输入框）。
export const AI_RESERVED_FIELDS: ReadonlyArray<{ key: string; labelKey: string }> = [
  { key: AI_PROMPT, labelKey: "scheduler.aiPrompt" },
  { key: AI_SYSTEM, labelKey: "scheduler.aiSystem" },
];

export function normalizeTargetKind(kind: string): ScheduleTargetKind {
  return kind === "workflow" || kind === "ai" ? kind : "action";
}

/** AI 目标参数区的初值：调度已有 params 里的值带进对应的输入框（非字符串转成 JSON 文本）。 */
export function aiValuesFromParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value == null) continue;
    out[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
}

/** AI 目标保存时的 params：留空的键不传（运行时由任务取默认值）。 */
export function paramsFromAiValues(values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value.trim() !== "") out[key] = value;
  }
  return out;
}
