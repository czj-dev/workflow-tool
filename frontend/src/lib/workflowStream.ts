// 工作流输出事件 → 步骤桶（WorkflowStepState[]）的归约器（纯函数，无 React 依赖）。
// 实时的 Pipeline Spine 与运行详情回放共用这一份归约。
//
// 归属：每条输出带后端下发的 step 索引，按索引落桶，与到达顺序无关（Wails 事件乱序
// 时不会把一个步骤的输出折进另一个步骤）。AI 步骤的回复/思考/工具调用归约成工序段
// （aiPanel），在 spine 里以工序段面板渲染，不进文本行。
import type { OutputEventData, WorkflowStepState } from "../types/events";
import { EMPTY_PANEL_STATE, finalizePanel, type AiPanelState } from "./reduceStream";
import { EMPTY_AI_VIEW, reduceAiOutput } from "./aiStream";
import { foldOutputLine, type FoldOpts } from "./outputFold";

export type WorkflowReduceOpts = FoldOpts;

const AI_STREAMS = new Set(["ai", "ai-thinking", "ai-tool"]);

/** 改写（必要时补建）索引为 index 的桶；其余桶保持同一引用。 */
function patchStep(steps: WorkflowStepState[], index: number, patch: (step: WorkflowStepState) => WorkflowStepState): WorkflowStepState[] {
  if (steps.some((s) => s.index === index)) {
    return steps.map((s) => (s.index === index ? patch(s) : s));
  }
  return [...steps, patch({ index, status: "running", lines: [] })];
}

/** 定位一条输出该落进的桶；返回 undefined 表示无处可落（调用方原样返回）。 */
function locateStep(steps: WorkflowStepState[], d: OutputEventData): { list: WorkflowStepState[]; step: WorkflowStepState } | null {
  const idx = d.step ? parseInt(d.step, 10) : NaN;
  if (!Number.isNaN(idx)) {
    const step = steps.find((s) => s.index === idx);
    // 输出先于 step-start 到达时补建桶（step-start 之后会把状态覆写为 running）
    return step ? { list: steps, step } : { list: steps, step: { index: idx, status: "running", lines: [] } };
  }
  const running = [...steps].reverse().find((s) => s.status === "running");
  return running ? { list: steps, step: running } : null;
}

/**
 * 应用一条工作流 output 事件。atMs 是该事件相对运行起点的时刻：步骤耗时与工序段
 * 时间轴都按它结算（实时 = Date.now() - 起跑时刻；回放 = 运行日志里的相对偏移）。
 * 无处可落或与步骤无关时返回同一引用。
 */
export function reduceWorkflowOutput(steps: WorkflowStepState[], d: OutputEventData, atMs: number, opts: WorkflowReduceOpts): WorkflowStepState[] {
  if (d.stream === "step-start" || d.stream === "step-skip") {
    const idx = parseInt(d.line, 10);
    if (d.stream === "step-start") {
      return patchStep(steps, idx, (s) => ({ ...s, status: "running", startedAt: atMs }));
    }
    return patchStep(steps, idx, (s) => ({ ...s, status: "skipped" }));
  }
  if (d.stream === "step-done") {
    const [idxText, codeText] = (d.line || "").split(":");
    const idx = parseInt(idxText, 10);
    const code = parseInt(codeText, 10);
    return patchStep(steps, idx, (s) => {
      const next: WorkflowStepState = { ...s, status: code === 0 ? "done" : "error", exitCode: code, endedAt: atMs };
      if (s.aiPanel) {
        // 结算末段并收尾；步骤的耗时读数由 spine 的卡头显示，面板不带会话读数
        next.aiPanel = { ...finalizePanel(s.aiPanel, { isError: code !== 0, durationMs: atMs }), readout: { isError: code !== 0 } };
      }
      return next;
    });
  }
  if (AI_STREAMS.has(d.stream)) {
    const located = locateStep(steps, d);
    if (!located) return steps;
    const { list, step } = located;
    const view = reduceAiOutput({ ...EMPTY_AI_VIEW, panel: step.aiPanel ?? EMPTY_PANEL_STATE as AiPanelState }, d, atMs);
    if (view.panel === step.aiPanel) return steps;
    const merged = { ...step, aiPanel: view.panel };
    return list.some((s) => s.index === step.index) ? list.map((s) => (s.index === step.index ? merged : s)) : [...list, merged];
  }
  const located = locateStep(steps, d);
  if (!located) return steps;
  const { list, step } = located;
  const folded = foldOutputLine(
    { lines: step.lines, lastWasProgress: step.lastWasProgress ?? false, treeSeq: step.treeSeq },
    d,
    opts,
  );
  const merged: WorkflowStepState = { ...step, lines: folded.lines, lastWasProgress: folded.lastWasProgress, treeSeq: folded.treeSeq };
  return list.some((s) => s.index === step.index) ? list.map((s) => (s.index === step.index ? merged : s)) : [...list, merged];
}
