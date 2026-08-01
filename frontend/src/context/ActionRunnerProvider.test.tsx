import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";

// mock bindings 与 runtime：用 vi.hoisted 保证提升后变量可用，工厂直接引用（无需转发 spread）
const {
  mockListActions,
  mockRunAction,
  mockCancelAction,
  mockGetGlobalConfig,
  mockSetGlobalConfig,
  mockPickDirectory,
  mockOn,
  listeners,
} = vi.hoisted(() => {
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
      mockGetGlobalConfig: vi.fn(),
      mockSetGlobalConfig: vi.fn(),
      mockPickDirectory: vi.fn(),
      mockOn,
      listeners,
    };
  });

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: mockListActions,
  RunAction: mockRunAction,
  CancelAction: mockCancelAction,
  GetGlobalConfig: mockGetGlobalConfig,
  SetGlobalConfig: mockSetGlobalConfig,
  GetFragments: vi.fn().mockResolvedValue([]),
  SetFragments: vi.fn().mockResolvedValue(undefined),
  PickDirectory: mockPickDirectory,
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
  mockGetGlobalConfig.mockReset().mockResolvedValue({});
  mockSetGlobalConfig.mockReset().mockResolvedValue(undefined);
  mockPickDirectory.mockReset().mockResolvedValue("");
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
    expect(mockRunAction).toHaveBeenCalledWith("a1", {});
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

  it("挂载时拉取全局配置", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockGetGlobalConfig.mockResolvedValue({ OUTPUT_DIR: "D:/pages" });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    expect(result.current.globalConfig.OUTPUT_DIR).toBe("D:/pages");
  });

  it("runAction 带 params 调用 RunAction(id, params)", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAction("a1", { NAME: "x" });
    });
    expect(mockRunAction).toHaveBeenCalledWith("a1", { NAME: "x" });
  });

  it("selectPreset 填充 formValues 并切到 form 视图", async () => {
    mockListActions.mockResolvedValue({
      actions: [
        {
          id: "a1",
          title: "A",
          icon: "▶",
          description: "",
          params: [
            { id: "NAME", label: "名", type: "text", required: false, default: "d", options: [] },
          ],
          presets: [{ name: "p1", values: { NAME: "pre" } }],
        },
      ],
      errors: [],
    });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    act(() => result.current.selectPreset("a1", "p1"));
    expect(result.current.formValues.NAME).toBe("pre");
    expect(result.current.view).toBe("form");
    expect(result.current.selectedPreset).toBe("p1");
  });

  it("saveGlobalConfig 调用 SetGlobalConfig", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.saveGlobalConfig({ OUTPUT_DIR: "D:/new" });
    });
    expect(mockSetGlobalConfig).toHaveBeenCalledWith({ OUTPUT_DIR: "D:/new" });
  });

  it("stream=llm 的 output 事件累加到 llmText 并切 view=llm", async () => {
    mockListActions.mockResolvedValue({
      actions: [
        {
          id: "a1", title: "A", icon: "▶", description: "", params: [], presets: [],
          stream: "llm",
        },
      ],
      errors: [],
    });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAction("a1", {});
    });
    expect(result.current.view).toBe("llm");
    act(() => {
      _emitForTest("action:a1:output", { data: { stream: "llm", line: "你好" } });
      _emitForTest("action:a1:output", { data: { stream: "llm", line: "世界" } });
    });
    expect(result.current.llmText).toBe("你好世界");
    // 普通 stream 不进 llmText
    act(() => {
      _emitForTest("action:a1:output", { data: { stream: "stdout", line: "x" } });
    });
    expect(result.current.llmText).toBe("你好世界");
  });

  it("stream=llm-thinking 的 output 事件累加到 thinkingText", async () => {
    mockListActions.mockResolvedValue({
      actions: [
        {
          id: "a1", title: "A", icon: "▶", description: "", params: [], presets: [],
          stream: "llm",
        },
      ],
      errors: [],
    });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAction("a1", {});
    });
    act(() => {
      _emitForTest("action:a1:output", { data: { stream: "llm-thinking", line: "思考" } });
      _emitForTest("action:a1:output", { data: { stream: "llm-thinking", line: "过程" } });
    });
    expect(result.current.thinkingText).toBe("思考过程");
    // llm-thinking 不进 llmText
    expect(result.current.llmText).toBe("");
  });

  it("selectPreset 重置上次运行的 status/exitInfo（打开配置面板不残留失败徽标）", async () => {
    mockListActions.mockResolvedValue({
      actions: [
        {
          id: "a1", title: "A", icon: "▶", description: "",
          params: [{ id: "NAME", label: "名", type: "text", required: false, default: "", options: [] }],
          presets: [],
        },
      ],
      errors: [],
    });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    // 运行 a1 失败（如 adb 未找到）
    await act(async () => {
      await result.current.runAction("a1", {});
    });
    act(() => {
      _emitForTest("action:a1:done", { data: { exitCode: 2, err: "boom", duration: "1s" } });
    });
    expect(result.current.status).toBe("error");
    // 单击 a1（有 params 无 presets）→ selectPreset 进表单
    act(() => result.current.selectPreset("a1", ""));
    // 进配置面板后不应残留上次的失败状态
    expect(result.current.status).toBe("idle");
    expect(result.current.exitInfo).toBeNull();
    expect(result.current.view).toBe("form");
  });
});
