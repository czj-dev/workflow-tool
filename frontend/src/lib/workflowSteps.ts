// 步骤视图（StepView）的构造：把工作流的定义态步骤与运行态步骤桶合并成 Pipeline Spine
// 要渲染的形状。纯函数，无 React 依赖——实时的 WorkflowView 与运行详情回放共用。
import type { TFunction } from "i18next";
import type { AiPanelState } from "./reduceStream";
import type { OutputLineItem, WorkflowStepState } from "../types/events";
import type { RunPlayerState } from "./runReplay";

// 合并后的步骤视图：定义态（name）+ 运行态（status/lines/exitCode/耗时打点/AI 工序段）
export interface StepView {
  index: number;
  name: string;
  status: WorkflowStepState["status"];
  exitCode?: number;
  lines: OutputLineItem[];
  startedAt?: number;
  endedAt?: number;
  /** AI 步骤专有：回复 / 思考 / 工具调用归约成的工序段 */
  aiPanel?: AiPanelState;
}

/** 步骤状态 → i18n 键。 */
export const STEP_STATUS_I18N: Record<WorkflowStepState["status"], string> = {
  pending: "workflow.stepPending",
  running: "workflow.stepRunning",
  done: "workflow.stepDone",
  error: "workflow.stepError",
  skipped: "workflow.stepSkipped",
};

function runtimeStepToView(runtime: WorkflowStepState, name: string): StepView {
  return {
    index: runtime.index,
    name,
    status: runtime.status,
    exitCode: runtime.exitCode,
    lines: runtime.lines,
    startedAt: runtime.startedAt,
    endedAt: runtime.endedAt,
    aiPanel: runtime.aiPanel,
  };
}

/** 定义态全展示，运行态状态覆盖（无运行态 → pending）；没有定义时只列运行态里出现过的步骤。 */
export function mergeStepViews(
  defined: ReadonlyArray<{ name: string; kind: string; label: string }>,
  runtime: ReadonlyArray<WorkflowStepState>,
  t: TFunction,
): StepView[] {
  if (defined.length === 0) {
    return runtime.map((step) => runtimeStepToView(step, t("workflow.step", { index: step.index + 1 })));
  }
  return defined.map((info, i) =>
    runtimeStepToView(
      runtime.find((s) => s.index === i) ?? { index: i, status: "pending", lines: [] },
      info.name || (info.kind === "sleep" ? t("workflow.stepSleep", { seconds: info.label.replace(/s$/, "") }) : info.label),
    ),
  );
}

/** 运行详情回放工作流：步骤状态取自运行日志；名称尽量按当前定义对齐，定义已变的用兜底名。 */
export function stepsFromRun(
  player: RunPlayerState,
  defined: ReadonlyArray<{ name: string; kind: string; label: string }> | undefined,
  t: TFunction,
): StepView[] {
  return mergeStepViews(defined ?? [], player.steps, t);
}
