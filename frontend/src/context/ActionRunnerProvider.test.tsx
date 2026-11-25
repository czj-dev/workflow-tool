import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";

// mock bindings 与 runtime：用 vi.hoisted 保证提升后变量可用，工厂直接引用（无需转发 spread）
const {
  mockListActions,
  mockListAiTasks,
  mockRunAction,
  mockRunAi,
  mockCancelAction,
  mockCancelAi,
  mockGetAiYaml,
  mockSetAiYaml,
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
  mockListSchedules,
  mockSaveSchedule,
  mockDeleteSchedule,
  mockSetScheduleEnabled,
  mockRunScheduleNow,
  mockListRuns,
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
      mockListAiTasks: vi.fn(),
      mockRunAction: vi.fn(() => Promise.resolve()),
      mockRunAi: vi.fn(() => Promise.resolve()),
      mockListRuns: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ runs: [] })),
      mockCancelAction: vi.fn(),
      mockCancelAi: vi.fn(),
      mockGetAiYaml: vi.fn(),
      mockSetAiYaml: vi.fn(),
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
      mockListSchedules: vi.fn(),
      mockSaveSchedule: vi.fn(),
      mockDeleteSchedule: vi.fn(),
      mockSetScheduleEnabled: vi.fn(),
      mockRunScheduleNow: vi.fn(() => Promise.resolve()),
      mockOn,
      listeners,
    };
  });

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: mockListActions,
  ListAiTasks: mockListAiTasks,
  RunAction: mockRunAction,
  RunAi: mockRunAi,
  ListRuns: mockListRuns,
  GetRun: vi.fn(),
  GetRunEvents: vi.fn(),
  CancelAction: mockCancelAction,
  CancelAi: mockCancelAi,
  GetAiYaml: mockGetAiYaml,
  SetAiYaml: mockSetAiYaml,
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
  ListSchedules: mockListSchedules,
  SaveSchedule: mockSaveSchedule,
  DeleteSchedule: mockDeleteSchedule,
  SetScheduleEnabled: mockSetScheduleEnabled,
  RunScheduleNow: mockRunScheduleNow,
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

// AI 任务夹具：prompt 模板引用已声明参数 TOPIC（必填、带默认值），定义了 system
const aiTask = (id = "t1", extra: Record<string, unknown> = {}) => ({
  id,
  title: "AI",
  icon: "",
  description: "",
  params: [
    { id: "TOPIC", label: "主题", type: "text", required: true, default: "季度报告", options: [] },
  ],
  presets: [],
  prompt: "解释 ${TOPIC}",
  system: "你是助手",
  ...extra,
});

// 挂载并等 AI 任务 / workflow 列表解析完（两轮微任务）
const mountAi = async () => {
  const hook = renderHook(() => useActionRunner(), { wrapper });
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  return hook;
};

beforeEach(() => {
  Object.keys(listeners).forEach((k) => delete listeners[k]);
  mockListActions.mockReset();
  mockListAiTasks.mockReset().mockResolvedValue({ tasks: [], errors: [] });
  mockRunAction.mockReset().mockResolvedValue(undefined);
  mockRunAi.mockReset().mockResolvedValue(undefined);
  mockCancelAi.mockReset();
  mockGetAiYaml.mockReset();
  mockSetAiYaml.mockReset();
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
  mockListSchedules.mockReset().mockResolvedValue({ schedules: [], errors: [] });
  mockSaveSchedule.mockReset().mockResolvedValue({ schedules: [], errors: [] });
  mockDeleteSchedule.mockReset().mockResolvedValue({ schedules: [], errors: [] });
  mockSetScheduleEnabled.mockReset().mockResolvedValue({ schedules: [], errors: [] });
  mockRunScheduleNow.mockReset().mockResolvedValue(undefined);
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
    expect(result.current.lines).toEqual([
      { kind: "text", text: "[stderr] boom" },
      { kind: "text", text: "hi" },
    ]);
  });

  // ##[tree] 协议行：stream=tree 解析为树帧行项入桶，不落文本行
  it("声明 hmi.tree 后 tree 流追加树帧行项（id 从 0 递增）", async () => {
    mockListActions.mockResolvedValue({ actions: [{ id: "a1", hmi: { tree: {} } }], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAction("a1");
    });
    act(() => {
      _emitForTest("action:a1:output", {
        data: {
          stream: "tree",
          line: JSON.stringify({ title: "T", nodes: [{ label: "n", kind: "dir" }], source: { actionId: "a1", params: {}, protocol: "script" } }),
        },
      });
      _emitForTest("action:a1:output", {
        data: {
          stream: "tree",
          line: JSON.stringify({ nodes: [{ label: "m" }], source: { actionId: "a1", params: {}, protocol: "script" } }),
        },
      });
    });
    const trees = result.current.lines.filter((it) => it.kind === "tree");
    expect(trees).toHaveLength(2);
    expect(trees[0]).toMatchObject({ kind: "tree", id: 0 });
    expect(trees[1]).toMatchObject({ kind: "tree", id: 1 });
  });

  it("未声明 hmi.tree 的 tree 流作为普通文本显示", async () => {
    mockListActions.mockResolvedValue({ actions: [{ id: "a1" }], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => { await result.current.runAction("a1"); });
    const frame = JSON.stringify({ nodes: [{ label: "n" }], source: { actionId: "a1", params: {}, protocol: "script" } });
    act(() => { _emitForTest("action:a1:output", { data: { stream: "tree", line: frame } }); });
    expect(result.current.lines).toEqual([{ kind: "text", text: `##[tree ${frame}]` }]);
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

  it("可选数组无默认值时直跑 action 和 workflow 保留全局配置", async () => {
    mockGetGlobalConfig.mockResolvedValue({ TAG: '["Foo"]' });
    mockListActions.mockResolvedValue({ actions: [{ id: "a1", params: [{ id: "TAG", type: "list", default: "" }] }], errors: [] });
    mockListWorkflows.mockResolvedValue({ workflows: [{ id: "w1", params: [{ id: "TAG", type: "list", default: "" }] }], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    await act(async () => { await result.current.runAction("a1", {}, true); });
    await act(async () => { await result.current.runWorkflow("w1", {}, true); });
    expect(mockRunAction).toHaveBeenCalledWith("a1", { TAG: '["Foo"]' });
    expect(mockRunWorkflow).toHaveBeenCalledWith("w1", { TAG: '["Foo"]' });
  });

  it("required 数组为空时直接运行与 workflow 均打开表单且不发 RPC", async () => {
    mockListActions.mockResolvedValue({ actions: [{ id: "a1", params: [{ id: "FILES", type: "list", required: true, default: "[]" }] }], errors: [] });
    mockListWorkflows.mockResolvedValue({ workflows: [{ id: "w1", params: [{ id: "ARGS", type: "arguments", required: true, default: "[]" }] }], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => { await result.current.runAction("a1", {}, true); });
    expect(result.current.formSheetOpen).toBe(true);
    expect(mockRunAction).not.toHaveBeenCalled();
    await act(async () => { await result.current.runWorkflow("w1", { ARGS: "[]" }, true); });
    expect(result.current.formSheetOpen).toBe(true);
    expect(mockRunWorkflow).not.toHaveBeenCalled();
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

  it("runAi 后 status=running、切 ai-chat，并同步订阅该任务的 ai 事件", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockListAiTasks.mockResolvedValue({ tasks: [aiTask()], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAi("t1");
    });
    expect(result.current.status).toBe("running");
    expect(result.current.view).toBe("ai-chat");
    expect(result.current.currentId).toBe("t1");
    expect(result.current.isAiRunning("t1")).toBe(true);
    // prompt/system 恒传；没改过的已声明参数不传（后端取定义默认值并展开其中的模板）
    expect(mockRunAi).toHaveBeenCalledWith("t1", { prompt: "解释 ${TOPIC}", system: "你是助手" });
    expect(mockOn).toHaveBeenCalledWith("ai:t1:output", expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith("ai:t1:done", expect.any(Function));
  });

  it("ai 流累加到 aiText，ai-thinking 累加到 thinkingText", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockListAiTasks.mockResolvedValue({ tasks: [aiTask()], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAi("t1");
    });
    act(() => {
      _emitForTest("ai:t1:output", { data: { stream: "ai", line: "你好", seq: 1 } });
      _emitForTest("ai:t1:output", { data: { stream: "ai", line: "世界", seq: 2 } });
    });
    expect(result.current.aiText).toBe("你好世界");
    act(() => {
      _emitForTest("ai:t1:output", { data: { stream: "ai-thinking", line: "思考", seq: 3 } });
      _emitForTest("ai:t1:output", { data: { stream: "ai-thinking", line: "过程", seq: 4 } });
    });
    expect(result.current.thinkingText).toBe("思考过程");
    // 思考流不进回复正文
    expect(result.current.aiText).toBe("你好世界");
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
      await result.current.runAction("a1", { LEVEL: "W", TAG: '["Foo","Bar"]', INCLUDE: "zz" });
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

  // 回归：focusRunning 切到另一个 logcat 动作时必须**同步**清掉上一个动作的拒绝原因。
  // 否则前一个动作的错误会挂在新动作的过滤条上，直到 focusRunning 里那次
  // UpdateLogcatFilter 往返落地才消失（不落地则长期错误归属）。
  it("focusRunning 切换 logcat 动作时同步清空 logcatFilterError", async () => {
    vi.useFakeTimers();
    try {
      mockListActions.mockResolvedValue({
        actions: [
          { id: "a1", title: "A", icon: "", description: "", params: [], presets: [], stream: "logcat" },
          { id: "a2", title: "B", icon: "", description: "", params: [], presets: [], stream: "logcat" },
        ],
        errors: [],
      });
      const { result } = renderHook(() => useActionRunner(), { wrapper });
      await act(() => Promise.resolve());
      // 两个 logcat 动作都在运行：focusRunning 才是「切回后台运行动作」的场景
      await act(async () => {
        await result.current.runAction("a1", { LEVEL: "W" });
      });
      await act(async () => {
        await result.current.runAction("a2", { LEVEL: "E" });
      });

      // a2 的规则下发被后端拒绝 → logcatFilterError 记下原因（挂在 a2 名下）
      mockUpdateLogcatFilter.mockRejectedValueOnce(
        new Error('非法过滤规则: token[0]: pid value must be an integer, got "abc"'),
      );
      act(() => {
        result.current.setLogcatRule({
          tokens: [{ key: "pid", op: "exact", negated: false, value: "abc" }],
          minLevel: "E",
          package: "",
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(result.current.logcatFilterError).toContain("must be an integer");

      // focusRunning 里那次重放请求永不落地：清空只能来自同步的那一行
      mockUpdateLogcatFilter.mockReturnValueOnce(new Promise<void>(() => {}));
      act(() => result.current.focusRunning("a1", "logcat"));
      // 不 await、不推进定时器：断言清空是同步发生的，不依赖 IPC 往返
      expect(result.current.logcatFilterError).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  // 回归（Critical）：focusRunning 无条件重置两套 seq 队列。run 中途后端序号已到几千，
  // 把 nextSeq 打回 1 会让此后所有事件永久挂 pending 且无自愈路径——面板永远停在空、
  // 状态却仍显示「运行中」。修法是重置成哨兵 0，「以首个到达的 seq 为基线」重新对齐。
  it("focusRunning 切回运行中的动作后帧门以首帧重同步（大 seq 事件仍能渲染）", async () => {
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
    const headFrame = (tag: string) =>
      JSON.stringify({ head: true, entries: [ent(tag)], matched: 1, total: 1, tagHistogram: { [tag]: 1 } });
    // run 已跑一段时间：序号从 1 起递增（这里只喂前两个号，其余同理已被消费）
    act(() => {
      _emitForTest("action:a1:output", { data: { stream: "logcat-replace", line: headFrame("A"), seq: 1 } });
      _emitForTest("action:a1:output", { data: { stream: "stdout", line: "x", seq: 2 } });
    });
    expect(result.current.logcatEntries.map((e) => e.tag)).toEqual(["A"]);

    // 点左上返回箭头回 grid、再点回同一张卡：走 focusRunning → 两套队列被重置
    act(() => result.current.setView("actions-grid"));
    act(() => result.current.focusRunning("a1", "logcat"));
    expect(result.current.logcatEntries).toEqual([]); // focusRunning 清缓冲，等后端重放

    // 后端序号早已走远（这里 100），修前它会永久挂 pending → entries 停在空
    act(() => {
      _emitForTest("action:a1:output", { data: { stream: "logcat-replace", line: headFrame("R"), seq: 100 } });
    });
    expect(result.current.logcatEntries.map((e) => e.tag)).toEqual(["R"]);
    // 基线对齐后继续逐号推进
    act(() => {
      _emitForTest("action:a1:output", {
        data: { stream: "logcat-replace", line: JSON.stringify({ head: false, entries: [ent("S")] }), seq: 101 },
      });
    });
    expect(result.current.logcatEntries.map((e) => e.tag)).toEqual(["R", "S"]);
  });

  // 回归（Important）：done 事件独占一个 seq（events.go 的 Done 用 nextSeq 取号），
  // 帧门那侧没有对应事件可出队 → output 号段有个永久空洞，done 之后到达的 emit
  // 全部卡死。修法是 onDone 把该号登记为已消耗（consumed）再 drain。
  it("done 独占的 seq 被跨过：done 之后到达的迟到帧仍能渲染", async () => {
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
      _emitForTest("action:a1:output", { data: { stream: "stdout", line: "x", seq: 1 } });
    });
    act(() => {
      _emitForTest("action:a1:done", { data: { exitCode: 0, err: "", duration: "1s", seq: 2 } });
    });
    // logcat-stream 的控制协程 / pidRefresher 未被 join：Run 返回后仍可能 emit
    act(() => {
      _emitForTest("action:a1:output", {
        data: {
          stream: "logcat-replace",
          line: JSON.stringify({ head: true, entries: [ent("L")], matched: 1, total: 1, tagHistogram: { L: 1 } }),
          seq: 3,
        },
      });
    });
    expect(result.current.logcatEntries.map((e) => e.tag)).toEqual(["L"]);
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

  describe("Scheduler 接入", () => {
    beforeEach(() => {
      mockListActions.mockResolvedValue({ actions: [], errors: [] });
      mockListWorkflows.mockResolvedValue({ workflows: [], errors: [] });
    });

    const schedule = {
      id: "hourly-check",
      name: "Hourly check",
      enabled: true,
      cron: "7 * * * *",
      targetKind: "action",
      targetId: "check",
      params: { DEVICE: "emulator" },
      catchUp: false,
      nextRun: "2026-11-12T10:07:00Z",
      running: false,
    };

    it("挂载时拉取 schedules 并暴露错误", async () => {
      mockListSchedules.mockResolvedValue({ schedules: [schedule], errors: ["bad.yaml"] });
      const { result } = renderHook(() => useActionRunner(), { wrapper });

      await act(() => Promise.resolve());

      expect(mockListSchedules).toHaveBeenCalledTimes(1);
      expect(result.current.schedules).toEqual([schedule]);
      expect(result.current.scheduleErrors).toEqual(["bad.yaml"]);
    });

    it("ListSchedules 刷新失败时保留用户友好错误", async () => {
      mockListSchedules.mockRejectedValue(new Error("backend unavailable"));
      const { result } = renderHook(() => useActionRunner(), { wrapper });

      await act(() => Promise.resolve());
      await act(() => Promise.resolve());

      expect(result.current.scheduleErrors).toEqual(["加载失败: backend unavailable"]);
    });

    it("忽略过期的并发刷新结果", async () => {
      let resolveFirst: ((value: unknown) => void) | undefined;
      let resolveSecond: ((value: unknown) => void) | undefined;
      mockListSchedules
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
      const { result } = renderHook(() => useActionRunner(), { wrapper });

      await act(() => Promise.resolve());
      act(() => listeners["schedules:changed"]?.({ data: { id: schedule.id } }));
      await act(() => Promise.resolve());
      resolveSecond?.({ schedules: [{ ...schedule, running: true }], errors: [] });
      await act(() => Promise.resolve());
      resolveFirst?.({ schedules: [schedule], errors: [] });
      await act(() => Promise.resolve());

      expect(result.current.schedules[0].running).toBe(true);
    });

    it("schedules:changed 刷新列表且卸载后取消订阅", async () => {
      mockListSchedules
        .mockResolvedValueOnce({ schedules: [schedule], errors: [] })
        .mockResolvedValueOnce({ schedules: [{ ...schedule, running: true }], errors: [] });
      const { result, unmount } = renderHook(() => useActionRunner(), { wrapper });

      await act(() => Promise.resolve());
      expect(mockOn).toHaveBeenCalledWith("schedules:changed", expect.any(Function));
      act(() => listeners["schedules:changed"]?.({ data: { id: schedule.id } }));
      await act(() => Promise.resolve());
      expect(result.current.schedules[0].running).toBe(true);
      expect(mockListSchedules).toHaveBeenCalledTimes(2);

      unmount();
      expect(listeners["schedules:changed"]).toBeUndefined();
    });

    it("保存、删除、启停和立即执行成功后更新本地列表", async () => {
      const saved = { ...schedule, name: "Saved" };
      const disabled = { ...saved, enabled: false };
      mockListSchedules
        .mockResolvedValueOnce({ schedules: [schedule], errors: [] })
        .mockResolvedValueOnce({ schedules: [disabled], errors: [] });
      mockSaveSchedule.mockResolvedValue({ schedules: [saved], errors: [] });
      mockSetScheduleEnabled.mockResolvedValue({ schedules: [disabled], errors: [] });
      mockRunScheduleNow.mockResolvedValue(undefined);
      mockDeleteSchedule.mockResolvedValue({ schedules: [], errors: [] });
      const { result } = renderHook(() => useActionRunner(), { wrapper });

      await act(() => Promise.resolve());
      await act(async () => {
        await result.current.saveSchedule({ ...schedule, params: { DEVICE: "phone" } });
      });
      expect(mockSaveSchedule).toHaveBeenCalledWith({ ...schedule, params: { DEVICE: "phone" } });
      expect(result.current.schedules).toEqual([saved]);

      await act(async () => {
        await result.current.setScheduleEnabled(schedule.id, false);
      });
      expect(mockSetScheduleEnabled).toHaveBeenCalledWith(schedule.id, false);
      expect(result.current.schedules).toEqual([disabled]);

      await act(async () => {
        await result.current.runScheduleNow(schedule.id);
      });
      expect(mockRunScheduleNow).toHaveBeenCalledWith(schedule.id);
      expect(mockListSchedules).toHaveBeenCalledTimes(2);
      expect(result.current.schedules).toEqual([disabled]);

      await act(async () => {
        await result.current.deleteSchedule(schedule.id);
      });
      expect(mockDeleteSchedule).toHaveBeenCalledWith(schedule.id);
      expect(result.current.schedules).toEqual([]);
    });

    it("Scheduler API 失败时保留用户友好错误并抛出", async () => {
      mockListSchedules.mockResolvedValue({ schedules: [schedule], errors: [] });
      const { result } = renderHook(() => useActionRunner(), { wrapper });
      await act(() => Promise.resolve());
      await act(() => Promise.resolve());

      const operations = [
        [mockSaveSchedule, () => result.current.saveSchedule(schedule), "save failed"],
        [mockDeleteSchedule, () => result.current.deleteSchedule(schedule.id), "delete failed"],
        [mockSetScheduleEnabled, () => result.current.setScheduleEnabled(schedule.id, false), "toggle failed"],
        [mockRunScheduleNow, () => result.current.runScheduleNow(schedule.id), "run failed"],
      ] as const;
      for (const [mock, operation, message] of operations) {
        const failure = new Error(message);
        mock.mockRejectedValueOnce(failure);
        await act(async () => {
          try {
            await operation();
            throw new Error("expected Scheduler API to reject");
          } catch (error) {
            expect(error).toBe(failure);
          }
        });
        expect(result.current.scheduleErrors).toEqual([message]);
      }
    });
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

  it("workflow 直跑拒绝旧式数组且不改变传入参数", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockListWorkflows.mockResolvedValue({ workflows: [{
      id: "w1", title: "W1", params: [{ id: "TAG", type: "list", default: "[]" }],
    }], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    const params = { TAG: "old tag" };
    await act(() => result.current.runWorkflow("w1", params));
    expect(mockRunWorkflow).not.toHaveBeenCalled();
    expect(result.current.formSheetOpen).toBe(true);
    expect(params).toEqual({ TAG: "old tag" });
  });

  it("workflow 直跑将空 list 归一化为 JSON 空数组", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockListWorkflows.mockResolvedValue({ workflows: [{
      id: "w1", title: "W1", params: [{ id: "TAG", type: "list", default: "" }],
    }], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(() => result.current.runWorkflow("w1", {}));
    expect(mockRunWorkflow).toHaveBeenCalledWith("w1", { TAG: "[]" });
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
      { index: 0, status: "done", exitCode: 0, lines: [{ kind: "text", text: "hi" }, { kind: "text", text: "[stderr] boom" }], lastWasProgress: false, startedAt: expect.any(Number), endedAt: expect.any(Number) },
      { index: 1, status: "error", exitCode: 1, lines: [{ kind: "text", text: "second" }], lastWasProgress: false, startedAt: expect.any(Number), endedAt: expect.any(Number) },
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
      { index: 0, status: "done", exitCode: 0, lines: [{ kind: "progress", text: "push a: 100%" }], lastWasProgress: true, startedAt: expect.any(Number), endedAt: expect.any(Number) },
      { index: 1, status: "running", lines: [{ kind: "text", text: "chmod ok" }], lastWasProgress: false, startedAt: expect.any(Number) },
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

  it("树点击仅标记映射值为字面值；再次运行保留标记，编辑重跑恢复字符串", async () => {
    mockListActions.mockResolvedValue({ actions: [{ id: "download", params: [{ id: "FILE", type: "text" }, { id: "OUT", type: "text" }] }], errors: [] });
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(async () => {
      await result.current.runAction("download", { FILE: "${DATE}.gz", OUT: "${HOME}/out" }, false, ["FILE"]);
    });
    expect(mockRunAction).toHaveBeenCalledWith("download", { FILE: { $literal: "${DATE}.gz" }, OUT: "${HOME}/out" });
    expect(result.current.lastRunParams.download).toEqual({ FILE: "${DATE}.gz", OUT: "${HOME}/out" });
    mockRunAction.mockClear();
    await act(async () => { result.current.rerun("download"); });
    expect(mockRunAction).toHaveBeenCalledWith("download", { FILE: { $literal: "${DATE}.gz" }, OUT: "${HOME}/out" });
    act(() => result.current.editRerun("download"));
    expect(result.current.formValues.FILE).toBe("${DATE}.gz");
    mockRunAction.mockClear();
    await act(async () => { await result.current.runAction("download", result.current.formValues); });
    expect(mockRunAction).toHaveBeenCalledWith("download", { FILE: "${DATE}.gz", OUT: "${HOME}/out" });
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

// 计数收敛到 runAction / runWorkflow / runAi 单点后由对象类型自动分桶：UI 调用点不再各记
// 一次，漏接一个入口就静默失真的问题（ParamSheet action 分支漏记）不再可能。
describe("使用频次分桶", () => {
  const readBucket = (key: string): Record<string, number> =>
    JSON.parse(localStorage.getItem(key) ?? "{}");

  beforeEach(() => {
    localStorage.clear();
    mockListActions.mockResolvedValue({
      actions: [{ id: "adb-devices", title: "Devices", icon: "", description: "" }],
      errors: [],
    });
    mockListAiTasks.mockResolvedValue({ tasks: [aiTask("ai-chat")], errors: [] });
    mockListWorkflows.mockResolvedValue({
      workflows: [{ id: "w1", title: "W1" }],
      errors: [],
    });
  });

  it("运行 AI 任务只记入 ai-usage", async () => {
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());

    await act(() => result.current.runAi("ai-chat", { TOPIC: "hi" }));

    expect(readBucket("ai-usage")["ai-chat"]).toBeGreaterThan(0);
    expect(readBucket("action-usage")).toEqual({});
    expect(readBucket("workflow-usage")).toEqual({});
  });

  it("运行 shell 动作只记入 action-usage", async () => {
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());

    await act(() => result.current.runAction("adb-devices", {}));

    expect(readBucket("action-usage")["adb-devices"]).toBeGreaterThan(0);
    expect(readBucket("ai-usage")).toEqual({});
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

  it("同一 AI 任务每轮运行都累加（一次会话 N 轮 = N 次使用）", async () => {
    const { result } = renderHook(() => useActionRunner(), { wrapper });
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());

    await act(() => result.current.runAi("ai-chat", { TOPIC: "1" }));
    const first = readBucket("ai-usage")["ai-chat"];
    // 上一轮未结束时再点运行只是回到会话（不起第二轮、不计数）：先让它 done
    act(() => {
      _emitForTest("ai:ai-chat:done", { data: { exitCode: 0, err: "", duration: "", seq: 1 } });
    });
    await act(() => result.current.runAi("ai-chat", { TOPIC: "2" }));

    expect(readBucket("ai-usage")["ai-chat"]).toBeGreaterThan(first);
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

// ——— AI 任务运行：每轮运行一份捕获 + 同步订阅（事件走 ai:<id>:*）———
describe("AI 任务运行", () => {
  const emitOut = (seq: number, stream: string, line: string) =>
    _emitForTest("ai:t1:output", { data: { stream, line, seq } });
  const emitDone = (seq: number, extra: Record<string, unknown> = {}) =>
    _emitForTest("ai:t1:done", {
      data: { exitCode: 0, err: "", duration: "1.2s", seq, ...extra },
    });
  // 挂载并前台起跑 t1（overrides = 并入草稿的预设值；等 RunAi 返回）
  const startT1 = async (overrides?: Record<string, string>) => {
    const hook = await mountAi();
    await act(async () => {
      await hook.result.current.runAi("t1", overrides);
    });
    return hook;
  };

  beforeEach(() => {
    localStorage.clear();
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockListAiTasks.mockResolvedValue({ tasks: [aiTask()], errors: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ai-tool 事件进面板的工序段，不混进回复正文", async () => {
    const { result } = await startT1();
    act(() => {
      emitOut(1, "ai-tool", JSON.stringify({ id: "toolu_1", name: "Read", input: { file_path: "/repo/package.json" } }));
      emitOut(2, "ai-tool", JSON.stringify({ id: "toolu_1", content: "ok" }));
      emitOut(3, "ai", "看完了");
    });
    expect(result.current.aiText).toBe("看完了");
    expect(result.current.aiPanel.segments).toMatchObject([
      { kind: "tool", id: "toolu_1", name: "Read", summary: "package.json", result: "ok" },
      { kind: "answer", text: "看完了" },
    ]);
    expect(result.current.aiPanel.streaming).toBe(true);
  });

  it("stdout/stderr 只进诊断行（失败时回看用），不进回复正文", async () => {
    const { result } = await startT1();
    act(() => {
      emitOut(1, "ai", "回答");
      emitOut(2, "stderr", "warn");
      emitOut(3, "stdout", "debug");
    });
    expect(result.current.aiText).toBe("回答");
    expect(result.current.aiDiag).toEqual([
      { stream: "stderr", text: "warn" },
      { stream: "stdout", text: "debug" },
    ]);
  });

  it("发送快照是模板按草稿展开后的文本（气泡回显用）", async () => {
    const { result } = await startT1();
    expect(result.current.sentPrompt).toBe("解释 季度报告");
    expect(result.current.sentAt).not.toBeNull();
  });

  it("done 后置 done 态、清运行标记；此后迟到的事件不再改可见态", async () => {
    const { result } = await startT1();
    act(() => {
      emitOut(1, "ai", "回答");
      emitOut(2, "ai-thinking", "想了想");
      emitDone(3, { readout: { sessionId: "sess-1", durationMs: 1200 } });
    });
    expect(result.current.status).toBe("done");
    expect(result.current.exitInfo).toMatchObject({ exitCode: 0, duration: "1.2s" });
    expect(result.current.isAiRunning("t1")).toBe(false);
    expect(result.current.isRunning("t1")).toBe(false);
    expect(result.current.aiPanel.streaming).toBe(false);
    expect(result.current.aiPanel.readout).toMatchObject({ durationMs: 1200, isError: false });
    // 前端不另存运行记录：由后端落盘（见 runs:changed 的用例）
    act(() => {
      emitOut(4, "ai", "迟到");
    });
    expect(result.current.aiText).toBe("回答");
  });

  it("done 非 0 退出码：置 error 态", async () => {
    const { result } = await startT1();
    act(() => {
      _emitForTest("ai:t1:done", {
        data: { exitCode: 1, err: "CLI 未安装", duration: "0.5s", seq: 1 },
      });
    });
    expect(result.current.status).toBe("error");
    expect(result.current.exitInfo).toMatchObject({ exitCode: 1, err: "CLI 未安装" });
  });

  it("乱序到达的增量按 seq 落位（2 号先到时挂起，1 号补到后按序应用）", async () => {
    const { result } = await startT1();
    act(() => {
      emitOut(2, "ai", "世界");
    });
    expect(result.current.aiText).toBe("");
    act(() => {
      emitOut(1, "ai", "你好");
    });
    expect(result.current.aiText).toBe("你好世界");
  });

  it("done 抢在增量前到达：空洞补齐后才收尾，回复不丢尾巴", async () => {
    const { result } = await startT1();
    act(() => {
      emitOut(1, "ai", "你好");
    });
    act(() => {
      emitDone(3);
    });
    // 2 号空洞未补：仍是运行态，没收尾
    expect(result.current.status).toBe("running");
    expect(result.current.isAiRunning("t1")).toBe(true);
    act(() => {
      emitOut(2, "ai", "世界");
    });
    expect(result.current.status).toBe("done");
    expect(result.current.aiText).toBe("你好世界");
  });

  it("空洞在宽限内没补齐：到期按已有内容收尾（丢包时不会永久挂起）", async () => {
    vi.useFakeTimers();
    const { result } = await startT1();
    act(() => {
      emitOut(1, "ai", "你好");
    });
    act(() => {
      emitDone(3);
    });
    expect(result.current.status).toBe("running");
    // 宽限 400ms 内继续等迟到的 2 号
    await act(() => vi.advanceTimersByTimeAsync(399));
    expect(result.current.status).toBe("running");
    // 过了宽限：下一次复查（每 50ms）收尾
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(result.current.status).toBe("done");
    expect(result.current.aiText).toBe("你好");
    expect(result.current.isAiRunning("t1")).toBe(false);
  });

  it("RunAi 被后端拒绝：前台运行把原因显示在会话页，不算一次运行、不留运行标记", async () => {
    mockRunAi.mockRejectedValueOnce('AI 任务 "t1" 正在运行');
    const { result } = await mountAi();
    await act(async () => {
      await result.current.runAi("t1");
    });
    expect(result.current.view).toBe("ai-chat");
    expect(result.current.status).toBe("error");
    expect(result.current.exitInfo).toMatchObject({ exitCode: 1, err: 'AI 任务 "t1" 正在运行' });
    expect(result.current.isAiRunning("t1")).toBe(false);
  });

  it("后台运行点火失败：不打断当前视图", async () => {
    mockRunAi.mockRejectedValueOnce("参数不合法");
    const { result } = await mountAi();
    act(() => result.current.setView("actions-grid"));
    await act(async () => {
      await result.current.runAi("t1", undefined, true);
    });
    expect(result.current.view).toBe("actions-grid");
    expect(result.current.status).toBe("idle");
    expect(result.current.exitInfo).toBeNull();
    expect(result.current.isAiRunning("t1")).toBe(false);
  });

  it("后台运行不切视图、不碰可见态；结束后同样收尾", async () => {
    const { result } = await mountAi();
    act(() => result.current.setView("actions-grid"));
    await act(async () => {
      await result.current.runAi("t1", undefined, true);
    });
    expect(result.current.view).toBe("actions-grid");
    expect(result.current.status).toBe("idle");
    expect(result.current.currentId).toBeNull();
    expect(result.current.isAiRunning("t1")).toBe(true);
    act(() => {
      emitOut(1, "ai", "后台回答");
    });
    expect(result.current.aiText).toBe("");
    act(() => {
      emitDone(2);
    });
    expect(result.current.isAiRunning("t1")).toBe(false);
    // 那一轮已收尾（捕获随之释放）：回到会话页是空态，那一轮只能在运行详情里看
    act(() => result.current.focusAi("t1"));
    expect(result.current.view).toBe("ai-chat");
    expect(result.current.status).toBe("idle");
    expect(result.current.aiText).toBe("");
  });

  it("后台运行中点回任务：回放到那一轮的输出（网格卡后台跑，点卡片本体看进度）", async () => {
    const { result } = await mountAi();
    await act(async () => {
      await result.current.runAi("t1", undefined, true);
    });
    act(() => {
      emitOut(1, "ai", "后台回答");
    });
    expect(result.current.aiText).toBe("");
    act(() => result.current.focusAi("t1"));
    expect(result.current.view).toBe("ai-chat");
    expect(result.current.status).toBe("running");
    expect(result.current.aiText).toBe("后台回答");
    // 订阅跟着这一轮运行走：此后增量继续进可见态
    act(() => {
      emitOut(2, "ai", "（续）");
    });
    expect(result.current.aiText).toBe("后台回答（续）");
  });

  it("会话页开着时从别处后台再跑同一任务：页面回到空态，新一轮输出只进捕获", async () => {
    const { result } = await startT1();
    act(() => {
      emitOut(1, "ai", "上一轮");
      emitDone(2);
    });
    await act(async () => {
      await result.current.runAi("t1", undefined, true);
    });
    expect(result.current.view).toBe("ai-chat");
    expect(result.current.status).toBe("idle");
    expect(result.current.aiText).toBe("");
    act(() => {
      emitOut(1, "ai", "新回答");
    });
    expect(result.current.aiText).toBe("");
    act(() => result.current.focusAi("t1"));
    expect(result.current.status).toBe("running");
    expect(result.current.aiText).toBe("新回答");
  });

  it("已在运行时再点运行：前台回到会话、后台不动，都不重复发 RPC", async () => {
    const { result } = await mountAi();
    await act(async () => {
      await result.current.runAi("t1", undefined, true);
    });
    await act(async () => {
      await result.current.runAi("t1");
    });
    expect(result.current.view).toBe("ai-chat");
    expect(result.current.status).toBe("running");
    await act(async () => {
      await result.current.runAi("t1", undefined, true);
    });
    expect(mockRunAi).toHaveBeenCalledTimes(1);
  });

  it("上一轮 done 已到还在等迟到增量时再发：先收尾上一轮再起新一轮", async () => {
    const { result } = await startT1();
    act(() => {
      emitDone(2);
    });
    await act(async () => {
      await result.current.runAi("t1");
    });
    expect(mockRunAi).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("running");
    // 新一轮序号从 1 重来
    act(() => {
      emitOut(1, "ai", "第二轮");
    });
    expect(result.current.aiText).toBe("第二轮");
  });

  it("草稿 = 定义初值 + 改过的键；setAiDraftValue 传 undefined 撤回修改；resume 非空才发送", async () => {
    const { result } = await mountAi();
    act(() => result.current.openAiChat("t1"));
    expect(result.current.aiDraft).toEqual({
      prompt: "解释 ${TOPIC}",
      system: "你是助手",
      resume: "",
      TOPIC: "季度报告",
    });
    act(() => result.current.setAiDraftValue("TOPIC", "年报"));
    expect(result.current.aiDraft.TOPIC).toBe("年报");
    act(() => result.current.setAiDraftValue("TOPIC", undefined));
    expect(result.current.aiDraft.TOPIC).toBe("季度报告");
    act(() => result.current.setAiDraftValue("resume", " sess-9 "));
    await act(async () => {
      await result.current.runAi("t1");
    });
    // 没改过的已声明参数不发送；resume 去首尾空白后非空才发送
    expect(mockRunAi).toHaveBeenCalledWith("t1", {
      prompt: "解释 ${TOPIC}",
      system: "你是助手",
      resume: "sess-9",
    });
    expect(result.current.lastRunParams["t1"]).toEqual({
      prompt: "解释 ${TOPIC}",
      system: "你是助手",
      resume: "sess-9",
    });
  });

  it("runAi 的 overrides 并入草稿并随运行发送；缺必填输入时不发 RPC、进会话页补全", async () => {
    const { result } = await mountAi();
    await act(async () => {
      await result.current.runAi("t1", { TOPIC: "年报" });
    });
    expect(mockRunAi).toHaveBeenCalledWith("t1", {
      prompt: "解释 ${TOPIC}",
      system: "你是助手",
      TOPIC: "年报",
    });
    expect(result.current.aiDraft.TOPIC).toBe("年报");
    expect(result.current.sentPrompt).toBe("解释 年报");
    act(() => {
      emitDone(1);
    });
    act(() => result.current.setAiDraftValue("prompt", "   "));
    mockRunAi.mockClear();
    await act(async () => {
      await result.current.runAi("t1", undefined, true);
    });
    expect(mockRunAi).not.toHaveBeenCalled();
    expect(result.current.view).toBe("ai-chat");
    expect(result.current.isAiRunning("t1")).toBe(false);
  });

  it("定义没给默认值的参数取全局配置同名 key；两者都没有为空", async () => {
    mockGetGlobalConfig.mockResolvedValue({ DEPTH: "全局值" });
    mockListAiTasks.mockResolvedValue({
      tasks: [
        aiTask("t1", {
          params: [
            { id: "DEPTH", label: "深度", type: "text", required: false, default: "", options: [] },
            { id: "LANG", label: "语言", type: "text", required: false, default: "", options: [] },
          ],
        }),
      ],
      errors: [],
    });
    const { result } = await mountAi();
    act(() => result.current.openAiChat("t1"));
    expect(result.current.aiDraft.DEPTH).toBe("全局值");
    expect(result.current.aiDraft.LANG).toBe("");
  });

  it("rerun 原样重放上轮发送的参数且不写回草稿；editRerun 回到会话页改了再发", async () => {
    const { result } = await startT1({ TOPIC: "年报" });
    act(() => {
      emitDone(1);
    });
    act(() => result.current.setAiDraftValue("resume", "sess-9"));
    mockRunAi.mockClear();
    act(() => result.current.rerun("t1"));
    expect(mockRunAi).toHaveBeenCalledWith("t1", {
      prompt: "解释 ${TOPIC}",
      system: "你是助手",
      TOPIC: "年报",
    });
    expect(result.current.view).toBe("ai-chat");
    expect(result.current.status).toBe("running");
    // 重放后草稿里后填的 resume 原样保留（只属于下一轮发送）
    expect(result.current.aiDraft.resume).toBe("sess-9");
    act(() => {
      emitDone(1);
    });
    act(() => result.current.editRerun("t1"));
    expect(result.current.view).toBe("ai-chat");
    expect(result.current.status).toBe("idle");
    expect(mockRunAi).toHaveBeenCalledTimes(1);
  });

  it("进编辑页再退回：已收尾的那一轮仍留在会话页", async () => {
    const { result } = await startT1();
    act(() => {
      emitOut(1, "ai", "回答");
      emitDone(2);
    });
    act(() => result.current.openYamlEditor("t1", "ai"));
    expect(result.current.view).toBe("ai-edit");
    expect(result.current.currentId).toBe("t1");
    // AiYamlEditor 的 onExit
    act(() => result.current.setView("ai-chat"));
    expect(result.current.aiText).toBe("回答");
    expect(result.current.status).toBe("done");
  });

  it("会话页的停止发给 CancelAi（不是 CancelAction）", async () => {
    const { result } = await startT1();
    act(() => result.current.cancel());
    expect(mockCancelAi).toHaveBeenCalledWith("t1");
    expect(mockCancelAction).not.toHaveBeenCalled();
  });

  it("saveAiYaml 写回并用返回的列表刷新 aiTasks / aiErrors；getAiYaml 转发", async () => {
    const { result } = await mountAi();
    mockSetAiYaml.mockResolvedValue({ tasks: [aiTask("t9")], errors: ["ai/x.yaml: bad"] });
    await act(async () => {
      await result.current.saveAiYaml("t1", "id: t9\n");
    });
    expect(mockSetAiYaml).toHaveBeenCalledWith("t1", "id: t9\n");
    expect(result.current.aiTasks.map((task) => task.id)).toEqual(["t9"]);
    expect(result.current.aiErrors).toEqual(["ai/x.yaml: bad"]);
    mockGetAiYaml.mockResolvedValue("id: t9\n");
    let yaml = "";
    await act(async () => {
      yaml = await result.current.getAiYaml("t9");
    });
    expect(yaml).toBe("id: t9\n");
    expect(mockGetAiYaml).toHaveBeenCalledWith("t9");
  });

  it("AI 任务列表加载失败：原因进 aiErrors", async () => {
    mockListAiTasks.mockRejectedValue(new Error("boom"));
    const { result } = await mountAi();
    expect(result.current.aiTasks).toHaveLength(0);
    expect(result.current.aiErrors).toHaveLength(1);
    expect(result.current.aiErrors[0]).toContain("boom");
  });

  it("workflow 的 AI 步骤占用任务：占用即算运行中，期间 runAi 转去那个 workflow，结束释放", async () => {
    mockListWorkflows.mockResolvedValue({
      workflows: [{ id: "w1", title: "W1", params: [], steps: [{ kind: "ai", label: "t1", name: "" }] }],
      errors: [],
    });
    const { result } = await mountAi();
    expect(result.current.isAiRunning("t1")).toBe(false);
    act(() => result.current.setView("actions-grid"));
    await act(async () => {
      await result.current.runWorkflow("w1", {}, true);
    });
    act(() => {
      _emitForTest("workflow:w1:output", { data: { stream: "step-start", line: "0" } });
    });
    expect(result.current.isAiRunning("t1")).toBe(true);
    expect(result.current.isRunning("t1")).toBe(true);
    // 后端对 AI 任务按 id 加锁：占着时 RunAi 必被拒，前端直接导航过去
    await act(async () => {
      await result.current.runAi("t1");
    });
    expect(mockRunAi).not.toHaveBeenCalled();
    expect(result.current.view).toBe("workflow");
    act(() => {
      _emitForTest("workflow:w1:output", { data: { stream: "step-done", line: "0:0" } });
    });
    expect(result.current.isAiRunning("t1")).toBe(false);
    // 步骤没报结束、workflow 整体先结束：占用也一并放掉
    act(() => {
      _emitForTest("workflow:w1:output", { data: { stream: "step-start", line: "0" } });
      _emitForTest("workflow:w1:done", { data: { exitCode: 0, err: "", duration: "1s" } });
    });
    expect(result.current.isAiRunning("t1")).toBe(false);
    expect(result.current.runningWorkflowId).toBeNull();
  });

  it("workflow 里 AI 步骤的回复/思考/工具调用归约成工序段，不进文本行；步骤收尾时面板结算", async () => {
    mockListWorkflows.mockResolvedValue({
      workflows: [{ id: "w1", title: "W1", params: [], steps: [{ kind: "ai", label: "t1", name: "" }] }],
      errors: [],
    });
    const { result } = await mountAi();
    await act(async () => {
      await result.current.runWorkflow("w1");
    });
    const emit = (stream: string, line: string) =>
      _emitForTest("workflow:w1:output", { data: { stream, line, step: "0" } });
    act(() => {
      emit("step-start", "0");
    });
    act(() => {
      emit("ai", "Hello");
      emit("ai", " world\n");
      emit("ai", "Tail");
    });
    expect(result.current.workflowSteps[0].lines).toEqual([]);
    expect(result.current.workflowSteps[0].aiPanel?.segments).toMatchObject([{ kind: "answer", text: "Hello world\nTail" }]);
    expect(result.current.workflowSteps[0].aiPanel?.streaming).toBe(true);
    act(() => {
      emit("ai-thinking", "想");
      emit("ai-tool", "{}"); // 解析不了的 tool 行被忽略
      emit("stderr", "warn");
    });
    // 诊断行照旧落文本桶；思考另开一段
    expect(result.current.workflowSteps[0].lines).toHaveLength(1);
    expect(result.current.workflowSteps[0].lines[0]).toMatchObject({ kind: "text", text: expect.stringContaining("warn") });
    expect(result.current.workflowSteps[0].aiPanel?.segments.map((segment) => segment.kind)).toEqual(["answer", "thinking"]);
    act(() => {
      emit("step-done", "0:0");
    });
    expect(result.current.workflowSteps[0].status).toBe("done");
    expect(result.current.workflowSteps[0].aiPanel?.streaming).toBe(false);
    expect(result.current.workflowSteps[0].aiPanel?.readout).toMatchObject({ isError: false });
    // 步骤收尾后迟到的增量并入面板，不再落文本行
    act(() => {
      emit("ai", "late");
    });
    expect(result.current.workflowSteps[0].lines).toHaveLength(1);
    expect(result.current.workflowSteps[0].aiPanel?.segments.at(-1)).toMatchObject({ kind: "answer", text: "late" });
  });

  // ——— 运行记录（M3）：前端不另存运行记录，后端是唯一的真相 ———

  it("runs:changed 让 runsRevision 递增；运行结束的那条触发 AI 任务列表重拉（刷新卡片摘要）", async () => {
    const { result } = await mountAi();
    // 挂载时已拉过一次列表：从这里开始只数 runs:changed 触发的重拉
    mockListAiTasks.mockClear();
    const before = result.current.runsRevision;
    act(() => {
      listeners["runs:changed"]?.({ data: { run_id: "r1", status: "running" } });
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    expect(result.current.runsRevision).toBe(before + 1);
    // 开始的那条不算新的「最近一次运行」
    expect(mockListAiTasks).not.toHaveBeenCalled();
    act(() => {
      listeners["runs:changed"]?.({ data: { run_id: "r1", status: "succeeded" } });
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(result.current.runsRevision).toBe(before + 2);
    expect(mockListAiTasks).toHaveBeenCalledTimes(1);
  });

  it("后端发起的运行（调度到点/立即运行，前端未调 runAi）也点亮 AI 运行态：runs:changed running → isAiRunning", async () => {
    const { result } = await mountAi();
    expect(result.current.isAiRunning("t1")).toBe(false);
    act(() => {
      listeners["runs:changed"]?.({ data: { run_id: "r1", status: "running", target_kind: "ai", target_id: "t1" } });
    });
    expect(result.current.isAiRunning("t1")).toBe(true);
    act(() => {
      listeners["runs:changed"]?.({ data: { run_id: "r1", status: "succeeded", target_kind: "ai", target_id: "t1" } });
    });
    expect(result.current.isAiRunning("t1")).toBe(false);
  });

  it("一次运行「开始 + 结束」连发两条 runs:changed：合并成一次失效通知", async () => {
    const { result } = await mountAi();
    const before = result.current.runsRevision;
    act(() => {
      listeners["runs:changed"]?.({ data: { status: "running" } });
      listeners["runs:changed"]?.({ data: { status: "succeeded" } });
    });
    expect(result.current.runsRevision).toBe(before);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    expect(result.current.runsRevision).toBe(before + 1);
  });

  it("被拒的运行不产生运行记录：runsRevision 不变", async () => {
    mockRunAi.mockRejectedValueOnce('AI 任务 "t1" 正在运行');
    const { result } = await mountAi();
    const before = result.current.runsRevision;
    await act(async () => { await result.current.runAi("t1"); });
    expect(result.current.status).toBe("error");
    expect(result.current.runsRevision).toBe(before);
  });

  it("openRun 记住来处：从会话页进运行详情，closeRun 回到会话页", async () => {
    const { result } = await mountAi();
    act(() => result.current.openAiChat("t1"));
    expect(result.current.view).toBe("ai-chat");
    act(() => result.current.openRun("r20261125-021500-a1b2c3"));
    expect(result.current.view).toBe("run-detail");
    expect(result.current.currentRunId).toBe("r20261125-021500-a1b2c3");
    act(() => result.current.closeRun());
    expect(result.current.view).toBe("ai-chat");
    expect(result.current.currentRunId).toBeNull();
  });

  it("openRuns 带筛选进入运行记录列表；从列表进详情再退出回到列表", async () => {
    const { result } = await mountAi();
    act(() => result.current.openRuns({ targetKind: "ai", targetId: "t1" }));
    expect(result.current.view).toBe("runs");
    expect(result.current.runsFilter).toEqual({ targetKind: "ai", targetId: "t1" });
    act(() => result.current.openRun("r1"));
    act(() => result.current.closeRun());
    expect(result.current.view).toBe("runs");
  });

  it("调度编辑器由 Provider 持有：打开后换 key 重置，切换视图即关闭", async () => {
    const { result } = await mountAi();
    expect(result.current.scheduleEditor).toBeNull();
    act(() => result.current.openScheduleForm(
      { id: "s1", name: "夜间", enabled: true, cron: "0 2 * * *", targetKind: "ai", targetId: "t1", params: {} }, true, { kind: "ai", id: "t1" }));
    const first = result.current.scheduleEditor!;
    expect(first).toMatchObject({ creating: true, lock: { kind: "ai", id: "t1" } });
    expect(first.value.id).toBe("s1");
    act(() => result.current.closeScheduleForm());
    expect(result.current.scheduleEditor).toBeNull();
    act(() => result.current.openScheduleForm(
      { id: "s1", name: "夜间", enabled: true, cron: "0 2 * * *", targetKind: "ai", targetId: "t1", params: {} }, true));
    // 同一份值再次打开：key 也不同，草稿照样重置
    expect(result.current.scheduleEditor!.key).not.toBe(first.key);
    act(() => result.current.setView("runs"));
    expect(result.current.scheduleEditor).toBeNull();
  });

  it("后台起跑撞上运行中的目标：去正在占用它的那条运行的详情，而不是点了没反应", async () => {
    mockRunAi.mockRejectedValueOnce('AI 任务 "t1" 正在运行');
    mockListRuns.mockResolvedValueOnce({ runs: [
      { id: "r20261125-021500-a1b2c3", targetKind: "ai", targetId: "t1", status: "running", origin: "schedule" },
    ] });
    const { result } = await mountAi();
    act(() => result.current.setView("actions-grid"));
    await act(async () => {
      await result.current.runAi("t1", undefined, true);
    });
    expect(mockListRuns).toHaveBeenCalledWith({ targetKind: "ai", targetId: "t1", status: "running", origin: "", limit: 0 });
    expect(result.current.view).toBe("run-detail");
    expect(result.current.currentRunId).toBe("r20261125-021500-a1b2c3");
    expect(result.current.isAiRunning("t1")).toBe(false);
    // 已被带到别处：这一轮的失败不再把可见态打成 error
    expect(result.current.status).toBe("idle");
  });

  it("后台起跑被拒但查不到在跑的运行：维持原样，视图不动", async () => {
    mockRunAi.mockRejectedValueOnce('AI 任务 "t1" 正在运行');
    const { result } = await mountAi();
    act(() => result.current.setView("actions-grid"));
    await act(async () => {
      await result.current.runAi("t1", undefined, true);
    });
    expect(result.current.view).toBe("actions-grid");
    expect(result.current.currentRunId).toBeNull();
    expect(result.current.isAiRunning("t1")).toBe(false);
  });

  it("前台起跑被拒：原因留在会话页，不跳去运行详情", async () => {
    mockRunAi.mockRejectedValueOnce('AI 任务 "t1" 正在运行');
    mockListRuns.mockClear();
    const { result } = await mountAi();
    await act(async () => {
      await result.current.runAi("t1");
    });
    expect(mockListRuns).not.toHaveBeenCalled();
    expect(result.current.view).toBe("ai-chat");
    expect(result.current.exitInfo).toMatchObject({ exitCode: 1, err: 'AI 任务 "t1" 正在运行' });
  });
});
