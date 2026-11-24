import { describe, expect, it } from "vitest";
import {
  aiRunSummary,
  isTerminalRunStatus,
  runDurationMs,
  runParam,
  schedulesOfTarget,
  targetTitle,
} from "./runs";
import type { RunItem } from "../types/events";

const item = (extra: Partial<RunItem> = {}): RunItem => ({
  id: "r20261125-021500-a1b2c3",
  targetKind: "action",
  targetId: "patrol",
  origin: "manual",
  scheduleId: "",
  status: "succeeded",
  reason: "",
  startedAt: "2026-11-25T02:15:00.500+08:00",
  finishedAt: "2026-11-25T02:15:04.250+08:00",
  exitCode: 0,
  params: {},
  outputs: {},
  ...extra,
});

describe("runDurationMs", () => {
  it("结束时刻减启动时刻", () => {
    expect(runDurationMs(item())).toBe(3_750);
  });
  it("没有结束时刻（运行中 / 中断）或时间解析不了 → null", () => {
    expect(runDurationMs(item({ finishedAt: "" }))).toBeNull();
    expect(runDurationMs(item({ startedAt: "not a date", finishedAt: "2026-11-25T02:15:04+08:00" }))).toBeNull();
  });
  it("时钟回拨导致的负值按 0 计", () => {
    expect(runDurationMs(item({ startedAt: "2026-11-25T02:15:04+08:00", finishedAt: "2026-11-25T02:15:00+08:00" }))).toBe(0);
  });
});

describe("isTerminalRunStatus", () => {
  it("只有 running 不是终态；未知状态保守地当作终态", () => {
    expect(isTerminalRunStatus("running")).toBe(false);
    for (const status of ["succeeded", "failed", "cancelled", "interrupted", "skipped", "something-new"]) {
      expect(isTerminalRunStatus(status)).toBe(true);
    }
  });
});

describe("runParam", () => {
  it("按运行当次的输入取参数，非字符串值转成 JSON 文本；缺失返回空串", () => {
    expect(runParam(item({ params: { a: "x", n: 3, b: true, o: { k: "v" }, nil: null } }), "a")).toBe("x");
    expect(runParam(item({ params: { n: 3, b: true, o: { k: "v" }, nil: null } }), "n")).toBe("3");
    expect(runParam(item({ params: { n: 3, b: true, o: { k: "v" }, nil: null } }), "b")).toBe("true");
    expect(runParam(item({ params: { n: 3, b: true, o: { k: "v" }, nil: null } }), "o")).toBe('{"k":"v"}');
    expect(runParam(item({ params: { n: 3, b: true, o: { k: "v" }, nil: null } }), "nil")).toBe("");
    expect(runParam(item(), "missing")).toBe("");
  });
});

describe("aiRunSummary", () => {
  it("AI 卡叙述区的摘要：最近一次运行的提示词，按当次输入展开 ${VAR}", () => {
    const summary = aiRunSummary(item({ targetKind: "ai", params: { prompt: "介绍一下 ${TOPIC}，优先 ${DEPTH} 层", TOPIC: "crash", DEPTH: 3 } }));
    expect(summary).toBe("介绍一下 crash，优先 3 层");
  });
  it("保留运行里没提供的变量（与 runner.Expand 一致：未命中保留原样）", () => {
    expect(aiRunSummary(item({ targetKind: "ai", params: { prompt: "看 ${MISSING}" } }))).toBe("看 ${MISSING}");
  });
  it("没有运行、没有提示词输入、或提示词全是空白 → null（卡片回落到描述）", () => {
    expect(aiRunSummary(null)).toBeNull();
    expect(aiRunSummary(undefined)).toBeNull();
    expect(aiRunSummary(item({ targetKind: "ai", params: { TOPIC: "x" } }))).toBeNull();
    expect(aiRunSummary(item({ targetKind: "ai", params: { prompt: "  \n " } }))).toBeNull();
    expect(aiRunSummary(item({ targetKind: "ai", params: { prompt: 42 } }))).toBeNull();
  });
  it("多行提示词压成一行（卡片只有一行叙述区）", () => {
    expect(aiRunSummary(item({ targetKind: "ai", params: { prompt: "第一行\n  第二行\r\n第三行  " } }))).toBe("第一行 第二行 第三行");
  });
});

describe("targetTitle", () => {
  const actions = [{ id: "patrol", title: "巡检" }];
  const workflows = [{ id: "daily", title: "每日" }];
  const aiTasks = [{ id: "review-bot", title: "审查" }];

  it("按目标种类到各自的列表里找标题", () => {
    expect(targetTitle("action", "patrol", { actions, workflows, aiTasks })).toBe("巡检");
    expect(targetTitle("workflow", "daily", { actions, workflows, aiTasks })).toBe("每日");
    expect(targetTitle("ai", "review-bot", { actions, workflows, aiTasks })).toBe("审查");
  });
  it("同名的动作与 AI 任务各取各的；找不到目标回落显示 id", () => {
    expect(targetTitle("action", "review-bot", { actions, workflows, aiTasks })).toBe("review-bot");
    expect(targetTitle("ai", "patrol", { actions, workflows, aiTasks })).toBe("patrol");
    expect(targetTitle("workflow", "nope", { actions, workflows, aiTasks })).toBe("nope");
  });
});

describe("schedulesOfTarget", () => {
  const schedules = [
    { id: "s1", targetKind: "ai", targetId: "review-bot" },
    { id: "s2", targetKind: "ai", targetId: "review-bot" },
    { id: "s3", targetKind: "action", targetId: "review-bot" },
    { id: "s4", targetKind: "ai", targetId: "other" },
  ];
  it("同一任务可被多条调度指向：全部列出，且只认种类匹配的", () => {
    expect(schedulesOfTarget(schedules, "ai", "review-bot").map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(schedulesOfTarget(schedules, "action", "review-bot").map((s) => s.id)).toEqual(["s3"]);
    expect(schedulesOfTarget(schedules, "ai", "nobody")).toEqual([]);
  });
});
