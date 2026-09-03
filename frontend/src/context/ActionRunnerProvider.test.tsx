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
  mockUpdateLogcatFilter,
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
      mockUpdateLogcatFilter: vi.fn(() => Promise.resolve()),
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
  UpdateLogcatFilter: mockUpdateLogcatFilter,
}));

vi.mock("@wailsio/runtime", () => ({
  Events: { On: mockOn },
}));

import { ActionRunnerProvider, _emitForTest } from "./ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import type { LogcatEntry } from "../types/events";

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
  mockUpdateLogcatFilter.mockReset().mockResolvedValue(undefined);
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

  it("selectPreset 填充 formValues 并打开表单抽屉（视图不动）", async () => {
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
    expect(result.current.formSheetOpen).toBe(true);
    expect(result.current.view).toBe("output"); // 主区视图原地不动
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
    expect(result.current.formSheetOpen).toBe(true);
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

  // logcat 规则带入：runAction 前台路径把 LEVEL/TAG/INCLUDE 映射进统一规则（ruleFromParams）；
  // focusRunning 回到运行中的 logcat 动作时用 lastRunParams 恢复当初的规则
  // （logcatRule 是全局单份，期间跑其他 logcat 动作会被覆盖），并触发一次后端整体重放。
  it("runAction 把 logcat 参数映射进面板规则；focusRunning 恢复被覆盖的规则并请求重放", async () => {
    mockListActions.mockResolvedValue({
      actions: [
        { id: "a1", title: "A", icon: "", description: "", params: [], presets: [], stream: "logcat" },
        { id: "a2", title: "B", icon: "", description: "", params: [], presets: [], stream: "logcat" },
      ],
      errors: [],
    });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAction("a1", { LEVEL: "W", TAG: "Foo Bar", INCLUDE: "zz" });
    });
    expect(result.current.view).toBe("logcat");
    expect(result.current.logcatRule).toEqual({
      minLevel: "W",
      package: "",
      tokens: [
        { key: "tag", op: "contains", negated: false, value: "Foo" },
        { key: "tag", op: "contains", negated: false, value: "Bar" },
        { key: "message", op: "contains", negated: false, value: "zz" },
      ],
    });
    // runAction 映射的初始规则不防抖下发（后端已从同一 params 编译）
    expect(mockUpdateLogcatFilter).not.toHaveBeenCalled();
    // 期间跑另一个 logcat 动作 → 全局规则被覆盖
    await act(async () => {
      await result.current.runAction("a2", { LEVEL: "E" });
    });
    expect(result.current.logcatRule.minLevel).toBe("E");
    // 回到 a1 的面板 → 用 a1 当初的运行参数恢复规则，并触发一次后端重放找回单缓冲
    act(() => result.current.focusRunning("a1", "logcat"));
    expect(result.current.logcatRule.minLevel).toBe("W");
    expect(mockUpdateLogcatFilter).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({ minLevel: "W" }),
      false,
    );
  });

  // 重放帧：head 首帧整体替换 + 读数/直方图/脉冲 seq；后续 chunk 仅追加。
  it("logcat-replace 首帧整体替换并读取数/直方图，后续 chunk 追加", async () => {
    mockListActions.mockResolvedValue({
      actions: [
        { id: "a1", title: "A", icon: "", description: "", params: [], presets: [], stream: "logcat" },
      ],
      errors: [],
    });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAction("a1", {});
    });
    const ent = (tag: string): LogcatEntry => ({
      date: "08-18", time: "09:00:00.000", pid: 1, tid: 1, level: "I", tag, message: "m",
    });
    act(() => {
      _emitForTest("action:a1:output", {
        data: {
          stream: "logcat-replace",
          line: JSON.stringify({
            head: true,
            entries: [ent("A"), ent("B")],
            matched: 2,
            total: 5,
            tagHistogram: { B: 1, A: 2 },
          }),
        },
      });
      _emitForTest("action:a1:output", {
        data: {
          stream: "logcat-replace",
          line: JSON.stringify({ head: false, entries: [ent("C")] }),
        },
      });
    });
    expect(result.current.logcatEntries.map((e) => e.tag)).toEqual(["A", "B", "C"]);
    expect(result.current.logcatStats).toEqual({ matched: 2, total: 5 });
    // 直方图按频次降序、并列字典序（与后端 topTags 同规则）
    expect(result.current.logcatTagHist).toEqual([["A", 2], ["B", 1]]);
    expect(result.current.logcatReplaceSeq).toBe(1);
  });

  // 防抖下发：规则编辑后 300ms 才调 UpdateLogcatFilter，且剥离 draft 标记。
  it("规则编辑 300ms 防抖下发 UpdateLogcatFilter（draft 剥离，运行中才发）", async () => {
    vi.useFakeTimers();
    try {
      mockListActions.mockResolvedValue({
        actions: [
          { id: "a1", title: "A", icon: "", description: "", params: [], presets: [], stream: "logcat" },
        ],
        errors: [],
      });
      const { result } = renderHook(() => useActionRunner(), { wrapper });
      await act(() => Promise.resolve());
      await act(async () => {
        await result.current.runAction("a1", {});
      });
      // 初始规则（params 映射）不触发下发
      expect(mockUpdateLogcatFilter).not.toHaveBeenCalled();
      // 用户编辑：末尾草稿 token
      act(() => {
        result.current.setLogcatRule({
          tokens: [{ key: "tag", op: "contains", negated: false, value: "x", draft: true }],
          minLevel: "D",
          package: "",
        });
      });
      expect(mockUpdateLogcatFilter).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(299);
      });
      expect(mockUpdateLogcatFilter).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(mockUpdateLogcatFilter).toHaveBeenCalledTimes(1);
      expect(mockUpdateLogcatFilter).toHaveBeenCalledWith(
        "a1",
        { tokens: [{ key: "tag", op: "contains", negated: false, value: "x", link: "" }], minLevel: "D", package: "" },
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // 回归：后端拒绝非法规则时必须暴露原因。原先 .catch 静默吞掉、logcat 视图又不
  // 渲染 stderr，表现为 chip 在、过滤停在旧规则、零反馈（pid:abc、Go RE2 不支持
  // 的正则如 (?=x)、手写 FILTER 的未知 key 都走这一条出口）。
  it("UpdateLogcatFilter 被拒时暴露 logcatFilterError，下一次成功下发后清空", async () => {
    vi.useFakeTimers();
    try {
      mockListActions.mockResolvedValue({
        actions: [
          { id: "a1", title: "A", icon: "", description: "", params: [], presets: [], stream: "logcat" },
        ],
        errors: [],
      });
      mockUpdateLogcatFilter.mockRejectedValueOnce(
        new Error('非法过滤规则: token[0]: pid value must be an integer, got "abc"'),
      );
      const { result } = renderHook(() => useActionRunner(), { wrapper });
      await act(() => Promise.resolve());
      await act(async () => {
        await result.current.runAction("a1", {});
      });
      expect(result.current.logcatFilterError).toBe("");

      act(() => {
        result.current.setLogcatRule({
          tokens: [{ key: "pid", op: "exact", negated: false, value: "abc" }],
          minLevel: "V",
          package: "",
        });
      });
      // advanceTimersByTimeAsync：既要跑掉 300ms 防抖，也要让被拒的 promise 落地
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(result.current.logcatFilterError).toContain("must be an integer");

      act(() => {
        result.current.setLogcatRule({
          tokens: [{ key: "pid", op: "exact", negated: false, value: "1234" }],
          minLevel: "V",
          package: "",
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(result.current.logcatFilterError).toBe("");
    } finally {
      vi.useRealTimers();
    }
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
      { index: 0, status: "done", exitCode: 0, lines: ["hi", "[stderr] boom"], lastWasProgress: false, startedAt: expect.any(Number), endedAt: expect.any(Number) },
      { index: 1, status: "error", exitCode: 1, lines: ["second"], lastWasProgress: false, startedAt: expect.any(Number), endedAt: expect.any(Number) },
    ]);
  });

  it("progress 带 step 字段时按索引落桶（乱序到达也不串到下一个 step）", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runWorkflow("w1");
    });
    act(() => {
      _emitForTest("workflow:w1:output", { data: { stream: "step-start", line: "0", step: "0" } });
      _emitForTest("workflow:w1:output", { data: { stream: "progress", line: "push a: 50%", step: "0" } });
      // step 0 的 100% 被 Wails 乱序投递，晚于 step-done + 下一个 step-start 才到
      _emitForTest("workflow:w1:output", { data: { stream: "step-done", line: "0:0", step: "0" } });
      _emitForTest("workflow:w1:output", { data: { stream: "step-start", line: "1", step: "1" } });
      _emitForTest("workflow:w1:output", { data: { stream: "progress", line: "push a: 100%", step: "0" } });
      _emitForTest("workflow:w1:output", { data: { stream: "stdout", line: "chmod ok", step: "1" } });
    });
    expect(result.current.workflowSteps).toEqual([
      { index: 0, status: "done", exitCode: 0, lines: ["push a: 100%"], lastWasProgress: true, startedAt: expect.any(Number), endedAt: expect.any(Number) },
      { index: 1, status: "running", lines: ["chmod ok"], lastWasProgress: false, startedAt: expect.any(Number) },
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

  it("editRerun 用上次 params 预填表单并打开抽屉（不立即执行）", async () => {
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
    expect(result.current.formSheetOpen).toBe(true);
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

// 落点判定与取值规则本身在 lib/filedrop.test.ts 里全覆盖，这里只验接线：
// Provider 确实订阅了 file:dropped，并把 payload 交给了那套规则。
describe("窗口文件拖拽接线", () => {
  beforeEach(() => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
  });

  it("按松手坐标写入目标输入框并聚焦", async () => {
    document.body.innerHTML = `<div data-slot="field"><label id="lbl">路径</label><input id="t" /></div>`;
    const input = document.getElementById("t") as HTMLInputElement;
    // 命中标签而非控件：验证 Field 兜底这条路真的接上了
    document.elementFromPoint = (() =>
      document.getElementById("lbl")) as typeof document.elementFromPoint;

    renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());

    act(() => {
      listeners["file:dropped"]({
        data: { paths: ["/a/x.txt", "/b/My Docs/y.txt"], x: 1, y: 1 },
      });
    });

    expect(input.value).toBe('/a/x.txt "/b/My Docs/y.txt"');
    expect(document.activeElement).toBe(input);

    Reflect.deleteProperty(document, "elementFromPoint");
    document.body.innerHTML = "";
  });

  it("缺坐标时不写入（Wails 未给落点信息则整次拖拽忽略）", async () => {
    document.body.innerHTML = `<input id="t" value="原值" />`;
    const input = document.getElementById("t") as HTMLInputElement;
    document.elementFromPoint = (() => input) as typeof document.elementFromPoint;

    renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());

    act(() => {
      listeners["file:dropped"]({ data: { paths: ["/a/x.txt"] } });
    });

    expect(input.value).toBe("原值");

    Reflect.deleteProperty(document, "elementFromPoint");
    document.body.innerHTML = "";
  });
});

// 计数收敛到 runAction / runWorkflow 单点后由形态自动分桶：UI 调用点不再各记一次，
// 漏接一个入口就静默失真的问题（llm 桶零写者、ParamSheet action 分支漏记）不再可能。
describe("使用频次分桶", () => {
  const readBucket = (key: string): Record<string, number> =>
    JSON.parse(localStorage.getItem(key) ?? "{}");

  beforeEach(() => {
    localStorage.clear();
    mockListActions.mockResolvedValue({
      actions: [
        {
          id: "ai-chat",
          title: "AI",
          icon: "",
          description: "",
          llm: { promptParam: "TASK" },
        },
        { id: "adb-devices", title: "Devices", icon: "", description: "" },
      ],
      errors: [],
    });
    mockListWorkflows.mockResolvedValue({
      workflows: [{ id: "w1", title: "W1" }],
      errors: [],
    });
  });

  it("运行 llm 动作只记入 llm-usage", async () => {
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());

    await act(() => result.current.runAction("ai-chat", { TASK: "hi" }));

    expect(readBucket("llm-usage")["ai-chat"]).toBeGreaterThan(0);
    expect(readBucket("action-usage")).toEqual({});
    expect(readBucket("workflow-usage")).toEqual({});
  });

  it("运行 shell 动作只记入 action-usage", async () => {
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());

    await act(() => result.current.runAction("adb-devices", {}));

    expect(readBucket("action-usage")["adb-devices"]).toBeGreaterThan(0);
    expect(readBucket("llm-usage")).toEqual({});
  });

  it("运行 workflow 只记入 workflow-usage", async () => {
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());

    await act(() => result.current.runWorkflow("w1"));

    expect(readBucket("workflow-usage")["w1"]).toBeGreaterThan(0);
    expect(readBucket("action-usage")).toEqual({});
  });

  it("background 运行同样计数（grid 卡片静默跑也算一次使用）", async () => {
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());

    await act(() => result.current.runAction("adb-devices", {}, true));

    expect(readBucket("action-usage")["adb-devices"]).toBeGreaterThan(0);
  });

  it("同一 llm 动作每次发送都累加（一次会话 N 条消息 = N 次使用）", async () => {
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());

    await act(() => result.current.runAction("ai-chat", { TASK: "1" }));
    const first = readBucket("llm-usage")["ai-chat"];
    await act(() => result.current.runAction("ai-chat", { TASK: "2" }));

    expect(readBucket("llm-usage")["ai-chat"]).toBeGreaterThan(first);
  });

  it("分数经 context 暴露，同一 Provider 下所有读者取到同一份", async () => {
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());

    await act(() => result.current.runAction("adb-devices", {}));

    expect(
      result.current.usage["action-usage"]["adb-devices"],
    ).toBeGreaterThan(0);
  });
});
