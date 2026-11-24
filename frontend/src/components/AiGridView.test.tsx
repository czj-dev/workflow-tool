import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockListAiTasks, mockRunAi, mockOn, mockListSchedules, listeners } = vi.hoisted(() => {
  // 与 Provider 测试同一套：Events.On 记下回调，用例经 listeners 触发应用级事件
  const listeners: Record<string, (e: unknown) => void> = {};
  return {
    mockListAiTasks: vi.fn(),
    mockRunAi: vi.fn(),
    mockListSchedules: vi.fn(),
    mockOn: vi.fn((name: string, cb: (e: unknown) => void) => {
      listeners[name] = cb;
      return () => { delete listeners[name]; };
    }),
    listeners,
  };
});

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  ListAiTasks: mockListAiTasks,
  RunAi: mockRunAi,
  CancelAi: vi.fn(),
  GetAiYaml: vi.fn().mockResolvedValue(""),
  SetAiYaml: vi.fn().mockResolvedValue({ tasks: [], errors: [] }),
  RunAction: vi.fn(),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn(),
  GetFragments: vi.fn().mockResolvedValue([]),
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: vi.fn(),
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  ListSchedules: mockListSchedules,
  ListRuns: vi.fn().mockResolvedValue({ runs: [] }),
  GetRun: vi.fn(),
  GetRunEvents: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ActionRunnerProvider, _emitForTest } from "../context/ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import { AiGridView } from "./AiGridView";

// 暴露 provider 内部 view / 当前任务草稿 / 调度编辑器状态：断言卡面动作的路由与预填。
function ViewProbe() {
  const { view, aiDraft, scheduleEditor, currentRunId } = useActionRunner();
  return (
    <>
      <div data-testid="view-probe">{view}</div>
      <div data-testid="draft-probe">{JSON.stringify(aiDraft)}</div>
      <div data-testid="editor-probe">{JSON.stringify(scheduleEditor)}</div>
      <div data-testid="run-probe">{currentRunId ?? ""}</div>
    </>
  );
}

const mkAiTask = (extra: Record<string, unknown> = {}) => ({
  id: "ai-x",
  title: "翻译助手",
  icon: "",
  description: "把内容翻成中文",
  color: "",
  params: [
    {
      id: "TEXT",
      label: "原文",
      type: "text",
      required: false,
      default: "hello",
      options: [],
      description: undefined,
    },
  ],
  // 预设值用保留键 prompt（任务的提示词模板）：稀疏预设只覆写给出的键
  presets: [{ name: "日常", description: "", values: { prompt: "翻译这段" } }],
  prompt: "把以下内容翻成中文：${TEXT}",
  system: "你是翻译",
  timeout: "",
  lastRun: null,
  ...extra,
});

// ❝区摘要源：该任务最近一次运行（后端运行记录，随任务列表下发）。
const lastRunOf = (prompt: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  id: "r20261125-021500-a1b2c3",
  targetKind: "ai",
  targetId: "ai-x",
  origin: "manual",
  scheduleId: "",
  status: "succeeded",
  reason: "",
  startedAt: "2026-11-25T02:15:00+08:00",
  finishedAt: "2026-11-25T02:15:04+08:00",
  exitCode: 0,
  params: { prompt, ...params },
  outputs: { session_id: "sess-1" },
  ...extra,
});


const draft = () => JSON.parse(screen.getByTestId("draft-probe").textContent ?? "null");
const FULL_DRAFT = {
  prompt: "把以下内容翻成中文：${TEXT}",
  system: "你是翻译",
  resume: "",
  TEXT: "hello",
};
const SENT_PARAMS = { prompt: "把以下内容翻成中文：${TEXT}", system: "你是翻译" };

beforeEach(() => {
  mockListAiTasks.mockReset().mockResolvedValue({ tasks: [mkAiTask()], errors: [] });
  mockRunAi.mockReset().mockResolvedValue(undefined);
  mockOn.mockClear();
  mockListSchedules.mockReset().mockResolvedValue({ schedules: [], errors: [] });
  localStorage.clear();
});

function wrap() {
  return (
    <ActionRunnerProvider>
      <SidebarProvider>
        <AiGridView />
        <ViewProbe />
      </SidebarProvider>
    </ActionRunnerProvider>
  );
}

describe("AiGridView", () => {
  it("单击卡片就地展开，❝区显示最近一次运行的摘要(按当次输入展开变量)", async () => {
    const user = userEvent.setup();
    mockListAiTasks.mockResolvedValue({
      tasks: [mkAiTask({ lastRun: lastRunOf("总结 ${TOPIC}", { TOPIC: "季度报告" }) })],
      errors: [],
    });
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    expect(card).toHaveAttribute("aria-expanded", "false");
    await user.click(card);
    expect(card).toHaveAttribute("aria-expanded", "true");
    // prompt 的 ${TOPIC} 用会话 params 展开
    expect(screen.getByText(/季度报告/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /对话/ })).toBeInTheDocument();
  });

  it("无会话时❝区回落描述", async () => {
    const user = userEvent.setup();
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(card);
    expect(screen.getByText(/把内容翻成中文/)).toBeInTheDocument();
  });

  it("次级动作「对话」进入该任务的会话页（空态，草稿按定义预填）", async () => {
    const user = userEvent.setup();
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(card);
    await user.click(within(card).getByRole("button", { name: /对话/ }));
    expect(screen.getByTestId("view-probe")).toHaveTextContent("ai-chat");
    expect(draft()).toEqual(FULL_DRAFT);
  });

  it("紧凑态「▸ 运行」后台起跑：视图不动、卡面转运行徽标；运行中点卡身回到会话页(不展开)", async () => {
    const user = userEvent.setup();
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    expect(card).not.toHaveAttribute("data-running");
    await user.click(within(card).getByRole("button", { name: /运行/ }));
    expect(mockRunAi).toHaveBeenCalledTimes(1);
    expect(mockRunAi).toHaveBeenCalledWith("ai-x", SENT_PARAMS);
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
    expect(card).toHaveAttribute("data-running");
    expect(within(card).getByRole("button", { name: "运行中 ▸" })).toBeInTheDocument();
    // 读数态仍可点：点卡身 = 回到会话页回放这一轮，不展开
    await user.click(card);
    expect(card).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("view-probe")).toHaveTextContent("ai-chat");
  });

  it("YAML color 字段优先于组序循环注入 --amb", async () => {
    mockListAiTasks.mockResolvedValue({
      tasks: [mkAiTask(), mkAiTask({ id: "ai-green", title: "绿聊", color: "green" })],
      errors: [],
    });
    render(wrap());
    const plain = await screen.findByRole("button", { name: "翻译助手" });
    const green = screen.getByRole("button", { name: "绿聊" });
    // 同组（ai，组序 0=amber）：未写 color 回落组循环，写了用逐卡 token
    expect(plain.style.getPropertyValue("--amb")).toBe("var(--amb-amber)");
    expect(green.style.getPropertyValue("--amb")).toBe("var(--amb-green)");
  });

  it("chips 带预设进对话(预填 preset 值，不起跑)", async () => {
    const user = userEvent.setup();
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(card);
    await user.click(within(card).getByRole("button", { name: /日常/ }));
    expect(screen.getByTestId("view-probe")).toHaveTextContent("ai-chat");
    // 稀疏预设只覆写 prompt：没给的键保留定义默认值
    expect(draft()).toEqual({ ...FULL_DRAFT, prompt: "翻译这段" });
    expect(mockRunAi).not.toHaveBeenCalled();
  });

  it("展开态主控「运行」：后台运行，不切视图，主钮转读数态、❝区切实时摘要", async () => {
    const user = userEvent.setup();
    mockListAiTasks.mockResolvedValue({
      tasks: [mkAiTask({ lastRun: lastRunOf("总结 ${TOPIC}", { TOPIC: "季度报告" }) })],
      errors: [],
    });
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(card);
    await user.click(within(card).getByRole("button", { name: /运行/ }));
    expect(mockRunAi).toHaveBeenCalledWith("ai-x", SENT_PARAMS);
    expect(card).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
    // 主钮不再是按钮（不可再点），转为运行读数；❝区从运行记录摘要切到实时文案
    expect(within(card).queryByRole("button", { name: /运行/ })).not.toBeInTheDocument();
    expect(within(card).getByText("运行中")).toBeInTheDocument();
    expect(screen.getByText(/正在生成回复/)).toBeInTheDocument();
    expect(screen.queryByText(/季度报告/)).not.toBeInTheDocument();
  });

  it("「编辑配置」直达该任务的 YAML 编辑页", async () => {
    const user = userEvent.setup();
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(card);
    await user.click(within(card).getByRole("button", { name: "编辑配置" }));
    expect(screen.getByTestId("view-probe")).toHaveTextContent("ai-edit");
    // 编辑器以 currentId 初始化：该任务已是当前项
    expect(draft()).toEqual(FULL_DRAFT);
  });

  it("提示词为空的任务：运行改为进入对话页", async () => {
    const user = userEvent.setup();
    mockListAiTasks.mockResolvedValue({
      tasks: [mkAiTask({ id: "ai-blank", title: "空提示词", prompt: "" })],
      errors: [],
    });
    render(wrap());
    const card = await screen.findByRole("button", { name: "空提示词" });
    await user.click(within(card).getByRole("button", { name: /运行/ }));
    expect(mockRunAi).not.toHaveBeenCalled();
    expect(screen.getByTestId("view-probe")).toHaveTextContent("ai-chat");
  });

  it("后台运行结束后，后端的 runs:changed 让卡面摘要读到这一轮的运行记录", async () => {
    const user = userEvent.setup();
    // 挂载时还没有运行记录；运行结束后后端落盘并广播，任务列表随之带上最近一次运行
    mockListAiTasks.mockResolvedValue({ tasks: [mkAiTask()], errors: [] });
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(within(card).getByRole("button", { name: /运行/ }));
    act(() => {
      _emitForTest("ai:ai-x:done", { data: { exitCode: 0, err: "", duration: "2s", seq: 1 } });
    });
    expect(card).not.toHaveAttribute("data-running");

    mockListAiTasks.mockResolvedValue({
      tasks: [mkAiTask({ lastRun: lastRunOf("把以下内容翻成中文：${TEXT}", { TEXT: "hello" }) })],
      errors: [],
    });
    await act(async () => {
      listeners["runs:changed"]?.({ data: { run_id: "r20261125-021500-a1b2c3", status: "succeeded" } });
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    await user.click(card);
    expect(screen.getByText(/把以下内容翻成中文：hello/)).toBeInTheDocument();
  });

  // —— 调度投影（M2）：AI 卡显示其所属调度的 cron、启停、最近结果，并提供「定时」入口 ———

  const aiSchedule = (extra: Record<string, unknown> = {}) => ({
    id: "nightly-review",
    name: "夜间审查",
    enabled: true,
    cron: "0 2 * * *",
    targetKind: "ai",
    targetId: "ai-x",
    params: {},
    nextRun: "2026-11-26T02:00:00+08:00",
    running: false,
    lastRun: null,
    ...extra,
  });

  it("卡面显示所属调度的投影：紧凑态一行 cron，展开态每条调度一行（启停 + 最近结果）", async () => {
    const user = userEvent.setup();
    mockListSchedules.mockResolvedValue({
      schedules: [
        aiSchedule(),
        aiSchedule({ id: "weekly-review", name: "每周审查", cron: "0 9 * * 1", enabled: false,
          lastRun: { status: "succeeded", startedAt: "", finishedAt: "", duration: "4s", error: "", runId: "r-weekly" } }),
      ],
      errors: [],
    });
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    // 紧凑态：第一条调度的句子 + 其余条数
    expect(within(card).getByText("每天 02:00")).toBeInTheDocument();
    expect(within(card).getByText("+1")).toBeInTheDocument();

    await user.click(card);
    expect(within(card).getByText("每周一 09:00")).toBeInTheDocument();
    expect(within(card).getByText("已启用")).toBeInTheDocument();
    expect(within(card).getByText("已停用")).toBeInTheDocument();
    // 最近结果（时长）进运行详情——按钮的文本是读数，title 不参与可访问名
    await user.click(within(card).getByRole("button", { name: "4s" }));
    expect(screen.getByTestId("view-probe")).toHaveTextContent("run-detail");
    expect(screen.getByTestId("run-probe")).toHaveTextContent("r-weekly");
  });

  it("同一任务的多条调度互不混淆：只显示指向它的，别的任务的调度不出现", async () => {
    const user = userEvent.setup();
    mockListSchedules.mockResolvedValue({
      schedules: [aiSchedule(), aiSchedule({ id: "other", name: "别人的", targetId: "ai-other", cron: "30 * * * *" })],
      errors: [],
    });
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(card);
    expect(within(card).getByText("每天 02:00")).toBeInTheDocument();
    expect(within(card).queryByText("每小时 :30")).not.toBeInTheDocument();
    expect(within(card).queryByText("+1")).not.toBeInTheDocument();
  });

  it("「定时」：打开调度编辑器，目标锁定为该任务", async () => {
    const user = userEvent.setup();
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(card);
    await user.click(within(card).getByRole("button", { name: "定时" }));

    const editor = JSON.parse(screen.getByTestId("editor-probe").textContent ?? "null");
    expect(editor).toMatchObject({ creating: true, lock: { kind: "ai", id: "ai-x" } });
    expect(editor.value).toMatchObject({ name: "翻译助手", enabled: true, cron: "0 9 * * 1-5", targetKind: "ai", targetId: "ai-x", params: {} });
    expect(editor.value.id).toMatch(/^schedule-[a-z0-9-]+$/);
  });

  it("点一条调度投影即编辑该调度（现值原样进编辑器）", async () => {
    const user = userEvent.setup();
    mockListSchedules.mockResolvedValue({ schedules: [aiSchedule({ params: { TEXT: "report" } })], errors: [] });
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(card);
    // 行身可点 = 编辑这条调度（按钮文本是 cron 句子 + 启停）
    await user.click(within(card).getByRole("button", { name: /每天 02:00/ }));

    const editor = JSON.parse(screen.getByTestId("editor-probe").textContent ?? "null");
    expect(editor.creating).toBe(false);
    // 从调度投影进来是编辑既有调度：目标不锁定
    expect(editor.lock).toBeUndefined();
    expect(editor.value).toMatchObject({ id: "nightly-review", name: "夜间审查", cron: "0 2 * * *", targetKind: "ai", targetId: "ai-x", params: { TEXT: "report" } });
  });

  it("调度发起的运行同样让卡片进入运行态；点卡身去那条运行的详情实时跟踪", async () => {
    const user = userEvent.setup();
    // 调度发起的运行：后端在最近结果里带着运行中的那条记录 id
    mockListSchedules.mockResolvedValue({
      schedules: [aiSchedule({ running: true, lastRun: { status: "running", startedAt: "", finishedAt: "", duration: "", error: "", runId: "r-live" } })],
      errors: [],
    });
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await waitFor(() => expect(card).toHaveAttribute("data-running", "true"));
    expect(screen.getByText("运行中 ▸")).toBeInTheDocument();
    // 前端没有这一轮的输出捕获：不展开、也不开空会话页，而是进运行详情
    await user.click(card);
    expect(card).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("view-probe")).toHaveTextContent("run-detail");
    expect(screen.getByTestId("run-probe")).toHaveTextContent("r-live");
  });

  it("无 AI 任务时显示空态；加载错误以 Alert 逐条展示", async () => {
    mockListAiTasks.mockResolvedValue({ tasks: [], errors: ["ai/broken.yaml: 未知字段 llm"] });
    render(wrap());
    expect(await screen.findByText(/无 AI 任务/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("ai/broken.yaml: 未知字段 llm");
    expect(screen.queryByRole("button", { name: "翻译助手" })).not.toBeInTheDocument();
  });

  it("加载错误与任务并存时都显示", async () => {
    mockListAiTasks.mockResolvedValue({ tasks: [mkAiTask()], errors: ["ai/broken.yaml: 预设引用了未声明的参数"] });
    render(wrap());
    expect(await screen.findByRole("button", { name: "翻译助手" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("ai/broken.yaml: 预设引用了未声明的参数");
    expect(screen.queryByText(/无 AI 任务/)).not.toBeInTheDocument();
  });

  it("键盘：卡片上 Enter 展开、Escape 收起", async () => {
    const user = userEvent.setup();
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    card.focus();
    await user.keyboard("{Enter}");
    expect(card).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(card).toHaveAttribute("aria-expanded", "false");
  });
});
