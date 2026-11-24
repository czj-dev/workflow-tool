import { describe, expect, it } from "vitest";
import { EMPTY_AI_VIEW, MAX_AI_DIAG, MAX_AI_DIAG_LINE, reduceAiOutput, type AiViewState } from "./aiStream";
import type { OutputEventData } from "../types/events";

const out = (stream: OutputEventData["stream"], line: string): OutputEventData => ({ stream, line });

describe("reduceAiOutput", () => {
  it("ai 增量：并入回复正文，并作为回答段进入面板工序段", () => {
    let view = reduceAiOutput(EMPTY_AI_VIEW, out("ai", "你好"), 120);
    view = reduceAiOutput(view, out("ai", "世界"), 340);
    expect(view.text).toBe("你好世界");
    expect(view.thinking).toBe("");
    expect(view.panel.segments).toMatchObject([{ kind: "answer", text: "你好世界", startedAt: 120 }]);
    expect(view.panel.segments[0].durationMs).toBeNull(); // 仍在进行
    expect(view.panel.streaming).toBe(true);
  });

  it("ai-thinking 增量：并入思考正文，与回答段各成一段", () => {
    let view = reduceAiOutput(EMPTY_AI_VIEW, out("ai-thinking", "想了想"), 10);
    view = reduceAiOutput(view, out("ai", "答"), 50);
    expect(view.thinking).toBe("想了想");
    expect(view.text).toBe("答");
    expect(view.panel.segments).toMatchObject([
      { kind: "thinking", text: "想了想", durationMs: 40 }, // 开新段时结算上一段
      { kind: "answer", text: "答" },
    ]);
  });

  it("ai-tool：工具调用对进面板，不进正文", () => {
    let view = reduceAiOutput(EMPTY_AI_VIEW, out("ai-tool", JSON.stringify({ id: "t1", name: "Read", input: { file_path: "/repo/a.json" } })), 5);
    view = reduceAiOutput(view, out("ai-tool", JSON.stringify({ id: "t1", content: "ok" })), 25);
    expect(view.text).toBe("");
    expect(view.panel.segments).toMatchObject([{ kind: "tool", id: "t1", name: "Read", summary: "a.json", result: "ok", durationMs: 20 }]);
    // 解析不了的 tool 行被忽略
    view = reduceAiOutput(view, out("ai-tool", "not json"), 30);
    expect(view.panel.segments).toHaveLength(1);
  });

  it("stdout/stderr 进诊断行（失败时回看用），不进正文与面板", () => {
    let view = reduceAiOutput(EMPTY_AI_VIEW, out("stderr", "warn"), 0);
    view = reduceAiOutput(view, out("stdout", "debug"), 0);
    expect(view.diag).toEqual([
      { stream: "stderr", text: "warn" },
      { stream: "stdout", text: "debug" },
    ]);
    expect(view.text).toBe("");
    expect(view.panel.segments).toEqual([]);
  });

  it("诊断行有界：单行截断到上限，条数只留尾部", () => {
    let view: AiViewState = EMPTY_AI_VIEW;
    for (let i = 0; i < MAX_AI_DIAG + 10; i++) {
      view = reduceAiOutput(view, out("stderr", "x".repeat(MAX_AI_DIAG_LINE + 50)), 0);
    }
    expect(view.diag).toHaveLength(MAX_AI_DIAG);
    expect(view.diag[MAX_AI_DIAG - 1].text).toHaveLength(MAX_AI_DIAG_LINE);
    expect(view.diag[0].text).toHaveLength(MAX_AI_DIAG_LINE);
  });

  it("与 AI 无关的流原样返回同一引用（调用方可据此避免无谓渲染）", () => {
    const view = reduceAiOutput(EMPTY_AI_VIEW, out("ai", "答"), 0);
    expect(reduceAiOutput(view, out("progress", "50%"), 5)).toBe(view);
    expect(reduceAiOutput(view, out("tree", "{}"), 5)).toBe(view);
  });

  it("不修改传入的视图（纯函数）", () => {
    const before = reduceAiOutput(EMPTY_AI_VIEW, out("ai", "一"), 0);
    const snapshot = structuredClone({ text: before.text, segments: before.panel.segments });
    reduceAiOutput(before, out("ai", "二"), 9);
    expect({ text: before.text, segments: before.panel.segments }).toEqual(snapshot);
  });
});
