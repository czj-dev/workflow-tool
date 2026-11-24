// frontend/src/lib/ai.ts
// AI 任务的草稿、可运行判定、运行参数拼装与回复行合并（纯函数，无 React）。
// 与后端 internal/airun/build.go 的 resolveInputs 对齐：
//   - 传入值（RunAi 的 params 里有这个键）直接用，不做模板展开；
//   - 未传入的已声明参数取 spec.default——默认值本身可以是模板，由后端展开；
//     没有默认值时取全局配置同名 key；
//   - 未声明的键一律报「未知参数」，所以前端只发已声明参数与保留运行参数。
import type { AiTaskItem } from "../../bindings/workflow-tool/internal/api/models.js";
import type { ParamSpec } from "../../bindings/workflow-tool/internal/registry/models.js";
import type { WorkflowStepState } from "../types/events";
import { invalidArrayParams } from "./arrayParams";
import { missingRequired } from "./params";

/** 保留运行参数（不在 params 里声明，但 RunAi 认）：提示词模板 / 系统提示词模板 / 续接会话 id */
export const AI_PROMPT = "prompt";
export const AI_SYSTEM = "system";
export const AI_RESUME = "resume";

/** 草稿：已声明参数 + 保留运行参数，值全是字符串 */
export type AiDraft = Record<string, string>;
/** 草稿补丁（预设值等）：值为 undefined 表示撤回该键的修改 */
export type AiPatch = Record<string, string | undefined>;

export function taskParams(task: Pick<AiTaskItem, "params">): ParamSpec[] {
  return task.params ?? [];
}

/**
 * 草稿初值：已声明参数按 default > 全局配置同名 key > 空串，取原值不展开（默认值可以是
 * 模板，展开发生在后端）；prompt/system 取定义里的模板原文（空串 = 必须由调用方给入）。
 */
export function initialAiDraft(
  task: Pick<AiTaskItem, "params" | "prompt" | "system">,
  globalConfig: Record<string, string>,
): AiDraft {
  const draft: AiDraft = {
    [AI_PROMPT]: task.prompt ?? "",
    [AI_SYSTEM]: task.system ?? "",
    [AI_RESUME]: "",
  };
  for (const spec of taskParams(task)) {
    draft[spec.id] = spec.default || globalConfig[spec.id] || "";
  }
  return draft;
}

/** 完整草稿 = 初值 + 用户改过的键（overlay） */
export function aiDraftFor(
  task: Pick<AiTaskItem, "params" | "prompt" | "system">,
  overlay: AiPatch | undefined,
  globalConfig: Record<string, string>,
): AiDraft {
  const draft = initialAiDraft(task, globalConfig);
  for (const [key, value] of Object.entries(overlay ?? {})) {
    if (value !== undefined) draft[key] = value;
  }
  return draft;
}

/** 未就绪的输入：提示词为空，或必填的已声明参数未填。返回草稿键（prompt 或参数 id）。 */
export function missingAiInputs(task: Pick<AiTaskItem, "params">, draft: AiDraft): string[] {
  const missing = missingRequired(taskParams(task), draft).map((spec) => spec.id);
  if (!(draft[AI_PROMPT] ?? "").trim()) missing.unshift(AI_PROMPT);
  return missing;
}

export function aiCanRun(task: Pick<AiTaskItem, "params">, draft: AiDraft): boolean {
  return (
    missingAiInputs(task, draft).length === 0 &&
    invalidArrayParams(taskParams(task), draft).length === 0
  );
}

/**
 * 实际发给 RunAi 的参数：prompt/system 恒传（后端「键出现即整体替换定义模板」，传入值
 * 照常做模板展开，原样回传定义文本与不传等价，而历史/再跑能拿到当时用的文本）；resume 仅在
 * 非空时传；已声明参数只传用户改过的——没改的不传，后端取定义默认值并展开其中的模板
 * （当成传入值发送的话模板不会被展开）。
 */
export function aiRunParams(
  task: Pick<AiTaskItem, "params">,
  overlay: AiPatch | undefined,
  draft: AiDraft,
): AiDraft {
  const params: AiDraft = {
    [AI_PROMPT]: draft[AI_PROMPT] ?? "",
    [AI_SYSTEM]: draft[AI_SYSTEM] ?? "",
  };
  const resume = (draft[AI_RESUME] ?? "").trim();
  if (resume) params[AI_RESUME] = resume;
  for (const spec of taskParams(task)) {
    if (Object.hasOwn(overlay ?? {}, spec.id)) params[spec.id] = draft[spec.id] ?? "";
  }
  return params;
}

const withTextLine = (step: WorkflowStepState, text: string): WorkflowStepState =>
  text === ""
    ? step
    : { ...step, lines: [...step.lines, { kind: "text", text }], lastWasProgress: false };

/**
 * 把 AI 回复增量并入步骤桶：凑满一行才落一条 text 行（流式增量不各占一行），未凑满的
 * 留在 aiPartial。步骤已收尾时（step-done 抢在迟到增量前到达）尾巴直接落行。
 */
export function mergeAiReply(step: WorkflowStepState, delta: string): WorkflowStepState {
  if (!delta) return step;
  const settled = step.status === "done" || step.status === "error";
  const base = settled ? flushAiReply(step) : step;
  const buf = (base.aiPartial ?? "") + delta;
  const cut = buf.lastIndexOf("\n") + 1;
  let next = base;
  for (const text of buf.slice(0, cut).split("\n").slice(0, -1)) {
    next = withTextLine(next, text.replace(/\r$/, ""));
  }
  const rest = buf.slice(cut).replace(/\r$/, "");
  return settled ? withTextLine(next, rest) : { ...next, aiPartial: rest };
}

/** 步骤收尾：把未凑满行的尾巴落成最后一行，并摘掉半行缓冲 */
export function flushAiReply(step: WorkflowStepState): WorkflowStepState {
  const next = { ...step };
  delete next.aiPartial;
  return withTextLine(next, (step.aiPartial ?? "").replace(/\r$/, ""));
}
