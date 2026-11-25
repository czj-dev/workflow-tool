import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockSaveSchedule, mockListAiTasks, mockListActions, mockListWorkflows } = vi.hoisted(() => ({
  mockSaveSchedule: vi.fn<(input: unknown) => Promise<unknown>>(),
  mockListAiTasks: vi.fn<() => Promise<unknown>>(),
  mockListActions: vi.fn<() => Promise<unknown>>(),
  mockListWorkflows: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: mockListActions,
  ListAiTasks: mockListAiTasks,
  RunAi: vi.fn(),
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
  ListWorkflows: mockListWorkflows,
  ListSchedules: vi.fn().mockResolvedValue({ schedules: [], errors: [] }),
  SaveSchedule: mockSaveSchedule,
  ListRuns: vi.fn().mockResolvedValue({ runs: [] }),
  GetRun: vi.fn(),
  GetRunEvents: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => ({}) } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import { ScheduleFormSheet, type ScheduleFormValue } from "./ScheduleFormSheet";

// 调度编辑器的开关状态在 Provider：用真实的 Provider 驱动，Harness 负责按下按钮打开它
// （调度页的「新增 / 编辑」与 AI 卡的「定时」入口都是这样调 openScheduleForm 的）。
type Lock = { kind: ScheduleFormValue["targetKind"]; id: string };

function renderEditor() {
  function Harness({ seed, creating, lock }: { seed: ScheduleFormValue; creating: boolean; lock?: Lock }) {
    const { openScheduleForm, toggleFragments } = useActionRunner();
    return (
      <>
        <button type="button" onClick={() => openScheduleForm(seed, creating, lock)}>open-editor</button>
        <button type="button" onClick={toggleFragments}>toggle-fragments</button>
        <ScheduleFormSheet />
      </>
    );
  }
  const utils = render(
    <ActionRunnerProvider>
      <SidebarProvider>
        <Harness seed={FRESH} creating />
      </SidebarProvider>
    </ActionRunnerProvider>,
  );
  return {
    ...utils,
    // 换一份初值重新打开（key 随之变化，草稿重置）
    openWith: (seed: ScheduleFormValue, creating: boolean, lock?: Lock) =>
      utils.rerender(
        <ActionRunnerProvider>
          <SidebarProvider>
            <Harness seed={seed} creating={creating} lock={lock} />
          </SidebarProvider>
        </ActionRunnerProvider>,
      ),
  };
}

const FRESH: ScheduleFormValue = {
  id: "schedule-auto", name: "", enabled: true, cron: "0 9 * * 1-5", targetKind: "action", targetId: "build", params: {},
};

const EDIT: ScheduleFormValue = {
  id: "nightly-build", name: "Nightly build", enabled: true, cron: "0 2 * * *", targetKind: "action", targetId: "build",
  params: { BRANCH: "main" },
};

const aiTask = {
  id: "review-bot", title: "代码审查", icon: "", description: "", color: "", timeout: "30m0s", prompt: "", system: "",
  presets: [],
  params: [{ id: "TOPIC", label: "主题", type: "text", required: false, default: "", options: [], description: undefined }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSaveSchedule.mockResolvedValue({ schedules: [], errors: [] });
  mockListActions.mockResolvedValue({
    actions: [{ id: "build", title: "Build", icon: "", description: "", color: "", params: [], presets: [], stream: "" }],
    errors: [],
  });
  mockListWorkflows.mockResolvedValue({
    workflows: [{ id: "deploy", title: "Deploy", icon: "", description: "", color: "", params: [], steps: [] }],
    errors: [],
  });
  mockListAiTasks.mockResolvedValue({ tasks: [aiTask], errors: [] });
});

async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "open-editor" }));
  return screen.getByRole("dialog");
}

describe("ScheduleFormSheet", () => {
  it("opens a left sheet showing the id and saves parsed object parameters", async () => {
    const user = userEvent.setup();
    renderEditor();
    const sheet = await openEditor(user);

    expect(sheet).toHaveAttribute("data-side", "left");
    expect(screen.getByText("id · schedule-auto")).toBeInTheDocument();
    await user.type(screen.getByLabelText("名称"), "Morning build");
    fireEvent.change(screen.getByLabelText("参数 JSON"), { target: { value: '{"BRANCH":"main"}' } });
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(mockSaveSchedule).toHaveBeenCalledWith(expect.objectContaining({
      id: "schedule-auto",
      name: "Morning build",
      enabled: true,
      cron: "0 9 * * 1-5",
      targetKind: "action",
      targetId: "build",
      params: { BRANCH: "main" },
    }));
  });

  // 补跑默认关；表单里打开后随调度保存。
  it("catch-up is off unless switched on, and is saved once switched on", async () => {
    const user = userEvent.setup();
    const { openWith } = renderEditor();
    openWith(EDIT, false);
    await openEditor(user);
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(mockSaveSchedule).toHaveBeenLastCalledWith(expect.objectContaining({ catchUp: false }));

    await user.click(screen.getByRole("switch", { name: /补跑/ }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(mockSaveSchedule).toHaveBeenLastCalledWith(expect.objectContaining({ catchUp: true }));
  });

  // 编辑一条开了补跑的调度：开关如实反映现值，保存时保留。
  it("editing a schedule that catches up keeps it on", async () => {
    const user = userEvent.setup();
    const { openWith } = renderEditor();
    openWith({ ...EDIT, catchUp: true }, false);
    await openEditor(user);
    expect(screen.getByRole("switch", { name: /补跑/ })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(mockSaveSchedule).toHaveBeenLastCalledWith(expect.objectContaining({ catchUp: true }));
  });

  it("serializes edited dial tokens without changing other cron fields", async () => {
    const user = userEvent.setup();
    const { openWith } = renderEditor();
    openWith({ ...EDIT, cron: "5,10-12 8-10 1,15 1,6 1-5" }, false);
    await openEditor(user);

    expect(screen.getByText("id · nightly-build")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "小时 9" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "星期几 周一" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "分钟 30" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(mockSaveSchedule).toHaveBeenCalledWith(expect.objectContaining({
      id: "nightly-build",
      cron: "5,10,11,12,30 8,9,10 1,15 1,6 1,2,3,4,5",
    }));
  });

  it("applies a pattern chip and saves its cron expression", async () => {
    const user = userEvent.setup();
    renderEditor();
    await openEditor(user);

    await user.click(screen.getByRole("button", { name: "每小时 每小时第 30 分" }));
    expect(screen.getByText("每小时 :30")).toBeInTheDocument();
    await user.type(screen.getByLabelText("名称"), "Hourly cleanup");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(mockSaveSchedule).toHaveBeenCalledWith(expect.objectContaining({ cron: "30 * * * *" }));
  });

  it("preserves the original cron expression when editing other fields", async () => {
    const user = userEvent.setup();
    const { openWith } = renderEditor();
    openWith({ ...EDIT, cron: "05   08 * * 1-5" }, false);
    await openEditor(user);

    await user.clear(screen.getByLabelText("名称"));
    await user.type(screen.getByLabelText("名称"), "Morning build");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(mockSaveSchedule).toHaveBeenCalledWith(expect.objectContaining({
      id: "nightly-build",
      name: "Morning build",
      cron: "05   08 * * 1-5",
    }));
  });

  it("rejects empty cron selections and permits a visual correction", async () => {
    const user = userEvent.setup();
    renderEditor();
    await openEditor(user);
    await user.type(screen.getByLabelText("名称"), "Morning build");

    await user.click(screen.getByRole("button", { name: "分钟 0" }));
    expect(screen.getByRole("button", { name: "分钟 0" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("至少为每个字段选择一个值")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(mockSaveSchedule).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "分钟 30" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(mockSaveSchedule).toHaveBeenCalledWith(expect.objectContaining({ cron: "30 9 * * 1,2,3,4,5" }));
  });

  it("uses the full viewport width when opened on mobile", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    try {
      const user = userEvent.setup();
      renderEditor();
      await openEditor(user);
      await waitFor(() => expect(screen.getByRole("dialog")).toHaveStyle({ left: "0px", right: "0px" }));
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    }
  });

  it("keeps mobile sheets from covering each other without losing the draft", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    try {
      const user = userEvent.setup();
      renderEditor();
      await openEditor(user);
      await user.type(screen.getByLabelText("名称"), "Unfinished schedule");

      // 片段抽屉打开：调度编辑器让位
      await user.click(screen.getByRole("button", { name: "toggle-fragments" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await user.click(screen.getByRole("button", { name: "toggle-fragments" }));
      // 同一份草稿重现，没填完的内容还在
      expect(screen.getByLabelText("名称")).toHaveValue("Unfinished schedule");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    }
  });

  it("rejects invalid JSON without calling save", async () => {
    const user = userEvent.setup();
    renderEditor();
    await openEditor(user);
    fireEvent.change(screen.getByLabelText("参数 JSON"), { target: { value: "{oops" } });
    expect(screen.getByText("需为合法 JSON 对象")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByRole("alert")).toHaveTextContent("参数必须是有效的 JSON 对象");
    expect(mockSaveSchedule).not.toHaveBeenCalled();
  });

  it("edits an existing schedule with its current values", async () => {
    const user = userEvent.setup();
    const { openWith } = renderEditor();
    openWith(EDIT, false);
    await openEditor(user);

    expect(screen.getByText("id · nightly-build")).toBeInTheDocument();
    expect(screen.getByLabelText("名称")).toHaveValue("Nightly build");
    expect(screen.getByLabelText("参数 JSON")).toHaveValue('{\n  "BRANCH": "main"\n}');
  });

  it("closing and reopening resets the draft from the new seed", async () => {
    const user = userEvent.setup();
    const { openWith } = renderEditor();
    await openEditor(user);
    await user.type(screen.getByLabelText("名称"), "Unfinished schedule");
    await user.click(screen.getByRole("button", { name: "关闭调度表单" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    openWith(EDIT, false);
    await openEditor(user);
    expect(screen.getByLabelText("名称")).toHaveValue("Nightly build");
  });

  // —— AI 任务是第三种调度目标（M2）：结构化输入 + 目标锁定 ——

  const aiSeed: ScheduleFormValue = {
    id: "nightly-review", name: "代码审查", enabled: true, cron: "0 2 * * *", targetKind: "ai", targetId: "review-bot", params: {},
  };

  it("AI target: structured inputs instead of a JSON box — declared params plus prompt / system", async () => {
    const user = userEvent.setup();
    const { openWith } = renderEditor();
    openWith(aiSeed, true, { kind: "ai", id: "review-bot" });
    await openEditor(user);

    // 从任务卡进来：标题点名任务，目标锁定（种类按钮不可改，目标只列这一项）
    expect(screen.getByText("为 代码审查 新建调度")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "动作" })[0]).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "AI 任务" })[0]).toBeDisabled();
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(screen.getByRole("radio", { name: /代码审查/ })).toHaveAttribute("aria-checked", "true");

    // 没有 JSON 框；有任务的已声明参数与两个保留运行参数
    expect(screen.queryByLabelText("参数 JSON")).not.toBeInTheDocument();
    expect(screen.getByLabelText("主题")).toBeInTheDocument();
    expect(screen.getByLabelText("提示词（prompt）")).toBeInTheDocument();
    expect(screen.getByLabelText("系统提示词（system）")).toBeInTheDocument();

    await user.type(screen.getByLabelText("主题"), "crash");
    // 含 ${VAR} 的文本直接设值：user.type 会把花括号当成它自己的特殊键语法
    fireEvent.change(screen.getByLabelText("提示词（prompt）"), { target: { value: "只分析崩溃线程，卡片：${TOPIC}" } });
    // system 留空 = 不传，运行时用任务自己的模板
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(mockSaveSchedule).toHaveBeenCalledWith(expect.objectContaining({
      targetKind: "ai",
      targetId: "review-bot",
      params: { TOPIC: "crash", prompt: "只分析崩溃线程，卡片：${TOPIC}" },
    }));
    const saved = mockSaveSchedule.mock.calls[0][0] as { params: Record<string, unknown> };
    expect(saved.params).not.toHaveProperty("system");

  });

  it("AI target: existing params come back into their inputs, including the reserved ones", async () => {
    const user = userEvent.setup();
    const { openWith } = renderEditor();
    openWith({ ...aiSeed, params: { TOPIC: "crash", prompt: "只看崩溃线程", system: "你是分析员" } }, false);
    await openEditor(user);

    expect(screen.getByLabelText("主题")).toHaveValue("crash");
    expect(screen.getByLabelText("提示词（prompt）")).toHaveValue("只看崩溃线程");
    expect(screen.getByLabelText("系统提示词（system）")).toHaveValue("你是分析员");
    expect(screen.getByText("id · nightly-review")).toBeInTheDocument();
  });

  it("unlocked: switching target kind or target clears the parameters", async () => {
    const user = userEvent.setup();
    const { openWith } = renderEditor();
    openWith(EDIT, false);
    await openEditor(user);

    await user.click(screen.getAllByRole("button", { name: "工作流" })[0]);
    expect(screen.queryByLabelText("参数 JSON")).toHaveValue("{}");
    expect(screen.getByRole("radio", { name: /Deploy/ })).toHaveAttribute("aria-checked", "true");

    fireEvent.change(screen.getByLabelText("参数 JSON"), { target: { value: '{"A":1}' } });
    await user.click(screen.getAllByRole("button", { name: "AI 任务" })[0]);
    expect(screen.getByRole("radio", { name: /代码审查/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("主题")).toHaveValue("");
  });

  it("changing the target of the same kind also starts from empty params", async () => {
    mockListWorkflows.mockResolvedValue({
      workflows: [
        { id: "deploy", title: "Deploy", icon: "", description: "", color: "", params: [], steps: [] },
        { id: "release", title: "Release", icon: "", description: "", color: "", params: [], steps: [] },
      ],
      errors: [],
    });
    const user = userEvent.setup();
    const { openWith } = renderEditor();
    openWith({ ...EDIT, targetKind: "workflow", targetId: "deploy", params: { A: 1 } }, false);
    await openEditor(user);
    expect(screen.getByLabelText("参数 JSON")).toHaveValue("{\n  \"A\": 1\n}");

    await user.click(screen.getByRole("radio", { name: /Release/ }));
    expect(screen.getByLabelText("参数 JSON")).toHaveValue("{}");
  });
});
