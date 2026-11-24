import { describe, expect, it } from "vitest";
import {
  applyLiveEvent,
  applyRunEvent,
  newRunPlayer,
  replayRun,
  type RunPlayerOpts,
  type RunPlayerState,
} from "./runReplay";
import type { RunEvent } from "../types/events";

const OPTS: RunPlayerOpts = {
  stderrPrefix: "[stderr] ",
  exitLine: (code, err) => `--- 退出码 ${code}${err ? ` 错误: ${err}` : ""} ---`,
  isTreeEnabled: () => false,
};
const out = (t: number, seq: number, stream: RunEvent["stream"] & string, line: string, step?: string): RunEvent =>
  step === undefined ? { t, event: "output", stream, line, seq } : { t, event: "output", stream, line, seq, step };
const done = (t: number, seq: number, extra: Partial<RunEvent> = {}): RunEvent => ({ t, event: "done", seq, exitCode: 0, err: "", duration: "1s", ...extra });

const texts = (state: RunPlayerState) => state.lines.map((l) => (l.kind === "text" || l.kind === "progress" ? l.text : `<${l.kind}>`));

describe("replayRun — 动作", () => {
  it("stdout/stderr/progress 还原成输出桶，末尾是退出码行", () => {
    const state = replayRun("action", [
      out(0, 1, "stdout", "hello"),
      out(5, 2, "stderr", "warn"),
      out(9, 3, "progress", "50%"),
      out(12, 4, "progress", "100%"),
      done(20, 5, { exitCode: 0 }),
    ], OPTS);
    expect(texts(state)).toEqual(["hello", "[stderr] warn", "100%", "--- 退出码 0 ---"]);
    expect(state.done).toMatchObject({ exitCode: 0, duration: "1s" });
    expect(state.steps).toEqual([]);
    expect(state.truncated).toBe(false);
  });

  it("失败的运行：退出码行带错误原因", () => {
    const state = replayRun("action", [out(0, 1, "stdout", "x"), done(9, 2, { exitCode: 3, err: "boom" })], OPTS);
    expect(texts(state)).toEqual(["x", "--- 退出码 3 错误: boom ---"]);
  });

  it("落盘顺序乱了也按 seq 还原真实产出顺序", () => {
    const state = replayRun("action", [out(3, 2, "stdout", "二"), out(1, 1, "stdout", "一")], OPTS);
    expect(texts(state)).toEqual(["一", "二"]);
  });

  it("done 独占一个号：号段里的洞被跨过，之后的迟到输出不卡死", () => {
    // 前端契约：done 独占 seq（这里是 3），2 号是迟到的 output，4 号在 done 之后到达
    const state = replayRun("action", [
      out(0, 1, "stdout", "a"),
      done(10, 3),
      out(4, 2, "stdout", "b"),
      out(11, 4, "stdout", "late"),
    ], OPTS);
    expect(texts(state)).toEqual(["a", "b", "--- 退出码 0 ---", "late"]);
  });

  it("早退的 done 不带 seq：输出照常，退出码行仍在末尾", () => {
    const state = replayRun("action", [{ t: 0, event: "done", exitCode: -1, err: "工作目录不存在", duration: "0s" }], OPTS);
    expect(texts(state)).toEqual(["--- 退出码 -1 错误: 工作目录不存在 ---"]);
  });

  it("运行日志到达上限：标记截断，其后的内容本来就没落盘", () => {
    const state = replayRun("action", [out(0, 1, "stdout", "x"), { t: 5, event: "truncated", limit: 100 }], OPTS);
    expect(state.truncated).toBe(true);
    expect(texts(state)).toEqual(["x"]);
  });

  it("logcat 帧展开成一行一条；重放首帧整体替换、后续帧追加", () => {
    const entry = (msg: string, tag = "Tag") => JSON.stringify([{ date: "11-25", time: "01:02:03.004", pid: 1, tid: 2, level: "I", tag, message: msg }]);
    const state = replayRun("action", [
      out(0, 1, "logcat", entry("old")),
      out(1, 2, "logcat-replace", JSON.stringify({ head: true, entries: [{ date: "11-25", time: "01:02:03.004", pid: 1, tid: 2, level: "W", tag: "T", message: "fresh" }] })),
      out(2, 3, "logcat-replace", JSON.stringify({ head: false, entries: [{ date: "11-25", time: "01:02:03.005", pid: 1, tid: 2, level: "E", tag: "T", message: "more" }] })),
    ], OPTS);
    // 列宽同 logcat 原生格式（PID / TID 各 5 宽）
    expect(texts(state)).toEqual([
      "11-25 01:02:03.004     1     2 W T: fresh",
      "11-25 01:02:03.005     1     2 E T: more",
    ]);
  });

  it("树帧：声明了树的动作还原成树块，否则按文本行显示", () => {
    const frame = JSON.stringify({ title: "t", nodes: [{ label: "root", children: [] }] });
    const tree = replayRun("action", [out(0, 1, "tree", frame)], { ...OPTS, isTreeEnabled: () => true });
    expect(tree.lines[0].kind).toBe("tree");
    const plain = replayRun("action", [out(0, 1, "tree", frame)], OPTS);
    expect(texts(plain)).toEqual([`##[tree ${frame}]`]);
  });
});

describe("replayRun — AI 任务", () => {
  it("回复/思考/工具调用还原成工序段，时间轴取运行日志里的偏移", () => {
    const state = replayRun("ai", [
      out(100, 1, "ai", "你好"),
      out(160, 2, "ai-thinking", "想了想"),
      out(400, 3, "ai", "，世界"),
      out(410, 4, "ai-tool", JSON.stringify({ id: "t1", name: "Read", input: { file_path: "/repo/a.json" } })),
      out(900, 5, "ai-tool", JSON.stringify({ id: "t1", content: "ok" })),
      done(1200, 6, { readout: { durationMs: 1200, sessionId: "sess-1", costUsd: 0.5, inputTokens: 10, outputTokens: 5 } }),
    ], OPTS);
    expect(state.ai.text).toBe("你好，世界");
    expect(state.ai.thinking).toBe("想了想");
    expect(state.ai.panel.segments).toMatchObject([
      { kind: "answer", text: "你好", startedAt: 100, durationMs: 60 },
      { kind: "thinking", text: "想了想", startedAt: 160, durationMs: 240 },
      { kind: "answer", text: "，世界", startedAt: 400 },
      { kind: "tool", id: "t1", name: "Read", summary: "a.json", result: "ok", startedAt: 410, durationMs: 490 },
    ]);
    // done 收尾：末段按终点读数结算，面板不再是流式态
    expect(state.ai.panel.streaming).toBe(false);
    expect(state.ai.panel.readout).toMatchObject({ sessionId: "sess-1", costUsd: 0.5, isError: false });
    // AI 运行没有退出码行，也没有文本行
    expect(state.lines).toEqual([]);
  });

  it("stdout/stderr 进诊断行", () => {
    const state = replayRun("ai", [out(0, 1, "stderr", "[skill-sync] warn"), out(5, 2, "ai", "答")], OPTS);
    expect(state.ai.diag).toEqual([{ stream: "stderr", text: "[skill-sync] warn" }]);
    expect(state.ai.text).toBe("答");
  });

  it("没有 done（运行中 / 中断）：面板停在流式态，读数为空", () => {
    const state = replayRun("ai", [out(0, 1, "ai", "写到一半")], OPTS);
    expect(state.done).toBeNull();
    expect(state.ai.panel.streaming).toBe(true);
    expect(state.ai.panel.readout).toBeNull();
  });

  it("失败收尾：读数标红，保留后端给出的会话 id", () => {
    const state = replayRun("ai", [
      out(0, 1, "ai", "半截"),
      done(50, 2, { exitCode: 1, err: "CLI 未安装", readout: { sessionId: "sess-9" } }),
    ], OPTS);
    expect(state.ai.panel.readout).toMatchObject({ isError: true, sessionId: "sess-9" });
    expect(state.ai.panel.segments[0].durationMs).toBe(50);
  });
});

describe("replayRun — 工作流", () => {
  it("步骤输出按归属落桶，AI 步骤以工序段呈现", () => {
    const state = replayRun("workflow", [
      out(0, 1, "step-start", "0", "0"),
      out(10, 2, "stdout", "building", "0"),
      out(100, 3, "step-done", "0:0", "0"),
      out(100, 4, "step-start", "1", "1"),
      out(120, 5, "ai-thinking", "想", "1"),
      out(300, 6, "ai", "结论", "1"),
      out(500, 7, "step-done", "1:0", "1"),
      { t: 600, event: "done", exitCode: 0, err: "", duration: "600ms" },
    ], OPTS);
    expect(state.steps).toHaveLength(2);
    expect(state.steps[0]).toMatchObject({ index: 0, status: "done", exitCode: 0, startedAt: 0, endedAt: 100 });
    expect(texts({ ...state, lines: state.steps[0].lines })).toEqual(["building"]);
    expect(state.steps[1].aiPanel?.segments).toMatchObject([
      { kind: "thinking", text: "想", durationMs: 180 },
      { kind: "answer", text: "结论" },
    ]);
    expect(state.steps[1].status).toBe("done");
    expect(state.lines).toEqual([]);
  });

  it("工作流的输出也带 seq：落盘顺序乱了同样按 seq 还原，归属不会串步", () => {
    // 1 号（步骤 0 的输出）落盘在后：不设门的话它会被直接应用，排在 step-done 之后
    const state = replayRun("workflow", [
      out(11, 2, "stdout", "for step 1", "1"),
      out(12, 3, "step-done", "0:0", "0"),
      out(9, 1, "stdout", "for step 0", "0"),
    ], OPTS);
    // 1 号补到后按序出队：0、1、2、3 全部应用
    expect(texts({ ...state, lines: state.steps[0].lines })).toEqual(["for step 0"]);
    expect(state.steps[0].status).toBe("done");
    expect(texts({ ...state, lines: state.steps[1].lines })).toEqual(["for step 1"]);
    expect(state.gate.nextSeq).toBe(4);
  });
});

describe("applyRunEvent — 实时逐条应用", () => {
  it("逐条应用与一次性回放结果一致（同一个归约器）", () => {
    const events: RunEvent[] = [
      out(0, 1, "stdout", "a"),
      out(30, 2, "progress", "10%"),
      out(60, 3, "progress", "90%"),
      out(90, 4, "stderr", "w"),
      done(100, 5),
      out(95, 6, "stdout", "late"),
    ];
    const once = replayRun("action", events, OPTS);
    let stepwise = newRunPlayer("action");
    for (const ev of events) stepwise = applyRunEvent(stepwise, ev, ev.t, OPTS);
    expect(stepwise).toEqual(once);
  });

  it("实时传入的时刻用于工序段时间轴（日志里没有偏移可用）", () => {
    let state = newRunPlayer("ai");
    state = applyRunEvent(state, { event: "output", stream: "ai", line: "你", seq: 1, t: 0 }, 1000, OPTS);
    state = applyRunEvent(state, { event: "output", stream: "ai", line: "好", seq: 2, t: 0 }, 1500, OPTS);
    expect(state.ai.panel.segments[0]).toMatchObject({ startedAt: 1000, text: "你好" });
  });

  it("空日志得到空状态", () => {
    expect(replayRun("action", [], OPTS)).toEqual(newRunPlayer("action"));
    expect(replayRun("ai", [], OPTS).ai.panel.segments).toEqual([]);
  });

  it("实时跟踪：先订阅后读盘，重送的旧事件被跳过，之后的事件接着应用（三种目标都是）", () => {
    for (const kind of ["action", "ai", "workflow"] as const) {
      // 快照（读盘）含 1、2 号；订阅在读盘之前建立，所以 1、2 号又被实时送来一遍
      let state = replayRun(kind, [out(0, 1, "ai", "a", "0"), out(5, 2, "ai", "b", "0")], OPTS);
      expect(applyLiveEvent(state, out(0, 1, "ai", "a", "0"), 900, OPTS)).toBe(state); // 同一引用：没动
      expect(applyLiveEvent(state, out(0, 2, "ai", "b", "0"), 901, OPTS)).toBe(state);
      // 3 号在读盘之后产生：只有订阅里有，不丢
      state = applyLiveEvent(state, out(6, 3, "ai", "c", "0"), 902, OPTS);
      state = applyLiveEvent(state, out(7, 4, "ai", "d", "0"), 903, OPTS);
      // 同一个 ai 流在三种目标里落处不同：动作是文本行，AI 任务是回复增量，工作流是步骤的工序段
      const text =
        kind === "ai" ? state.ai.text
          : kind === "workflow"
            ? state.steps[0].aiPanel?.segments.map((seg) => (seg.kind === "answer" ? seg.text : "")).join("|")
            : texts(state).join("|");
      // 每条输出恰好出现一次：动作每条一行；AI 回复与步骤工序段把增量续接成一段
      expect(text).toBe(kind === "action" ? "a|b|c|d" : "abcd");
    }
  });

  it("实时跟踪：读盘之后才到的 3 号不会因为 2 号迟到而被挡在门外", () => {
    // 先订阅后读盘下不存在「读盘与订阅之间的输出」；但到达顺序仍可能乱：2 号晚于 3 号到
    let state = replayRun("ai", [out(0, 1, "ai", "a")], OPTS);
    state = applyLiveEvent(state, out(6, 3, "ai", "c"), 902, OPTS);
    expect(state.ai.text).toBe("a"); // 3 号等 2 号
    state = applyLiveEvent(state, out(5, 2, "ai", "b"), 903, OPTS);
    expect(state.ai.text).toBe("abc");
  });
});
