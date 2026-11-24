// frontend/src/hooks/useAiHistory.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import {
  appendAiHistory,
  clearAiHistory,
  useAiHistory,
  AI_HISTORY_MAX,
  RESPONSE_CAP,
  THINKING_CAP,
  TOOL_RESULT_CAP,
  type AiHistoryInput,
} from "./useAiHistory";

const entry = (prompt: string, extra: Partial<AiHistoryInput> = {}): AiHistoryInput => ({
  prompt,
  params: {},
  response: "",
  thinking: "",
  exitCode: 0,
  duration: "",
  ...extra,
});
const prompts = (entries: { prompt: string }[]) => entries.map((e) => e.prompt);

// 历史仓是模块级单例（localStorage 只在首次访问某任务时读入，之后以内存为准）：
// 逐例清空内存桶，用例之间才互不影响。
const HOOK_IDS = ["card-a", "card-b"];
const STORE_IDS = ["hub-a", "hub-b", "hub-quota"];

describe("useAiHistory", () => {
  beforeEach(() => {
    localStorage.clear();
    for (const id of HOOK_IDS) clearAiHistory(id);
  });

  it("append 后 entries 倒序返回，最新在前", () => {
    const { result } = renderHook(() => useAiHistory("card-a"));
    act(() => result.current.append(entry("q1", { response: "r1", duration: "1s" })));
    act(() => result.current.append(entry("q2", { response: "r2", duration: "2s" })));
    expect(prompts(result.current.entries)).toEqual(["q2", "q1"]);
  });

  it("按任务 id 分桶，互不干扰", () => {
    const { result: a } = renderHook(() => useAiHistory("card-a"));
    const { result: b } = renderHook(() => useAiHistory("card-b"));
    act(() => a.current.append(entry("qa")));
    expect(prompts(a.current.entries)).toEqual(["qa"]);
    expect(b.current.entries).toHaveLength(0);
  });

  it("超过 AI_HISTORY_MAX 条时丢弃最旧", () => {
    const { result } = renderHook(() => useAiHistory("card-a"));
    act(() => {
      for (let i = 0; i < AI_HISTORY_MAX + 5; i++) {
        result.current.append(entry(`q${i}`));
      }
    });
    expect(result.current.entries).toHaveLength(AI_HISTORY_MAX);
    expect(result.current.entries[0].prompt).toBe(`q${AI_HISTORY_MAX + 4}`);
  });

  it("response 超过 RESPONSE_CAP 被截断并加后缀", () => {
    const { result } = renderHook(() => useAiHistory("card-a"));
    const big = "x".repeat(RESPONSE_CAP + 100);
    act(() => result.current.append(entry("q", { response: big })));
    expect(result.current.entries[0].response.length).toBeLessThanOrEqual(RESPONSE_CAP + 20);
    expect(result.current.entries[0].response).toContain("…（已截断）");
  });

  it("thinking 与工具结果分别按 THINKING_CAP / TOOL_RESULT_CAP 截断；短的原样保留", () => {
    const { result } = renderHook(() => useAiHistory("card-a"));
    act(() =>
      result.current.append(
        entry("q", {
          thinking: "t".repeat(THINKING_CAP + 50),
          tools: [
            { id: "c1", name: "Read", summary: "a.json", result: "x".repeat(TOOL_RESULT_CAP + 50) },
            { id: "c2", name: "Grep", summary: "k", result: "short" },
          ],
        }),
      ),
    );
    const e = result.current.entries[0];
    expect(e.thinking.length).toBeLessThanOrEqual(THINKING_CAP + 20);
    expect(e.thinking).toContain("…（已截断）");
    expect(e.tools?.[0].result?.length).toBeLessThanOrEqual(TOOL_RESULT_CAP + 20);
    expect(e.tools?.[0].result).toContain("…（已截断）");
    expect(e.tools?.[1].result).toBe("short");
  });

  it("sessionId / exitCode / duration / tools 原样保留；id 与 timestamp 自动生成", () => {
    const { result } = renderHook(() => useAiHistory("card-a"));
    act(() =>
      result.current.append(
        entry("q", {
          params: { A: "1" },
          sessionId: "sess-1",
          exitCode: 1,
          duration: "3.5s",
          tools: [{ id: "c1", name: "Read", summary: "a.json", isError: true, durationMs: 12 }],
        }),
      ),
    );
    expect(result.current.entries[0]).toMatchObject({
      prompt: "q",
      params: { A: "1" },
      sessionId: "sess-1",
      exitCode: 1,
      duration: "3.5s",
      tools: [{ id: "c1", name: "Read", summary: "a.json", isError: true, durationMs: 12 }],
    });
    expect(result.current.entries[0].id).toEqual(expect.any(String));
    expect(result.current.entries[0].timestamp).toBeGreaterThan(0);
  });

  it("clear 清空当前任务的历史", () => {
    const { result } = renderHook(() => useAiHistory("card-a"));
    act(() => result.current.append(entry("q")));
    act(() => result.current.clear());
    expect(result.current.entries).toHaveLength(0);
  });

  it("taskId 为 null 时 entries 为空且 append 静默无操作", () => {
    const { result } = renderHook(() => useAiHistory(null));
    act(() => result.current.append(entry("q")));
    expect(result.current.entries).toHaveLength(0);
  });

  it("taskId 切换：entries 换成新任务的，append/clear 也跟着换目标", () => {
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useAiHistory(id), {
      initialProps: { id: "card-a" } as { id: string | null },
    });
    act(() => result.current.append(entry("qa")));
    rerender({ id: "card-b" });
    expect(result.current.entries).toHaveLength(0);
    act(() => result.current.append(entry("qb")));
    expect(prompts(result.current.entries)).toEqual(["qb"]);
    rerender({ id: "card-a" });
    expect(prompts(result.current.entries)).toEqual(["qa"]);
    rerender({ id: null });
    expect(result.current.entries).toHaveLength(0);
    act(() => result.current.clear());
    // null 上 clear 无操作：card-a 的历史不受影响
    rerender({ id: "card-a" });
    expect(prompts(result.current.entries)).toEqual(["qa"]);
  });
});

// 模块级历史仓：Provider 在运行收尾时写入（那时任务未必是 currentId），会话页与网格卡
// 各自订阅——三者必须是同一份数据。
describe("AI 历史仓（模块级）", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    // 先卸载仍挂载的订阅者，再清桶（否则会在 act 之外通知它们重渲染）
    cleanup();
    for (const id of STORE_IDS) clearAiHistory(id);
  });

  it("同一任务的多个订阅者共享 entries：appendAiHistory 后各自都更新", () => {
    const a = renderHook(() => useAiHistory("hub-a"));
    const b = renderHook(() => useAiHistory("hub-a"));
    expect(a.result.current.entries).toHaveLength(0);
    act(() => appendAiHistory("hub-a", entry("q1")));
    expect(prompts(a.result.current.entries)).toEqual(["q1"]);
    expect(prompts(b.result.current.entries)).toEqual(["q1"]);
    // 模块函数 clear 同样通知全部订阅者
    act(() => clearAiHistory("hub-a"));
    expect(a.result.current.entries).toHaveLength(0);
    expect(b.result.current.entries).toHaveLength(0);
  });

  it("不经过 hook 也能写入；之后的订阅者读到的已是内存里的最新值", () => {
    act(() => appendAiHistory("hub-a", entry("q1")));
    act(() => appendAiHistory("hub-a", entry("q2")));
    const { result } = renderHook(() => useAiHistory("hub-a"));
    expect(prompts(result.current.entries)).toEqual(["q2", "q1"]);
  });

  it("落盘键为 ai-history:<任务id>，各任务互不干扰", () => {
    act(() => {
      appendAiHistory("hub-a", entry("qa"));
      appendAiHistory("hub-b", entry("qb"));
    });
    const read = (id: string) =>
      prompts(JSON.parse(localStorage.getItem(`ai-history:${id}`) ?? "[]") as { prompt: string }[]);
    expect(read("hub-a")).toEqual(["qa"]);
    expect(read("hub-b")).toEqual(["qb"]);
    expect(localStorage.getItem("llm-history:hub-a")).toBeNull();
  });

  it("clearAiHistory 清空并落盘", () => {
    const { result } = renderHook(() => useAiHistory("hub-a"));
    act(() => appendAiHistory("hub-a", entry("q1")));
    act(() => clearAiHistory("hub-a"));
    expect(result.current.entries).toHaveLength(0);
    expect(localStorage.getItem("ai-history:hub-a")).toBe("[]");
  });

  it("持久化数据不可信：坏 JSON / 非数组 / 缺 id 的项一律丢弃", () => {
    // 桶只在首次访问时读盘：每个场景都要用一个本文件里没访问过的 id
    const FRESH = ["hub-bad1", "hub-bad2", "hub-bad3"];
    try {
      localStorage.setItem("ai-history:hub-bad1", "not json");
      expect(renderHook(() => useAiHistory("hub-bad1")).result.current.entries).toEqual([]);

      localStorage.setItem("ai-history:hub-bad2", JSON.stringify({ prompt: "不是数组" }));
      expect(renderHook(() => useAiHistory("hub-bad2")).result.current.entries).toEqual([]);

      localStorage.setItem(
        "ai-history:hub-bad3",
        JSON.stringify([
          null,
          "x",
          { id: 7, prompt: "id 不是字符串" },
          { prompt: "没有 id" },
          { id: "ok-1", timestamp: 1, prompt: "keep", params: {}, response: "", thinking: "", exitCode: 0, duration: "" },
        ]),
      );
      const { result } = renderHook(() => useAiHistory("hub-bad3"));
      expect(prompts(result.current.entries)).toEqual(["keep"]);
    } finally {
      cleanup(); // 先卸载订阅者，清桶时才不会在 act 之外触发重渲染
      for (const id of FRESH) clearAiHistory(id);
    }
  });

  it("写入失败（配额 / 隐私模式）静默降级：历史仍留在内存里可读", () => {
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    try {
      const { result } = renderHook(() => useAiHistory("hub-quota"));
      act(() => result.current.append(entry("q1")));
      expect(prompts(result.current.entries)).toEqual(["q1"]);
    } finally {
      setItem.mockRestore();
    }
  });
});
