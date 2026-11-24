import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { useEffect, useRef } from "react";

const { mockListAiTasks, mockRunAi, mockCancelAi, mockGetAiYaml, mockSetAiYaml } = vi.hoisted(() => ({
  mockListAiTasks: vi.fn(),
  mockRunAi: vi.fn(),
  mockCancelAi: vi.fn(),
  mockGetAiYaml: vi.fn(),
  mockSetAiYaml: vi.fn(),
}));

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  ListAiTasks: mockListAiTasks,
  RunAi: mockRunAi,
  CancelAi: mockCancelAi,
  GetAiYaml: mockGetAiYaml,
  SetAiYaml: mockSetAiYaml,
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn().mockResolvedValue(undefined),
  GetFragments: vi.fn().mockResolvedValue([]),
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: vi.fn().mockResolvedValue(undefined),
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  ListSchedules: vi.fn().mockResolvedValue({ schedules: [], errors: [] }),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => ({}) } }));
// 拦截 useStickToBottomContext：jsdom 无真实布局，用 spy 验证「进入历史查看时显式滚到底」；
// 布局修复（min-h-0）另以类名断言守护。StickToBottom/Content 保持真实实现。
const { scrollToBottomMock } = vi.hoisted(() => ({ scrollToBottomMock: vi.fn() }));
vi.mock("use-stick-to-bottom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("use-stick-to-bottom")>();
  return {
    ...actual,
    useStickToBottomContext: () => ({ isAtBottom: true, scrollToBottom: scrollToBottomMock }),
  };
});

import { ActionRunnerProvider, _emitForTest } from "../context/ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import { clearAiHistory } from "../hooks/useAiHistory";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AiChatView } from "./AiChatView";

// AI 任务夹具。t1：一个带默认值的必填参数、两个预设（分别覆写 prompt / TOPIC）、系统提示词；
// t2：无参数、无预设、无描述；t3：定义里 prompt/system 为空串（提示词必须由调用方给入）。
const mkTask = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  icon: "",
  description: "",
  color: "",
  params: [],
  presets: [],
  prompt: "T_PROMPT",
  system: "",
  timeout: "",
  ...extra,
});

const T1 = mkTask("t1", {
  title: "任务一",
  description: "描述一",
  params: [
    {
      id: "TOPIC",
      label: "主题",
      type: "text",
      required: true,
      default: "季度报告",
      options: [],
      description: undefined,
    },
  ],
  presets: [
    { name: "打招呼", description: "", values: { prompt: "介绍你自己" } },
    { name: "年报", description: "", values: { TOPIC: "年度总结" } },
  ],
  prompt: "请处理 ${TOPIC}",
  system: "你是助手",
});
const T2 = mkTask("t2", { title: "任务二", prompt: "T2_PROMPT" });
const T3 = mkTask("t3", { title: "任务三", prompt: "" });
const TASKS = [T1, T2, T3];

// ai:<id>:output / done 事件。后端契约：seq 每次运行从 1 起，done 独占一个号。
const emitOut = (seq: number, stream: string, line: string, id = "t1") =>
  act(() => {
    _emitForTest(`ai:${id}:output`, { data: { stream, line, seq } });
  });
const emitDone = (seq: number, data: Record<string, unknown> = {}, id = "t1") =>
  act(() => {
    _emitForTest(`ai:${id}:done`, { data: { exitCode: 0, err: "", duration: "1.2s", ...data, seq } });
  });

interface DriveProps {
  /** 打开哪个任务的会话页 */
  id?: string;
  /** 打开后紧接着前台起跑一轮（默认起） */
  run?: boolean;
}

// 任务列表落地后打开 id 的会话页（Provider 挂载时才拉 ListAiTasks）；run 时再前台起跑。
function Drive({ id = "t1", run = true }: DriveProps) {
  const { aiTasks, view, openAiChat, runAi } = useActionRunner();
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (aiTasks.length === 0 || opened.current === id) return;
    opened.current = id;
    openAiChat(id);
    if (run) void runAi(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiTasks, id]);
  return (
    <>
      <AiChatView />
      <div data-testid="view-probe">{view}</div>
    </>
  );
}

function wrap(props: DriveProps) {
  return (
    <ActionRunnerProvider>
      <SidebarProvider>
        <Drive {...props} />
      </SidebarProvider>
    </ActionRunnerProvider>
  );
}

// 等挂载期的 RPC 落地 → Drive 打开会话页 → 再渲染一帧
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(() => Promise.resolve());
};

async function renderChat(props: DriveProps = {}) {
  const utils = render(wrap(props));
  await settle();
  return utils;
}

describe("AiChatView", () => {
  beforeEach(() => {
    mockListAiTasks.mockReset().mockResolvedValue({ tasks: TASKS, errors: [] });
    mockRunAi.mockReset().mockResolvedValue(undefined);
    mockCancelAi.mockReset();
    localStorage.clear();
    // 历史仓是模块级单例（localStorage 只在首次访问时读入）：逐例显式清空各任务的历史
    for (const task of TASKS) clearAiHistory(task.id);
    scrollToBottomMock.mockClear();
  });

  it("渲染任务标题；运行中显示状态与停止钮，停止走 CancelAi", async () => {
    await renderChat();
    // 标题是进该任务 YAML 编辑页的按钮（title 提示「编辑 yaml」）
    const title = await screen.findByRole("button", { name: "任务一" });
    expect(title).toHaveAttribute("title", "编辑 yaml");
    expect(screen.getByText("运行中")).toBeInTheDocument();
    // 顶栏 + composer 各一个停止钮；发送钮让位
    const stopButtons = screen.getAllByRole("button", { name: "停止" });
    expect(stopButtons).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "发送" })).not.toBeInTheDocument();
    fireEvent.click(stopButtons[1]);
    expect(mockCancelAi).toHaveBeenCalledTimes(1);
    expect(mockCancelAi).toHaveBeenCalledWith("t1");
  });

  it("流式渲染回复文本（ai 通道增量）", async () => {
    await renderChat();
    emitOut(1, "ai", "处理完成");
    expect(await screen.findByText(/处理完成/)).toBeInTheDocument();
  });

  it("ai-tool 事件渲染为工序段（工具名 · 主参数摘要）", async () => {
    await renderChat();
    emitOut(
      1,
      "ai-tool",
      JSON.stringify({ id: "call_1", name: "Read", input: { file_path: "C:\\tmp\\package.json" } }),
    );
    // 段头标签：工具名 + summarizeInput 提取的路径末段（分属两个 span，分别断言）
    expect(await screen.findByText("Read")).toBeInTheDocument();
    expect(screen.getByText("· package.json")).toBeInTheDocument();
  });

  it("完成后写入历史，抽屉可浏览；清空历史回到无计数", async () => {
    await renderChat();
    // 历史按钮常驻，初始无计数（badge 不渲染、aria-label 不带 N）
    expect(await screen.findByRole("button", { name: "历史" })).toBeInTheDocument();
    emitOut(1, "ai", "done-text");
    emitDone(2, { duration: "1.2s" });
    // done 写入 1 条历史 → aria-label 变「历史 · 1」；顶栏读数完成 + 时长
    const counted = await screen.findByRole("button", { name: "历史 · 1" });
    expect(screen.getByText("· 1.2s")).toBeInTheDocument();
    // 运行结束：停止钮撤下、发送钮回来
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    fireEvent.click(counted);
    const drawer = await screen.findByRole("complementary");
    expect(within(drawer).getByText("历史记录 · 1")).toBeInTheDocument();
    expect(within(drawer).getByText("请处理 季度报告")).toBeInTheDocument();
    expect(within(drawer).getByText("done-text")).toBeInTheDocument();
    // 清空历史：计数消失、抽屉转空态
    fireEvent.click(within(drawer).getByRole("button", { name: "清空历史" }));
    expect(screen.getByRole("button", { name: "历史" })).toBeInTheDocument();
    expect(screen.getByText("暂无历史记录")).toBeInTheDocument();
  });

  it("点历史条目显示完成态而非生成中（liveIndex 三态契约回归）；会话 id 回填续接 chip", async () => {
    await renderChat();
    emitOut(1, "ai-thinking", "想一想");
    emitOut(2, "ai-tool", JSON.stringify({ id: "call_1", name: "Read", input: { file_path: "/a/package.json" } }));
    emitOut(3, "ai-tool", JSON.stringify({ id: "call_1", content: "react 19" }));
    emitOut(4, "ai", "最终回答");
    emitDone(5, {
      duration: "3.5s",
      readout: { durationMs: 3500, inputTokens: 100, outputTokens: 20, costUsd: 0.01, sessionId: "sess-a1b2c3" },
    });
    // 打开历史抽屉并点选条目 → 只读查看态（进入查看时需显式滚到底，读数行才可见）。
    // 实时气泡也显示同一条 prompt，故条目查询限定在抽屉内。
    scrollToBottomMock.mockClear();
    fireEvent.click(await screen.findByRole("button", { name: "历史 · 1" }));
    const drawer = await screen.findByRole("complementary");
    fireEvent.click(within(drawer).getByText("请处理 季度报告"));
    await act(() => Promise.resolve());
    expect(scrollToBottomMock).toHaveBeenCalled();
    // Thread 必须带 min-h-0：基类 h-full（height:100%）在 flex 列里会把末尾读数行/composer 挤出视口
    expect(document.querySelector('[data-slot="thread"]')).toHaveClass("min-h-0");
    // 查看横幅 + 会话 id（顶部展示 + 回填到 resume chip）+ 终点读数行存在
    expect(await screen.findByText(/正在查看历史记录/)).toBeInTheDocument();
    expect(screen.getAllByText(/sess-a1b2c3/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("3.5s").length).toBeGreaterThan(0);
    // live 态文案不得出现（历史段 durationMs 为 undefined，不能误判为 null=进行中）
    expect(screen.queryByText("生成中")).not.toBeInTheDocument();
    expect(screen.queryByText("调用中")).not.toBeInTheDocument();
    expect(screen.queryByText("思考中")).not.toBeInTheDocument();
    // 历史回答正文仍在渲染
    expect(screen.getByText(/最终回答/)).toBeInTheDocument();
    // 查看历史即「准备续接该会话」：session id 回填到 resume
    expect(screen.getByRole("button", { name: /续接会话\s*sess-a1b2c3/ })).toBeInTheDocument();
    // 返回当前：横幅撤下，续接会话保留（下一次发送就接着这个会话）
    fireEvent.click(screen.getByRole("button", { name: /返回当前/ }));
    await act(() => Promise.resolve());
    expect(screen.queryByText(/正在查看历史记录/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /续接会话\s*sess-a1b2c3/ })).toBeInTheDocument();
    // chip 上的 × 清除 → 回到新会话
    fireEvent.click(screen.getByRole("button", { name: "清除续接会话" }));
    expect(screen.queryByRole("button", { name: "清除续接会话" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /续接会话\s*新会话/ })).toBeInTheDocument();
  });

  it("必填 param 仅有 default（用户未编辑）时发送按钮可用；chip 摘要显示默认值与已配置的系统提示词", async () => {
    await renderChat({ run: false });
    expect(await screen.findByRole("button", { name: "发送" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /主题\s*季度报告/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /系统提示词\s*已配置/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /续接会话\s*新会话/ })).toBeInTheDocument();
    // 尚无会话：空态显示任务描述
    expect(screen.getByText("描述一")).toBeInTheDocument();
  });

  it("点预设 chip 把预设值填入 composer（只覆写预设给出的键）", async () => {
    await renderChat({ run: false });
    // 打开时 composer 显示定义里的提示词模板
    const textarea = await screen.findByPlaceholderText(/输入/);
    expect(textarea).toHaveValue("请处理 ${TOPIC}");
    fireEvent.click(screen.getByRole("button", { name: /打招呼/ }));
    expect(textarea).toHaveValue("介绍你自己");
    // 预设没给 TOPIC：该 chip 仍是定义默认值
    expect(screen.getByRole("button", { name: /主题\s*季度报告/ })).toBeInTheDocument();
  });

  it("切换任务时草稿不串改（t1 编辑后打开 t2 显示 t2 的模板，切回 t1 仍是编辑后的值）", async () => {
    const { rerender } = await renderChat({ id: "t1", run: false });
    const textarea = await screen.findByPlaceholderText(/输入/);
    expect(textarea).toHaveValue("请处理 ${TOPIC}");
    fireEvent.change(textarea, { target: { value: "EDITED_ON_T1" } });
    expect(textarea).toHaveValue("EDITED_ON_T1");
    rerender(wrap({ id: "t2", run: false }));
    await settle();
    expect(screen.getByPlaceholderText(/输入/)).toHaveValue("T2_PROMPT");
    // t2 没有描述：空态显示提示语
    expect(screen.getByText("在下方输入提示词开始对话")).toBeInTheDocument();
    rerender(wrap({ id: "t1", run: false }));
    await settle();
    expect(screen.getByPlaceholderText(/输入/)).toHaveValue("EDITED_ON_T1");
  });

  it("定义里 prompt 为空：发送置灰，填入非空白内容后可发", async () => {
    await renderChat({ id: "t3", run: false });
    const textarea = await screen.findByPlaceholderText(/输入/);
    expect(textarea).toHaveValue("");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /系统提示词\s*未填/ })).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: "  " } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.change(textarea, { target: { value: "写一首诗" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("发送调用 RunAi：prompt/system 恒传，没改过的已声明参数不传", async () => {
    await renderChat({ run: false });
    const textarea = screen.getByPlaceholderText(/输入/);
    // 普通 Enter 不发送
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(mockRunAi).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(mockRunAi).toHaveBeenCalledTimes(1);
    expect(mockRunAi).toHaveBeenCalledWith("t1", { prompt: "请处理 ${TOPIC}", system: "你是助手" });
    // 发送后转运行态；输入框保留草稿
    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(textarea).toHaveValue("请处理 ${TOPIC}");
  });

  it("改过的声明参数与续接会话一并下发", async () => {
    await renderChat({ run: false });
    // 预设改了声明参数 TOPIC
    fireEvent.click(screen.getByRole("button", { name: /年报/ }));
    expect(screen.getByRole("button", { name: /主题\s*年度总结/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(mockRunAi).toHaveBeenLastCalledWith("t1", {
      prompt: "请处理 ${TOPIC}",
      system: "你是助手",
      TOPIC: "年度总结",
    });
    // 这一轮带回了会话 id → 落历史；点历史条目把它回填到续接 chip
    emitOut(1, "ai", "ok");
    emitDone(2, { readout: { sessionId: "sess-r9" } });
    fireEvent.click(await screen.findByRole("button", { name: "历史 · 1" }));
    const drawer = await screen.findByRole("complementary");
    fireEvent.click(within(drawer).getByText("请处理 年度总结"));
    fireEvent.click(screen.getByRole("button", { name: /返回当前/ }));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(mockRunAi).toHaveBeenCalledTimes(2);
    expect(mockRunAi).toHaveBeenLastCalledWith("t1", {
      prompt: "请处理 ${TOPIC}",
      system: "你是助手",
      TOPIC: "年度总结",
      resume: "sess-r9",
    });
  });

  it("⌘/Ctrl+Enter 发送", async () => {
    await renderChat({ run: false });
    fireEvent.keyDown(screen.getByPlaceholderText(/输入/), { key: "Enter", ctrlKey: true });
    expect(mockRunAi).toHaveBeenCalledTimes(1);
    // 运行中再按不重复起跑
    fireEvent.keyDown(screen.getByPlaceholderText(/输入/), { key: "Enter", metaKey: true });
    expect(mockRunAi).toHaveBeenCalledTimes(1);
    emitOut(1, "ai", "ok");
    emitDone(2);
    expect(await screen.findByRole("button", { name: "历史 · 1" })).toBeInTheDocument();
    // 上一轮收尾后：⌘Enter 起新一轮
    fireEvent.keyDown(screen.getByPlaceholderText(/输入/), { key: "Enter", metaKey: true });
    expect(mockRunAi).toHaveBeenCalledTimes(2);
  });

  it("RunAi 被拒（后端判正在运行）：会话页显示失败原因，不算一次运行、不落历史", async () => {
    mockRunAi.mockRejectedValue("任务正在运行");
    await renderChat();
    expect(await screen.findByText("运行失败")).toBeInTheDocument();
    expect(screen.getByText("任务正在运行")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "历史" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
  });

  it("失败时展示失败原因与诊断输出（stderr 带前缀）", async () => {
    await renderChat();
    emitOut(1, "stderr", "boom-line");
    emitOut(2, "stdout", "cli-version 1.0");
    emitDone(3, { exitCode: 1, err: "runner exited", duration: "0.3s" });
    expect(await screen.findByText("运行失败")).toBeInTheDocument();
    expect(screen.getByText("runner exited")).toBeInTheDocument();
    expect(screen.getByText("[stderr] boom-line")).toBeInTheDocument();
    expect(screen.getByText("cli-version 1.0")).toBeInTheDocument();
    expect(screen.queryByText("诊断输出")).not.toBeInTheDocument();
    expect(screen.getByText("· 0.3s")).toBeInTheDocument();
  });

  it("成功但 runner 往 stderr 写过：展示诊断输出", async () => {
    await renderChat();
    emitOut(1, "ai", "ok");
    emitOut(2, "stderr", "warn-line");
    emitDone(3);
    expect(await screen.findByRole("button", { name: "历史 · 1" })).toBeInTheDocument();
    expect(screen.getByText("诊断输出")).toBeInTheDocument();
    expect(screen.getByText("[stderr] warn-line")).toBeInTheDocument();
    expect(screen.queryByText("运行失败")).not.toBeInTheDocument();
  });

  it("成功且 runner 没写 stderr：不展示诊断块", async () => {
    await renderChat();
    emitOut(1, "stdout", "noise");
    emitOut(2, "ai", "ok");
    emitDone(3);
    expect(await screen.findByRole("button", { name: "历史 · 1" })).toBeInTheDocument();
    expect(screen.queryByText("诊断输出")).not.toBeInTheDocument();
    expect(screen.queryByText("运行失败")).not.toBeInTheDocument();
    expect(screen.queryByText("noise")).not.toBeInTheDocument();
  });

  it("点标题进该任务的 YAML 编辑页；返回钮回到 AI 任务网格", async () => {
    await renderChat({ run: false });
    fireEvent.click(screen.getByRole("button", { name: "任务一" }));
    expect(screen.getByTestId("view-probe")).toHaveTextContent("ai-edit");
    fireEvent.click(screen.getByRole("button", { name: "返回 AI 任务" }));
    expect(screen.getByTestId("view-probe")).toHaveTextContent("ai-grid");
  });

  it("当前项不是 AI 任务时不渲染", async () => {
    mockListAiTasks.mockResolvedValue({ tasks: [], errors: [] });
    const { container } = render(
      <ActionRunnerProvider>
        <SidebarProvider>
          <AiChatView />
        </SidebarProvider>
      </ActionRunnerProvider>,
    );
    await settle();
    expect(container.querySelector("main")).toBeNull();
    expect(screen.queryByPlaceholderText(/输入/)).not.toBeInTheDocument();
  });
});
