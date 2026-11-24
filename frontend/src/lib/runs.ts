// 运行记录与调度投影的展示辅助（纯函数，无 React 依赖）。
import type { RunItem, ScheduleLastSkip } from "../types/events";
import { expandVars } from "./vars";

/** 一次运行的耗时（毫秒）：结束时刻减启动时刻。运行中、中断（结束时刻不可知）或时间
 * 解析不了时为 null——不编造读数。 */
export function runDurationMs(item: Pick<RunItem, "startedAt" | "finishedAt">): number | null {
  if (!item.startedAt || !item.finishedAt) return null;
  const start = Date.parse(item.startedAt);
  const end = Date.parse(item.finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/** 是否已终结。未知状态保守地当作终态：只有明确在运行才显示运行中。 */
export function isTerminalRunStatus(status: string): boolean {
  return status !== "running";
}

/** 运行当次的一个输入值（转成文本）；缺失为空串。 */
export function runParam(item: Pick<RunItem, "params">, key: string): string {
  const value = item.params?.[key];
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * AI 卡叙述区的摘要：最近一次运行的提示词，按当次输入展开 ${VAR}（与卡片上原来显示
 * 卡片摘要同一句话）。运行记录是唯一的来源，调度发起的运行同样算。
 * 没有运行、或那一次没有提示词输入时返回 null，卡片回落到任务描述。
 */
export function aiRunSummary(last: Pick<RunItem, "params"> | null | undefined): string | null {
  if (!last) return null;
  const prompt = last.params?.prompt;
  if (typeof prompt !== "string") return null;
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(last.params ?? {})) {
    vars[key] = typeof value === "string" ? value : runParam(last, key);
  }
  const summary = expandVars(prompt, vars).replace(/\s+/g, " ").trim();
  return summary || null;
}

/** 调度卡「上次到点已跳过」的一句话投影。 */
export function lastSkipText(skip: ScheduleLastSkip | null | undefined): string | null {
  return skip?.reason?.trim() || null;
}

export interface TargetLookup {
  actions: ReadonlyArray<TargetEntry>;
  workflows: ReadonlyArray<TargetEntry>;
  aiTasks: ReadonlyArray<TargetEntry>;
}

type TargetEntry = { id: string; title: string; icon?: string };

/** 某个种类的目标在哪张表里：动作 / 工作流 / AI 任务各一张；未知的种类按动作。 */
export function targetList(kind: string, lists: TargetLookup): ReadonlyArray<TargetEntry> {
  if (kind === "workflow") return lists.workflows;
  if (kind === "ai") return lists.aiTasks;
  return lists.actions;
}

/** 目标的显示标题：按种类到各自的列表里找；找不到（目标已卸载）回落显示 id。 */
export function targetTitle(kind: string, id: string, lists: TargetLookup): string {
  return targetList(kind, lists).find((item) => item.id === id)?.title ?? id;
}

/** 目标的图标（已卸载的目标为 undefined）。 */
export function targetIcon(kind: string, id: string, lists: TargetLookup): string | undefined {
  return targetList(kind, lists).find((item) => item.id === id)?.icon;
}

/** 指向某目标的全部调度（同一目标可被多条调度指向，ADR-0005）。只认种类匹配的。 */
export function schedulesOfTarget<T extends { targetKind: string; targetId: string }>(
  schedules: ReadonlyArray<T>, kind: string, id: string,
): T[] {
  return schedules.filter((schedule) => schedule.targetKind === kind && schedule.targetId === id);
}
