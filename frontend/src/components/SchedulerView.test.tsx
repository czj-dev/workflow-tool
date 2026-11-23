import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockRunner } = vi.hoisted(() => ({
  mockRunner: {
    schedules: [],
    scheduleErrors: [],
    actions: [{ id: "build", title: "Build" }],
    workflows: [{ id: "deploy", title: "Deploy" }],
    fragmentsOpen: false,
    setFragmentsOpen: vi.fn(),
    setFormSheetOpen: vi.fn(),
    saveSchedule: vi.fn(() => Promise.resolve()),
    deleteSchedule: vi.fn(() => Promise.resolve()),
    setScheduleEnabled: vi.fn(() => Promise.resolve()),
    runScheduleNow: vi.fn(() => Promise.resolve()),
  },
})) as { mockRunner: MockRunner };

vi.mock("../hooks/useActionRunner", () => ({
  useActionRunner: () => mockRunner,
}));

import { SidebarProvider } from "@/components/ui/sidebar";
import { SchedulerView } from "./SchedulerView";

type MockSchedule = {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  targetKind: string;
  targetId: string;
  params: Record<string, unknown>;
  nextRun: string;
  running: boolean;
  lastRun: {
    status: string;
    startedAt: string;
    finishedAt: string;
    duration: string;
    error: string;
  } | null;
};

type MockRunner = {
  schedules: MockSchedule[];
  scheduleErrors: string[];
  actions: Array<{ id: string; title: string }>;
  workflows: Array<{ id: string; title: string }>;
  fragmentsOpen: boolean;
  setFragmentsOpen: (open: boolean) => void;
  setFormSheetOpen: (open: boolean) => void;
  saveSchedule: (input: unknown) => Promise<void>;
  deleteSchedule: (id: string) => Promise<void>;
  setScheduleEnabled: (id: string, enabled: boolean) => Promise<void>;
  runScheduleNow: (id: string) => Promise<void>;
};

const schedule: MockSchedule = {
  id: "nightly-build",
  name: "Nightly build",
  enabled: true,
  cron: "0 2 * * *",
  targetKind: "action",
  targetId: "build",
  params: { BRANCH: "main" },
  nextRun: "2026-11-13T02:00:00Z",
  running: false,
  lastRun: {
    status: "success",
    startedAt: "2026-11-12T02:00:00Z",
    finishedAt: "2026-11-12T02:00:04Z",
    duration: "4s",
    error: "",
  },
};

function renderView() {
  return render(
    <SidebarProvider>
      <SchedulerView />
    </SidebarProvider>,
  );
}

async function expandCard(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name }));
}

async function openEditSheet(user: ReturnType<typeof userEvent.setup>, cardName: string) {
  await expandCard(user, cardName);
  await user.click(screen.getByRole("button", { name: "编辑" }));
  return screen.getByRole("dialog");
}

beforeEach(() => {
  mockRunner.schedules = [];
  mockRunner.scheduleErrors = [];
  mockRunner.actions = [{ id: "build", title: "Build" }];
  mockRunner.workflows = [{ id: "deploy", title: "Deploy" }];
  mockRunner.fragmentsOpen = false;
  vi.clearAllMocks();
});

describe("SchedulerView", () => {
  it("renders the empty state and diagnostics", () => {
    mockRunner.scheduleErrors = ["invalid cron in nightly.yaml"];
    renderView();

    expect(screen.getByRole("heading", { name: "调度" })).toBeInTheDocument();
    expect(screen.getByText("暂无调度任务")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("invalid cron in nightly.yaml");
  });

  it("groups cards by target kind, shows the sentence and omits empty groups", async () => {
    const user = userEvent.setup();
    mockRunner.schedules = [
      schedule,
      { ...schedule, id: "deploy-nightly", name: "Deploy nightly", targetKind: "workflow", targetId: "deploy",
        lastRun: { ...schedule.lastRun!, status: "failed", duration: "495.555291ms" } },
    ];
    renderView();

    expect(screen.getByText("动作调度")).toBeInTheDocument();
    expect(screen.getByText("工作流调度")).toBeInTheDocument();
    expect(screen.getAllByText("每天 02:00").length).toBe(2);
    // 后端全精度时长串归一为统一读数（495.555291ms → 0.5s）
    expect(screen.getByText("0.5s")).toBeInTheDocument();
    expect(screen.getAllByText("1 项 · 1 启用").length).toBe(2);
    await expandCard(user, "Nightly build");
    expect(screen.getByRole("button", { name: "Nightly build" })).toHaveAttribute("aria-expanded", "true");
  });

  it("opens a left sheet with an automatic ID and saves parsed object parameters", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole("button", { name: "新增" }));

    const sheet = screen.getByRole("dialog");
    expect(sheet).toHaveAttribute("data-side", "left");
    expect(screen.getByText(/^id · schedule-[a-z0-9-]+$/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("名称"), "Morning build");
    fireEvent.change(screen.getByLabelText("参数 JSON"), { target: { value: '{"BRANCH":"main"}' } });
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(mockRunner.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^schedule-[a-z0-9-]+$/),
      name: "Morning build",
      enabled: true,
      cron: "0 9 * * 1-5",
      targetKind: "action",
      targetId: "build",
      params: { BRANCH: "main" },
    }));
  });

  it("serializes edited dial tokens without changing other cron fields", async () => {
    const user = userEvent.setup();
    mockRunner.schedules = [{ ...schedule, cron: "5,10-12 8-10 1,15 1,6 1-5" }];
    renderView();
    expect(screen.queryByText("工作流调度")).not.toBeInTheDocument();

    await openEditSheet(user, "Nightly build");
    expect(screen.getByText("id · nightly-build")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "小时 9" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "星期几 周一" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "分钟 30" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(mockRunner.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({
      id: "nightly-build",
      cron: "5,10,11,12,30 8,9,10 1,15 1,6 1,2,3,4,5",
    }));
  });

  it("applies a pattern chip and saves its cron expression", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole("button", { name: "新增" }));

    await user.click(screen.getByRole("button", { name: "每小时 每小时第 30 分" }));
    expect(screen.getByText("每小时 :30")).toBeInTheDocument();
    await user.type(screen.getByLabelText("名称"), "Hourly cleanup");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(mockRunner.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({ cron: "30 * * * *" }));
  });

  it("preserves the original cron expression when editing other fields", async () => {
    const user = userEvent.setup();
    mockRunner.schedules = [{ ...schedule, cron: "05   08 * * 1-5" }];
    renderView();
    await openEditSheet(user, "Nightly build");

    await user.clear(screen.getByLabelText("名称"));
    await user.type(screen.getByLabelText("名称"), "Morning build");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(mockRunner.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({
      id: "nightly-build",
      name: "Morning build",
      cron: "05   08 * * 1-5",
    }));
  });

  it("rejects empty cron selections and permits a visual correction", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole("button", { name: "新增" }));
    await user.type(screen.getByLabelText("名称"), "Morning build");

    await user.click(screen.getByRole("button", { name: "分钟 0" }));
    expect(screen.getByRole("button", { name: "分钟 0" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("至少为每个字段选择一个值")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(mockRunner.saveSchedule).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "分钟 30" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(mockRunner.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({ cron: "30 9 * * 1,2,3,4,5" }));
  });

  it("keeps the schedule draft when the main view is hidden and shown again", async () => {
    const user = userEvent.setup();
    const { rerender } = renderView();
    await user.click(screen.getByRole("button", { name: "新增" }));
    await user.type(screen.getByLabelText("名称"), "Unfinished schedule");

    rerender(<SidebarProvider><SchedulerView active={false} /></SidebarProvider>);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    rerender(<SidebarProvider><SchedulerView active /></SidebarProvider>);
    expect(screen.getByLabelText("名称")).toHaveValue("Unfinished schedule");
  });

  it("uses the full viewport width when opened on mobile", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    try {
      const user = userEvent.setup();
      renderView();
      await user.click(screen.getByRole("button", { name: "新增" }));
      await waitFor(() => expect(screen.getByRole("dialog")).toHaveStyle({ left: "0px", right: "0px" }));
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    }
  });

  it("keeps mobile sheets from covering each other", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    try {
      const user = userEvent.setup();
      const { rerender } = renderView();
      await user.click(screen.getByRole("button", { name: "新增" }));
      expect(mockRunner.setFragmentsOpen).toHaveBeenCalledWith(false);
      await user.type(screen.getByLabelText("名称"), "Unfinished schedule");
      mockRunner.fragmentsOpen = true;
      rerender(<SidebarProvider><SchedulerView /></SidebarProvider>);
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      mockRunner.fragmentsOpen = false;
      rerender(<SidebarProvider><SchedulerView /></SidebarProvider>);
      expect(screen.getByLabelText("名称")).toHaveValue("Unfinished schedule");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    }
  });

  it("rejects invalid JSON without calling save", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole("button", { name: "新增" }));
    fireEvent.change(screen.getByLabelText("参数 JSON"), { target: { value: "{oops" } });
    expect(screen.getByText("需为合法 JSON 对象")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByRole("alert")).toHaveTextContent("参数必须是有效的 JSON 对象");
    expect(mockRunner.saveSchedule).not.toHaveBeenCalled();
  });

  it("edits an existing schedule with a locked ID", async () => {
    const user = userEvent.setup();
    mockRunner.schedules = [schedule];
    renderView();
    await openEditSheet(user, "Nightly build");

    expect(screen.getByText("id · nightly-build")).toBeInTheDocument();
    expect(screen.getByLabelText("参数 JSON")).toHaveValue('{\n  "BRANCH": "main"\n}');
  });

  it("runs row actions and requires confirmation before deleting", async () => {
    const user = userEvent.setup();
    mockRunner.schedules = [schedule];
    renderView();
    await expandCard(user, "Nightly build");

    await user.click(screen.getByRole("switch", { name: "停用 Nightly build" }));
    await user.click(screen.getByRole("button", { name: "立即运行" }));
    await user.click(screen.getByRole("button", { name: "删除 Nightly build" }));

    expect(mockRunner.setScheduleEnabled).toHaveBeenCalledWith("nightly-build", false);
    expect(mockRunner.runScheduleNow).toHaveBeenCalledWith("nightly-build");
    expect(mockRunner.deleteSchedule).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "再次点击确认删除" }));
    expect(mockRunner.deleteSchedule).toHaveBeenCalledWith("nightly-build");
  });

  it("shows running status and tolerates an invalid next run date", async () => {
    const user = userEvent.setup();
    mockRunner.schedules = [{ ...schedule, running: true, nextRun: "not-a-date", lastRun: null }];
    renderView();

    const card = screen.getByRole("button", { name: "Nightly build" });
    expect(card).toHaveAttribute("data-running", "true");
    await user.click(card);

    expect(screen.getAllByText("运行中").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("--").length).toBeGreaterThanOrEqual(1);
  });
});
