import { describe, expect, it } from "vitest";
import { emptyFoldState, foldOutputLine } from "./outputFold";
import type { OutputEventData } from "../types/events";

const opts = { stderrPrefix: "[stderr] " };
const line = (seq: number, text = `line${seq}`): OutputEventData => ({
  stream: "stdout",
  line: text,
  seq,
});

describe("foldOutputLine", () => {
  it("按 seq 到达顺序应用时直接追加", () => {
    let state = emptyFoldState();
    state = foldOutputLine(state, line(1), opts);
    state = foldOutputLine(state, line(2), opts);
    state = foldOutputLine(state, line(3), opts);
    expect(state.lines).toEqual(["line1", "line2", "line3"]);
  });

  it("乱序到达时按 seq 重排还原真实产出顺序（Wails Event.Emit 到达顺序无保证）", () => {
    let state = emptyFoldState();
    // 模拟真实故障场景：3 先到，1、2 后到
    state = foldOutputLine(state, line(3), opts);
    expect(state.lines).toEqual([]); // 3 号还没轮到，缓存住，不应用
    state = foldOutputLine(state, line(1), opts);
    expect(state.lines).toEqual(["line1"]);
    state = foldOutputLine(state, line(2), opts);
    // 2 到达后触发 pending 里的 3 一并回放
    expect(state.lines).toEqual(["line1", "line2", "line3"]);
  });

  it("大范围乱序仍能在空洞补齐后完整还原顺序", () => {
    const events = [line(1), line(2), line(3), line(4), line(5)];
    const shuffled = [events[2], events[4], events[0], events[3], events[1]];
    let state = emptyFoldState();
    for (const e of shuffled) {
      state = foldOutputLine(state, e, opts);
    }
    expect(state.lines).toEqual(["line1", "line2", "line3", "line4", "line5"]);
  });

  it("无 seq 字段（workflow 桶/旧数据）时原样按到达顺序应用，不缓存", () => {
    let state = emptyFoldState();
    state = foldOutputLine(state, { stream: "stdout", line: "a" }, opts);
    state = foldOutputLine(state, { stream: "stdout", line: "b" }, opts);
    expect(state.lines).toEqual(["a", "b"]);
  });

  it("stderr 加前缀，行为与重排叠加不冲突", () => {
    let state = emptyFoldState();
    state = foldOutputLine(state, { stream: "stderr", line: "boom", seq: 1 }, opts);
    expect(state.lines).toEqual(["[stderr] boom"]);
  });

  it("progress 在按 seq 正常应用时仍原地覆盖上一条 progress", () => {
    let state = emptyFoldState();
    state = foldOutputLine(state, { stream: "progress", line: "10%", seq: 1 }, opts);
    state = foldOutputLine(state, { stream: "progress", line: "50%", seq: 2 }, opts);
    state = foldOutputLine(state, { stream: "progress", line: "100%", seq: 3 }, opts);
    expect(state.lines).toEqual(["100%"]);
  });
});
