import { describe, expect, it } from "vitest";
import { emptyFoldState, foldOutputLine } from "./outputFold";
import type { OutputEventData, OutputLineItem } from "../types/events";

const opts = { stderrPrefix: "[stderr] " };
const line = (seq: number, text = `line${seq}`): OutputEventData => ({
  stream: "stdout",
  line: text,
  seq,
});

// 行桶是 OutputLineItem 联合（text/progress/tree）：断言文本形态时用该 helper 展开
const texts = (items: OutputLineItem[]) =>
  items.map((it) => (it.kind === "tree" ? `<tree:${it.frame.title ?? ""}>` : it.text));

const treeLine = (seq: number, raw: string): OutputEventData => ({
  stream: "tree",
  line: raw,
  seq,
});

describe("foldOutputLine", () => {
  it("按 seq 到达顺序应用时直接追加", () => {
    let state = emptyFoldState();
    state = foldOutputLine(state, line(1), opts);
    state = foldOutputLine(state, line(2), opts);
    state = foldOutputLine(state, line(3), opts);
    expect(texts(state.lines)).toEqual(["line1", "line2", "line3"]);
    expect(state.lines).toEqual([
      { kind: "text", text: "line1" },
      { kind: "text", text: "line2" },
      { kind: "text", text: "line3" },
    ]);
  });

  it("乱序到达时按 seq 重排还原真实产出顺序（Wails Event.Emit 到达顺序无保证）", () => {
    let state = emptyFoldState();
    // 模拟真实故障场景：3 先到，1、2 后到
    state = foldOutputLine(state, line(3), opts);
    expect(state.lines).toEqual([]); // 3 号还没轮到，缓存住，不应用
    state = foldOutputLine(state, line(1), opts);
    expect(texts(state.lines)).toEqual(["line1"]);
    state = foldOutputLine(state, line(2), opts);
    // 2 到达后触发 pending 里的 3 一并回放
    expect(texts(state.lines)).toEqual(["line1", "line2", "line3"]);
  });

  it("大范围乱序仍能在空洞补齐后完整还原顺序", () => {
    const events = [line(1), line(2), line(3), line(4), line(5)];
    const shuffled = [events[2], events[4], events[0], events[3], events[1]];
    let state = emptyFoldState();
    for (const e of shuffled) {
      state = foldOutputLine(state, e, opts);
    }
    expect(texts(state.lines)).toEqual(["line1", "line2", "line3", "line4", "line5"]);
  });

  it("无 seq 字段（workflow 桶/旧数据）时原样按到达顺序应用，不缓存", () => {
    let state = emptyFoldState();
    state = foldOutputLine(state, { stream: "stdout", line: "a" }, opts);
    state = foldOutputLine(state, { stream: "stdout", line: "b" }, opts);
    expect(texts(state.lines)).toEqual(["a", "b"]);
  });

  it("stderr 加前缀，行为与重排叠加不冲突", () => {
    let state = emptyFoldState();
    state = foldOutputLine(state, { stream: "stderr", line: "boom", seq: 1 }, opts);
    expect(texts(state.lines)).toEqual(["[stderr] boom"]);
  });

  it("progress 在按 seq 正常应用时仍原地覆盖上一条 progress", () => {
    let state = emptyFoldState();
    state = foldOutputLine(state, { stream: "progress", line: "10%", seq: 1 }, opts);
    state = foldOutputLine(state, { stream: "progress", line: "50%", seq: 2 }, opts);
    state = foldOutputLine(state, { stream: "progress", line: "100%", seq: 3 }, opts);
    expect(state.lines).toEqual([{ kind: "progress", text: "100%" }]);
  });

  it("nextSeq=0 哨兵：以首个到达的 seq 为基线，不把中途重置后的输出挂死在 pending", () => {
    // run 中途重置（切回/清屏）时调用方置 0，此时后端序号已跑到 100 号段
    let state = foldOutputLine({ ...emptyFoldState(), nextSeq: 0 }, line(100), opts);
    expect(texts(state.lines)).toEqual(["line100"]);
    expect(state.nextSeq).toBe(101);
    // 对齐后继续按序推进，与常规重排行为一致
    state = foldOutputLine(state, line(102), opts);
    expect(texts(state.lines)).toEqual(["line100"]); // 102 还没轮到，缓存住
    state = foldOutputLine(state, line(101), opts);
    expect(texts(state.lines)).toEqual(["line100", "line101", "line102"]);
  });

  it("tree 流解析为树帧行项入桶，id 单调递增（React key 唯一）", () => {
    let state = emptyFoldState();
    state = foldOutputLine(state, line(1), opts);
    state = foldOutputLine(
      state,
      treeLine(2, JSON.stringify({ title: "t1", nodes: [{ label: "a", kind: "dir" }] })),
      opts,
    );
    state = foldOutputLine(
      state,
      treeLine(3, JSON.stringify({ title: "t2", nodes: [{ label: "b", kind: "file" }] })),
      opts,
    );
    const trees = state.lines.filter((it) => it.kind === "tree");
    expect(trees).toHaveLength(2);
    expect(trees[0]).toMatchObject({ kind: "tree", id: 0 });
    expect(trees[1]).toMatchObject({ kind: "tree", id: 1 });
    expect(state.treeSeq).toBe(2);
    expect(state.lastWasProgress).toBe(false);
  });

  it("tree 后跟 progress 不覆盖树帧（lastWasProgress 已复位）", () => {
    let state = emptyFoldState();
    state = foldOutputLine(
      state,
      treeLine(1, JSON.stringify({ nodes: [{ label: "a" }] })),
      opts,
    );
    state = foldOutputLine(state, { stream: "progress", line: "42%", seq: 2 }, opts);
    expect(state.lines).toHaveLength(2); // 树帧保留，progress 追加
    expect(state.lines[0].kind).toBe("tree");
    expect(state.lines[1]).toEqual({ kind: "progress", text: "42%" });
  });

  it("tree JSON 解析失败降级为单错误节点帧（errLabel 由调用方注入）", () => {
    let state = emptyFoldState();
    state = foldOutputLine(state, treeLine(1, "not-json{{{"), {
      ...opts,
      treeErrLabel: "解析失败",
    });
    const item = state.lines[0];
    expect(item.kind).toBe("tree");
    if (item.kind === "tree") {
      expect(item.frame.nodes).toEqual([{ label: "解析失败", detail: "not-json{{{" }]);
    }
  });

  it("tree 与文本混排经乱序回放后仍按真实顺序落桶", () => {
    let state = emptyFoldState();
    state = foldOutputLine(
      state,
      treeLine(2, JSON.stringify({ title: "T", nodes: [{ label: "n" }] })),
      opts,
    );
    expect(state.lines).toEqual([]); // 2 号挂 pending
    state = foldOutputLine(state, line(1, "before"), opts);
    // 1 到达补齐空洞，2 号树帧一并回放
    expect(state.lines.map((it) => it.kind)).toEqual(["text", "tree"]);
  });
});
