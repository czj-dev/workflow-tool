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
  mockPickFile,
  mockGetActionYaml,
  mockSetActionYaml,
  mockListWorkflows,
  mockRunWorkflow,
  mockCancelWorkflow,
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
      mockPickFile: vi.fn(),
      mockGetActionYaml: vi.fn(),
      mockSetActionYaml: vi.fn(),
      mockListWorkflows: vi.fn(),
      mockRunWorkflow: vi.fn(() => Promise.resolve()),
      mockCancelWorkflow: vi.fn(),
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
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: vi.fn().mockResolvedValue(undefined),
  PickDirectory: mockPickDirectory,
  PickFile: mockPickFile,
  GetActionYaml: mockGetActionYaml,
  SetActionYaml: mockSetActionYaml,
  ListWorkflows: mockListWorkflows,
  RunWorkflow: mockRunWorkflow,
  CancelWorkflow: mockCancelWorkflow,
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
  mockPickFile.mockReset().mockResolvedValue("");
  mockGetActionYaml.mockReset();
  mockSetActionYaml.mockReset();
  mockListWorkflows.mockReset().mockResolvedValue({ workflows: [], errors: [] });
  mockRunWorkflow.mockReset().mockResolvedValue(undefined);
  mockCancelWorkflow.mockReset();
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

  it("pickFile 转发后端 PickFile 并返回其值", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockPickFile.mockResolvedValue("/tmp/app.apk");
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    let picked = "";
    await act(async () => {
      picked = await result.current.pickFile();
    });
    expect(mockPickFile).toHaveBeenCalled();
    expect(picked).toBe("/tmp/app.apk");
  });

  it("llm 形态的 output 事件累加到 llmText 并切 view=llm-chat", async () => {
    mockListActions.mockResolvedValue({
      actions: [
        {
          id: "a1", title: "A", icon: "▶", description: "", params: [], presets: [],
          stream: "", llm: { systemParam: "", promptParam: "Q" },
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
    expect(result.current.view).toBe("llm-chat");
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
          stream: "", llm: { systemParam: "", promptParam: "Q" },
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

  it("saveActionYaml 写回并刷新 actions", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockSetActionYaml.mockResolvedValue({
      actions: [
        { id: "a", title: "新名", icon: "", description: "", params: [], presets: [], stream: "" },
      ],
      errors: [],
    });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.saveActionYaml("a", "id: a\ntitle: 新名\n");
    });
    expect(mockSetActionYaml).toHaveBeenCalledWith("a", "id: a\ntitle: 新名\n");
    expect(result.current.actions).toHaveLength(1);
    expect(result.current.actions[0].title).toBe("新名");
  });

  it("切走再回来仍显示运行中（isRunning 按 id 记录，不随 currentId 切换丢失）", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    // 启动长跑动作 scrcpy
    await act(async () => {
      await result.current.runAction("adb-scrcpy", {});
    });
    expect(result.current.isRunning("adb-scrcpy")).toBe(true);
    // 切去跑另一个动作并让它结束
    await act(async () => {
      await result.current.runAction("other", {});
    });
    act(() => {
      _emitForTest("action:other:done", { data: { exitCode: 0, err: "", duration: "1s" } });
    });
    // scrcpy 未 done，仍应是运行中；currentId 已是 other
    expect(result.current.isRunning("adb-scrcpy")).toBe(true);
    expect(result.current.isRunning("other")).toBe(false);
    // 点回 scrcpy → status 恢复 running
    act(() => result.current.focusRunning("adb-scrcpy", "output"));
    expect(result.current.currentId).toBe("adb-scrcpy");
    expect(result.current.status).toBe("running");
    expect(result.current.exitInfo).toBeNull();
    // scrcpy 结束后 isRunning 转 false
    act(() => {
      _emitForTest("action:adb-scrcpy:done", { data: { exitCode: 0, err: "", duration: "9s" } });
    });
    expect(result.current.isRunning("adb-scrcpy")).toBe(false);
  });

  // 回归：抓取日志（adb-logcat）这类长跑动作已运行时，再点它发 RunAction，
  // 后端会拒「动作正在运行」。前端不应打成 error / 写「启动失败」，而应保留运行态，
  // 使用户回到输出界面且停止按钮可用。
  it("RunAction 后端报「正在运行」时保留运行态（不写启动失败、不掉运行徽标）", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockRunAction.mockReset().mockRejectedValue(new Error('动作 "adb-logcat" 正在运行'));
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAction("adb-logcat", {});
    });
    // 保留运行态：停止按钮据此启用
    expect(result.current.status).toBe("running");
    expect(result.current.isRunning("adb-logcat")).toBe(true);
    expect(result.current.view).toBe("output");
    // 不写「启动失败」
    expect(result.current.lines).toEqual([]);
  });

  it("挂载时拉取 workflow 列表", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockListWorkflows.mockResolvedValue({
      workflows: [{ id: "w1", title: "W1", icon: "", description: "", stepCount: 2 }],
      errors: ["bad.yaml"],
    });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    expect(result.current.workflows).toHaveLength(1);
    expect(result.current.workflows[0].id).toBe("w1");
    expect(result.current.workflowErrors).toEqual(["bad.yaml"]);
  });

  it("runWorkflow 后 view=workflow、status=running 并订阅 workflow 事件", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runWorkflow("w1");
    });
    expect(result.current.view).toBe("workflow");
    expect(result.current.status).toBe("running");
    expect(result.current.currentId).toBe("w1");
    expect(mockRunWorkflow).toHaveBeenCalledWith("w1", {});
    expect(mockOn).toHaveBeenCalledWith("workflow:w1:output", expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith("workflow:w1:done", expect.any(Function));
  });

  it("step-start/stdout/step-done 协议帧驱动 workflowSteps", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runWorkflow("w1");
    });
    act(() => {
      _emitForTest("workflow:w1:output", { data: { stream: "step-start", line: "0" } });
      _emitForTest("workflow:w1:output", { data: { stream: "stdout", line: "hi" } });
      _emitForTest("workflow:w1:output", { data: { stream: "stderr", line: "boom" } });
      _emitForTest("workflow:w1:output", { data: { stream: "step-done", line: "0:0" } });
      _emitForTest("workflow:w1:output", { data: { stream: "step-start", line: "1" } });
      _emitForTest("workflow:w1:output", { data: { stream: "stdout", line: "second" } });
      _emitForTest("workflow:w1:output", { data: { stream: "step-done", line: "1:1" } });
    });
    expect(result.current.workflowSteps).toEqual([
      { index: 0, status: "done", exitCode: 0, lines: ["hi", "[stderr] boom"] },
      { index: 1, status: "error", exitCode: 1, lines: ["second"] },
    ]);
  });

  it("workflow done 事件置 status 与 exitInfo", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runWorkflow("w1");
    });
    act(() => {
      _emitForTest("workflow:w1:done", {
        data: { exitCode: 1, err: "step 1 failed", duration: "2s" },
      });
    });
    expect(result.current.status).toBe("error");
    expect(result.current.exitInfo?.err).toBe("step 1 failed");
  });

  it("cancelWorkflow 调用 CancelWorkflow", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runWorkflow("w1");
    });
    act(() => result.current.cancelWorkflow());
    expect(mockCancelWorkflow).toHaveBeenCalledWith("w1");
  });

  it("rerun 用上次的 params 原样重跑 action", async () => {
    mockListActions.mockResolvedValue({
      actions: [{ id: "a1", title: "A1", params: [{ id: "P", label: "P" }] }],
      errors: [],
    });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAction("a1", { P: "v1" });
    });
    mockRunAction.mockClear();
    act(() => result.current.rerun("a1"));
    await act(() => Promise.resolve());
    expect(mockRunAction).toHaveBeenCalledWith("a1", { P: "v1" });
  });

  it("rerun 对 workflow 分派到 RunWorkflow", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockListWorkflows.mockResolvedValue({
      workflows: [{ id: "w1", title: "W1" }],
      errors: [],
    });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runWorkflow("w1", { X: "1" });
    });
    mockRunWorkflow.mockClear();
    act(() => result.current.rerun("w1"));
    await act(() => Promise.resolve());
    expect(mockRunWorkflow).toHaveBeenCalledWith("w1", { X: "1" });
    expect(mockRunAction).not.toHaveBeenCalled();
  });

  it("editRerun 用上次 params 预填表单并切 form 视图（不立即执行）", async () => {
    mockListActions.mockResolvedValue({
      actions: [
        { id: "a1", title: "A1", params: [{ id: "P", label: "P", default: "d" }] },
      ],
      errors: [],
    });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAction("a1", { P: "used" });
    });
    mockRunAction.mockClear();
    act(() => result.current.editRerun("a1"));
    expect(result.current.view).toBe("form");
    expect(result.current.formValues.P).toBe("used"); // 上次值优先于 default
    expect(result.current.status).toBe("idle");
    expect(mockRunAction).not.toHaveBeenCalled();
  });

  it("未跑过的 id 不进 lastRunParams（再跑入口据此隐藏）", async () => {
    mockListActions.mockResolvedValue({
      actions: [{ id: "a1", title: "A1" }, { id: "a2", title: "A2" }],
      errors: [],
    });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAction("a1");
    });
    expect("a1" in result.current.lastRunParams).toBe(true);
    expect("a2" in result.current.lastRunParams).toBe(false);
  });
});
