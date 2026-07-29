import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";

// mock bindings 与 runtime：用 vi.hoisted 保证提升后变量可用，工厂直接引用（无需转发 spread）
const { mockListActions, mockRunAction, mockCancelAction, mockOn, listeners } =
  vi.hoisted(() => {
    const listeners: Record<string, (e: unknown) => void> = {};
    const mockOn = vi.fn((name: string, cb: (e: unknown) => void) => {
      listeners[name] = cb;
      return () => {
        delete listeners[name];
      };
    });
    return {
      mockListActions: vi.fn(),
      mockRunAction: vi.fn(() => Promise.resolve()),
      mockCancelAction: vi.fn(),
      mockOn,
      listeners,
    };
  });

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: mockListActions,
  RunAction: mockRunAction,
  CancelAction: mockCancelAction,
}));

vi.mock("@wailsio/runtime", () => ({
  Events: { On: mockOn },
}));

import { ActionRunnerProvider, _emitForTest } from "./ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";

const wrapper = ({ children }: { children: ReactNode }) => (
  <ActionRunnerProvider>{children}</ActionRunnerProvider>
);

beforeEach(() => {
  Object.keys(listeners).forEach((k) => delete listeners[k]);
  mockListActions.mockReset();
  mockRunAction.mockReset().mockResolvedValue(undefined);
  mockCancelAction.mockReset();
  mockOn.mockClear();
});

describe("ActionRunnerProvider", () => {
  it("挂载时拉取动作列表", async () => {
    mockListActions.mockResolvedValue({
      actions: [{ id: "a1", title: "A1", icon: "▶", description: "" }],
      errors: [],
    });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    expect(result.current.actions).toHaveLength(1);
    expect(result.current.actions[0].id).toBe("a1");
  });

  it("runAction 后 status=running 并订阅事件", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAction("a1");
    });
    expect(result.current.status).toBe("running");
    expect(mockRunAction).toHaveBeenCalledWith("a1");
    expect(mockOn).toHaveBeenCalledWith("action:a1:output", expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith("action:a1:done", expect.any(Function));
  });

  it("收到 output 事件追加行（stderr 加前缀）", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAction("a1");
    });
    act(() => {
      _emitForTest("action:a1:output", { data: { stream: "stderr", line: "boom" } });
      _emitForTest("action:a1:output", { data: { stream: "stdout", line: "hi" } });
    });
    expect(result.current.lines).toEqual(["[stderr] boom", "hi"]);
  });

  it("收到 done 事件（exitCode 0）置 status=done", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAction("a1");
    });
    act(() => {
      _emitForTest("action:a1:done", {
        data: { exitCode: 0, err: "", duration: "1s" },
      });
    });
    expect(result.current.status).toBe("done");
    expect(result.current.exitInfo?.exitCode).toBe(0);
  });

  it("收到 done 事件（exitCode≠0）置 status=error", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAction("a1");
    });
    act(() => {
      _emitForTest("action:a1:done", {
        data: { exitCode: 2, err: "oops", duration: "1s" },
      });
    });
    expect(result.current.status).toBe("error");
  });

  it("cancel 调用 CancelAction", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAction("a1");
    });
    act(() => result.current.cancel());
    expect(mockCancelAction).toHaveBeenCalledWith("a1");
  });

  it("clearOutput 清空 lines", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAction("a1");
    });
    act(() =>
      _emitForTest("action:a1:output", { data: { stream: "stdout", line: "x" } })
    );
    act(() => result.current.clearOutput());
    expect(result.current.lines).toEqual([]);
  });
});
