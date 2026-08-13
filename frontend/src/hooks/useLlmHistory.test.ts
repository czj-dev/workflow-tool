// frontend/src/hooks/useLlmHistory.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLlmHistory, LLM_HISTORY_MAX, RESPONSE_CAP } from "./useLlmHistory";

describe("useLlmHistory", () => {
  beforeEach(() => localStorage.clear());

  it("append 后 entries 倒序返回，最新在前", () => {
    const { result } = renderHook(() => useLlmHistory("card-a"));
    act(() => result.current.append({ prompt: "q1", params: {}, response: "r1", thinking: "", exitCode: 0, duration: "1s" }));
    act(() => result.current.append({ prompt: "q2", params: {}, response: "r2", thinking: "", exitCode: 0, duration: "2s" }));
    expect(result.current.entries.map((e) => e.prompt)).toEqual(["q2", "q1"]);
  });

  it("按 actionId 分桶，互不干扰", () => {
    const { result: a } = renderHook(() => useLlmHistory("card-a"));
    const { result: b } = renderHook(() => useLlmHistory("card-b"));
    act(() => a.current.append({ prompt: "qa", params: {}, response: "", thinking: "", exitCode: 0, duration: "" }));
    expect(b.current.entries).toHaveLength(0);
  });

  it("超过 LLM_HISTORY_MAX 条时丢弃最旧", () => {
    const { result } = renderHook(() => useLlmHistory("card-a"));
    act(() => {
      for (let i = 0; i < LLM_HISTORY_MAX + 5; i++) {
        result.current.append({ prompt: `q${i}`, params: {}, response: "", thinking: "", exitCode: 0, duration: "" });
      }
    });
    expect(result.current.entries).toHaveLength(LLM_HISTORY_MAX);
    expect(result.current.entries[0].prompt).toBe(`q${LLM_HISTORY_MAX + 4}`);
  });

  it("response 超过 RESPONSE_CAP 被截断并加后缀", () => {
    const { result } = renderHook(() => useLlmHistory("card-a"));
    const big = "x".repeat(RESPONSE_CAP + 100);
    act(() => result.current.append({ prompt: "q", params: {}, response: big, thinking: "", exitCode: 0, duration: "" }));
    expect(result.current.entries[0].response.length).toBeLessThanOrEqual(RESPONSE_CAP + 20);
    expect(result.current.entries[0].response).toContain("…（已截断）");
  });

  it("clear 清空当前卡片历史", () => {
    const { result } = renderHook(() => useLlmHistory("card-a"));
    act(() => result.current.append({ prompt: "q", params: {}, response: "", thinking: "", exitCode: 0, duration: "" }));
    act(() => result.current.clear());
    expect(result.current.entries).toHaveLength(0);
  });

  it("actionId 为 null 时 entries 为空且 append 静默无操作", () => {
    const { result } = renderHook(() => useLlmHistory(null));
    act(() => result.current.append({ prompt: "q", params: {}, response: "", thinking: "", exitCode: 0, duration: "" }));
    expect(result.current.entries).toHaveLength(0);
  });
});
