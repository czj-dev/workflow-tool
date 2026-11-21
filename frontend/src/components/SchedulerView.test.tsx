import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("opens a left sheet with an automatic disabled ID and saves parsed object parameters", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole("button", { name: "新增" }));

    const sheet = screen.getByRole("dialog");
    expect(sheet).toHaveAttribute("data-side", "left");
    expect(screen.queryByLabelText("Cron")).not.toBeInTheDocument();
    const idInput = screen.getByLabelText("ID");
    expect(idInput).toBeDisabled();
    const generatedId = (idInput as HTMLInputElement).value;
    expect(generatedId).toMatch(/^schedule-[a-z0-9-]+$/);
    await user.type(screen.getByLabelText("名称"), "Morning build");
    fireEvent.change(screen.getByLabelText("参数 JSON"), { target: { value: '{"BRANCH":"main"}' } });
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(mockRunner.saveSchedule).toHaveBeenCalledWith({
      id: generatedId,
      name: "Morning build",
      enabled: true,
      cron: "0 9 * * 1-5",
      targetKind: "action",
      targetId: "build",
      params: { BRANCH: "main" },
    });
  });

  it("serializes edited date and time checkboxes without changing other cron fields", async () => {
    const user = userEvent.setup();
    mockRunner.schedules = [{ ...schedule, cron: "5,10-12 8-10 1,15 1,6 1-5" }];
    renderView();
    await user.click(screen.getByRole("button", { name: "编辑 Nightly build" }));

    expect(screen.getByLabelText("ID")).toHaveValue("nightly-build");
    expect(screen.getByRole("checkbox", { name: "月份 6" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "小时 9" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "分钟 30" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(mockRunner.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({
      id: "nightly-build",
      cron: "5,10,11,12,30 8,9,10 1,15 1,6 1,2,3,4,5",
    }));
  });

  it("preserves the original cron expression when editing other fields", async () => {
    const user = userEvent.setup();
    mockRunner.schedules = [{ ...schedule, cron: "05   08 * * 1-5" }];
    renderView();
    await user.click(screen.getByRole("button", { name: "编辑 Nightly build" }));
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
    await user.click(screen.getByRole("checkbox", { name: "分钟 0" }));
    expect(screen.getByRole("checkbox", { name: "分钟 0" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(mockRunner.saveSchedule).not.toHaveBeenCalled();
    await user.click(screen.getByRole("checkbox", { name: "分钟 30" }));
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
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByText("参数必须是有效的 JSON 对象")).toBeInTheDocument();
    expect(mockRunner.saveSchedule).not.toHaveBeenCalled();
  });

  it("edits an existing schedule with a locked ID", async () => {
    const user = userEvent.setup();
    mockRunner.schedules = [schedule];
    renderView();
    await user.click(screen.getByRole("button", { name: "编辑 Nightly build" }));

    expect(screen.getByLabelText("ID")).toBeDisabled();
    expect(screen.getByLabelText("参数 JSON")).toHaveValue('{\n  "BRANCH": "main"\n}');
  });

  it("runs row actions and requires confirmation before deleting", async () => {
    const user = userEvent.setup();
    mockRunner.schedules = [schedule];
    renderView();
    const row = screen.getByRole("row", { name: /Nightly build/ });

    await user.click(within(row).getByRole("switch"));
    await user.click(within(row).getByRole("button", { name: "立即运行 Nightly build" }));
    await user.click(within(row).getByRole("button", { name: "删除 Nightly build" }));

    expect(mockRunner.setScheduleEnabled).toHaveBeenCalledWith("nightly-build", false);
    expect(mockRunner.runScheduleNow).toHaveBeenCalledWith("nightly-build");
    expect(mockRunner.deleteSchedule).not.toHaveBeenCalled();

    await user.click(within(row).getByRole("button", { name: "再次点击确认删除" }));
    expect(mockRunner.deleteSchedule).toHaveBeenCalledWith("nightly-build");
  });

  it("shows running status and tolerates an invalid next run date", () => {
    mockRunner.schedules = [{ ...schedule, running: true, nextRun: "not-a-date", lastRun: null }];
    renderView();

    expect(screen.getAllByText("运行中").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("--").length).toBeGreaterThanOrEqual(2);
  });
});
