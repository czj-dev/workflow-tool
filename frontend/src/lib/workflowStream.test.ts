import { describe, expect, it } from "vitest";
import { reduceWorkflowOutput, type WorkflowReduceOpts } from "./workflowStream";
import type { OutputEventData, WorkflowStepState } from "../types/events";

const OPTS: WorkflowReduceOpts = { stderrPrefix: "[stderr] " };
const out = (stream: OutputEventData["stream"], line: string, step?: string): OutputEventData =>
  step === undefined ? { stream, line } : { stream, line, step };

const tool = (id: string, name: string) => JSON.stringify({ id, name, input: { file_path: `/repo/${name}` } });

describe("reduceWorkflowOutput", () => {
  it("step-start 建桶：running + 起点时刻；同一步再次 start 复用桶并刷新起点", () => {
    let steps = reduceWorkflowOutput([], out("step-start", "1"), 500, OPTS);
    expect(steps).toEqual([{ index: 1, status: "running", lines: [], startedAt: 500 }]);
    steps = reduceWorkflowOutput(steps, out("step-start", "1"), 900, OPTS);
    expect(steps).toEqual([{ index: 1, status: "running", lines: [], startedAt: 900 }]);
  });

  it("step-done：<索引>:<退出码> → 终态、退出码、终点时刻", () => {
    let steps = reduceWorkflowOutput([], out("step-start", "0"), 100, OPTS);
    steps = reduceWorkflowOutput(steps, out("step-done", "0:0"), 700, OPTS);
    let steps1 = reduceWorkflowOutput(steps, out("step-start", "1"), 700, OPTS);
    steps1 = reduceWorkflowOutput(steps1, out("step-done", "1:3"), 900, OPTS);
    expect(steps1[0]).toMatchObject({ index: 0, status: "done", exitCode: 0, startedAt: 100, endedAt: 700 });
    expect(steps1[1]).toMatchObject({ index: 1, status: "error", exitCode: 3, endedAt: 900 });
    // step-done 可先于 step-start 到达：补建桶
    expect(reduceWorkflowOutput([], out("step-done", "2:0"), 10, OPTS)).toMatchObject([
      { index: 2, status: "done", exitCode: 0, endedAt: 10 },
    ]);
  });

  it("step-skip：已跳过", () => {
    let steps = reduceWorkflowOutput([], out("step-start", "0"), 0, OPTS);
    steps = reduceWorkflowOutput(steps, out("step-skip", "0"), 5, OPTS);
    steps = reduceWorkflowOutput(steps, out("step-skip", "1"), 6, OPTS);
    expect(steps.map((s) => s.status)).toEqual(["skipped", "skipped"]);
  });

  it("stdout/stderr 按后端的 step 归属落桶，stderr 带前缀", () => {
    let steps = reduceWorkflowOutput([], out("step-start", "0"), 0, OPTS);
    steps = reduceWorkflowOutput(steps, out("stdout", "a", "0"), 1, OPTS);
    steps = reduceWorkflowOutput(steps, out("step-start", "1"), 2, OPTS);
    // 归属字段说了算：乱序到达也不会把输出折进别的步骤
    steps = reduceWorkflowOutput(steps, out("stdout", "late a", "0"), 3, OPTS);
    steps = reduceWorkflowOutput(steps, out("stderr", "boom", "1"), 4, OPTS);
    expect(steps[0].lines).toEqual([{ kind: "text", text: "a" }, { kind: "text", text: "late a" }]);
    expect(steps[1].lines).toEqual([{ kind: "text", text: "[stderr] boom" }]);
  });

  it("没有归属字段时落进最后一个 running 的桶；都没有则丢弃", () => {
    let steps = reduceWorkflowOutput([], out("step-start", "0"), 0, OPTS);
    steps = reduceWorkflowOutput(steps, out("step-done", "0:0"), 1, OPTS);
    steps = reduceWorkflowOutput(steps, out("step-start", "1"), 2, OPTS);
    steps = reduceWorkflowOutput(steps, out("stdout", "no step"), 3, OPTS);
    expect(steps[1].lines).toEqual([{ kind: "text", text: "no step" }]);
    expect(steps[0].lines).toEqual([]);
    expect(reduceWorkflowOutput([], out("stdout", "orphan"), 0, OPTS)).toEqual([]);
  });

  it("progress 原地覆盖上一条进度行；其后一条普通行照常追加", () => {
    let steps = reduceWorkflowOutput([], out("step-start", "0"), 0, OPTS);
    steps = reduceWorkflowOutput(steps, out("progress", "10%"), 1, OPTS);
    steps = reduceWorkflowOutput(steps, out("progress", "60%"), 2, OPTS);
    steps = reduceWorkflowOutput(steps, out("stdout", "done"), 3, OPTS);
    steps = reduceWorkflowOutput(steps, out("progress", "again"), 4, OPTS);
    expect(steps[0].lines).toEqual([
      { kind: "progress", text: "60%" },
      { kind: "text", text: "done" },
      { kind: "progress", text: "again" },
    ]);
  });

  it("AI 步骤的回复增量归约成工序段：凑不满一行的尾巴也在，不再逐增量各占一行", () => {
    let steps = reduceWorkflowOutput([], out("step-start", "0"), 0, OPTS);
    steps = reduceWorkflowOutput(steps, out("ai", "你好", "0"), 100, OPTS);
    steps = reduceWorkflowOutput(steps, out("ai", "，世界", "0"), 150, OPTS);
    steps = reduceWorkflowOutput(steps, out("ai", "\n第二行", "0"), 400, OPTS);
    expect(steps[0].lines).toEqual([]); // 正文不进文本行：spine 用工序段面板渲染
    expect(steps[0].aiPanel?.segments).toMatchObject([{ kind: "answer", text: "你好，世界\n第二行", startedAt: 100 }]);
    expect(steps[0].aiPanel?.streaming).toBe(true);
    steps = reduceWorkflowOutput(steps, out("step-done", "0:0"), 900, OPTS);
    expect(steps[0].aiPanel?.segments[0]).toMatchObject({ durationMs: 800 });
    expect(steps[0].aiPanel?.streaming).toBe(false);
    expect(steps[0].aiPanel?.readout).toMatchObject({ isError: false });
  });

  it("AI 步骤的思考与工具调用进工序段，与 stdout/stderr 诊断行并存", () => {
    let steps = reduceWorkflowOutput([], out("step-start", "2"), 0, OPTS);
    steps = reduceWorkflowOutput(steps, out("ai-thinking", "想了想", "2"), 10, OPTS);
    steps = reduceWorkflowOutput(steps, out("ai-tool", tool("t1", "Read"), "2"), 60, OPTS);
    steps = reduceWorkflowOutput(steps, out("ai-tool", JSON.stringify({ id: "t1", content: "ok" }), "2"), 90, OPTS);
    steps = reduceWorkflowOutput(steps, out("ai", "结论", "2"), 200, OPTS);
    steps = reduceWorkflowOutput(steps, out("stderr", "warn", "2"), 210, OPTS);
    expect(steps[0].aiPanel?.segments).toMatchObject([
      { kind: "thinking", text: "想了想" },
      { kind: "tool", id: "t1", name: "Read", result: "ok" },
      { kind: "answer", text: "结论" },
    ]);
    expect(steps[0].lines).toEqual([{ kind: "text", text: "[stderr] warn" }]);
  });

  it("AI 步骤失败：面板收尾并标红读数", () => {
    let steps = reduceWorkflowOutput([], out("step-start", "0"), 0, OPTS);
    steps = reduceWorkflowOutput(steps, out("ai", "写到一半", "0"), 20, OPTS);
    steps = reduceWorkflowOutput(steps, out("step-done", "0:1"), 300, OPTS);
    expect(steps[0].status).toBe("error");
    expect(steps[0].aiPanel?.readout).toMatchObject({ isError: true });
    expect(steps[0].aiPanel?.streaming).toBe(false);
  });

  it("retry 的输出继续落回同一个桶（步骤索引不变）", () => {
    let steps = reduceWorkflowOutput([], out("step-start", "0"), 0, OPTS);
    steps = reduceWorkflowOutput(steps, out("stdout", "attempt 1", "0"), 10, OPTS);
    steps = reduceWorkflowOutput(steps, out("stdout", "retry 1/2"), 20, OPTS);
    steps = reduceWorkflowOutput(steps, out("stdout", "attempt 2", "0"), 30, OPTS);
    expect(steps[0].lines.map((l) => (l.kind === "text" ? l.text : ""))).toEqual(["attempt 1", "retry 1/2", "attempt 2"]);
  });

  it("纯函数：不修改传入的数组与桶对象", () => {
    const original: WorkflowStepState[] = [{ index: 0, status: "running", lines: [] }];
    const next = reduceWorkflowOutput(original, out("stdout", "x", "0"), 1, OPTS);
    expect(original[0].lines).toEqual([]);
    expect(next[0].lines).toHaveLength(1);
    expect(next).not.toBe(original);
  });
});
