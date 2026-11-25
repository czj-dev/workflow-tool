import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockRunner } = vi.hoisted(() => ({
  mockRunner: {
    schedules: [],
    scheduleErrors: [],
    actions: [{ id: "build", title: "Build" }],
    workflows: [{ id: "deploy", title: "Deploy" }],
    aiTasks: [] as Array<{ id: string; title: string }>,
    scheduleEditor: null,
    fragmentsOpen: false,
    setFragmentsOpen: vi.fn(),
    setFormSheetOpen: vi.fn(),
    deleteSchedule: vi.fn(() => Promise.resolve()),
    setScheduleEnabled: vi.fn(() => Promise.resolve()),
    runScheduleNow: vi.fn(() => Promise.resolve()),
    openRun: vi.fn(),
    openScheduleForm: vi.fn(),
  },
})) as { mockRunner: MockRunner };

vi.mock("../hooks/useActionRunner", () => ({
  useActionRunner: () => mockRunner,
}));

import { SidebarProvider } from "@/components/ui/sidebar";
import { SchedulerView } from "./SchedulerView";

type MockRun = {
  status: string;
  startedAt: string;
  finishedAt: string;
  duration: string;
  error: string;
  runId?: string;
};

type MockSchedule = {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  targetKind: string;
  targetId: string;
  params: Record<string, unknown>;
  catchUp?: boolean;
  nextRun: string;
  running: boolean;
  lastRun: MockRun | null;
  lastSkip?: { at: string; reason: string; runId?: string } | null;
};

type MockRunner = {
  schedules: MockSchedule[];
  scheduleErrors: string[];
  actions: Array<{ id: string; title: string }>;
  workflows: Array<{ id: string; title: string }>;
  aiTasks: Array<{ id: string; title: string }>;
  scheduleEditor: unknown;
  fragmentsOpen: boolean;
  setFragmentsOpen: (open: boolean) => void;
  setFormSheetOpen: (open: boolean) => void;
  deleteSchedule: (id: string) => Promise<void>;
  setScheduleEnabled: (id: string, enabled: boolean) => Promise<void>;
  runScheduleNow: (id: string) => Promise<void>;
  openRun: Mock;
  openScheduleForm: Mock;
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
    status: "succeeded",
    startedAt: "2026-11-12T02:00:00Z",
    finishedAt: "2026-11-12T02:00:04Z",
    duration: "4s",
    error: "",
    runId: "r20261112-020000-a1b2c3",
  },
};

const aiSchedule: MockSchedule = {
  ...schedule,
  id: "nightly-review",
  name: "Nightly review",
  targetKind: "ai",
  targetId: "review-bot",
  params: { TOPIC: "crash" },
  lastRun: null,
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

beforeEach(() => {
  mockRunner.schedules = [];
  mockRunner.scheduleErrors = [];
  mockRunner.actions = [{ id: "build", title: "Build" }];
  mockRunner.workflows = [{ id: "deploy", title: "Deploy" }];
  mockRunner.aiTasks = [];
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
    // 还没有 AI 调度：AI 分组省略
    expect(screen.queryByText("AI 任务调度")).not.toBeInTheDocument();
    expect(screen.getAllByText("每天 02:00").length).toBe(2);
    // 后端全精度时长串归一为统一读数（495.555291ms → 0.5s）
    expect(screen.getByText("0.5s")).toBeInTheDocument();
    expect(screen.getAllByText("1 项 · 1 启用").length).toBe(2);
    await expandCard(user, "Nightly build");
    expect(screen.getByRole("button", { name: "Nightly build" })).toHaveAttribute("aria-expanded", "true");
  });

  it("AI 任务的调度进「AI 任务调度」分组，卡片标出目标任务", async () => {
    mockRunner.aiTasks = [{ id: "review-bot", title: "代码审查" }];
    mockRunner.schedules = [aiSchedule];
    renderView();

    expect(screen.getByText("AI 任务调度")).toBeInTheDocument();
    expect(screen.queryByText("动作调度")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nightly review" })).toHaveTextContent("AI 任务 · 代码审查");
  });

  it("新增：把自动生成的 id 与默认目标交给调度编辑器", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole("button", { name: "新增" }));

    expect(mockRunner.openScheduleForm).toHaveBeenCalledTimes(1);
    const [value, creating] = mockRunner.openScheduleForm.mock.calls[0] as [
      { id: string; name: string; enabled: boolean; cron: string; targetKind: string; targetId: string; params: unknown },
      boolean,
    ];
    expect(value.id).toMatch(/^schedule-[a-z0-9-]+$/);
    expect(value).toMatchObject({ name: "", enabled: true, cron: "0 9 * * 1-5", targetKind: "action", targetId: "build", params: {} });
    // 从调度页新建：目标不锁定
    expect(creating).toBe(true);
    expect(mockRunner.openScheduleForm.mock.calls[0]).toHaveLength(2);
  });

  it("没有动作和工作流时，新增调度的默认目标是第一个 AI 任务", async () => {
    const user = userEvent.setup();
    mockRunner.actions = [];
    mockRunner.workflows = [];
    mockRunner.aiTasks = [{ id: "review-bot", title: "代码审查" }];
    renderView();
    await user.click(screen.getByRole("button", { name: "新增" }));

    expect(mockRunner.openScheduleForm).toHaveBeenCalledWith(
      expect.objectContaining({ targetKind: "ai", targetId: "review-bot" }), true,
    );
  });

  it("编辑：把该调度的现值原样交给调度编辑器", async () => {
    const user = userEvent.setup();
    mockRunner.schedules = [{ ...schedule, cron: "05   08 * * 1-5", catchUp: true }];
    renderView();
    await expandCard(user, "Nightly build");
    await user.click(screen.getByRole("button", { name: "编辑" }));

    expect(mockRunner.openScheduleForm).toHaveBeenCalledWith({
      id: "nightly-build",
      name: "Nightly build",
      enabled: true,
      cron: "05   08 * * 1-5",
      targetKind: "action",
      targetId: "build",
      params: { BRANCH: "main" },
      catchUp: true,
    }, false);
  });

  // 开了补跑的调度在时间规则旁标出来；没开的不标。
  it("补跑：卡片的时间规则旁标出，未开启的不标", async () => {
    const user = userEvent.setup();
    mockRunner.schedules = [{ ...schedule, catchUp: true }];
    renderView();
    await expandCard(user, "Nightly build");
    expect(screen.getByText("0 2 * * * · 补跑")).toBeInTheDocument();
  });

  it("未开启补跑的调度不显示补跑标识", async () => {
    const user = userEvent.setup();
    mockRunner.schedules = [schedule];
    renderView();
    await expandCard(user, "Nightly build");
    expect(screen.getByText("0 2 * * *")).toBeInTheDocument();
    expect(screen.queryByText(/补跑/)).not.toBeInTheDocument();
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

  it("最近结果连着运行记录：点状态进运行详情", async () => {
    const user = userEvent.setup();
    mockRunner.schedules = [schedule];
    renderView();
    await expandCard(user, "Nightly build");

    await user.click(screen.getByRole("button", { name: "成功" }));
    expect(mockRunner.openRun).toHaveBeenCalledWith("r20261112-020000-a1b2c3");
  });

  it("失败与取消的最近结果：失败标红并显示原因，取消用中性色", async () => {
    const user = userEvent.setup();
    mockRunner.schedules = [
      { ...schedule, id: "a", name: "Failed run", lastRun: { ...schedule.lastRun!, status: "failed", error: "退出码 3" } },
      { ...schedule, id: "b", name: "Cancelled run", lastRun: { ...schedule.lastRun!, status: "cancelled", error: "" } },
    ];
    renderView();
    // 紧凑态页脚：两张卡都显示最近结果的时长
    expect(screen.getAllByText("4s")).toHaveLength(2);

    await expandCard(user, "Failed run");
    expect(screen.getByRole("button", { name: "失败" })).toHaveClass("text-destructive");
    expect(screen.getByText("退出码 3")).toBeInTheDocument();

    await expandCard(user, "Cancelled run");
    expect(screen.getByRole("button", { name: "已取消" })).toHaveClass("text-muted-foreground");
  });

  it("上次到点被跳过：注明原因，不算失败也不占用「最近结果」", async () => {
    const user = userEvent.setup();
    mockRunner.schedules = [{
      ...schedule, lastRun: null,
      lastSkip: { at: "2026-11-25T02:00:00Z", reason: '动作 "build" 正在运行', runId: "r20261125-020000-skip01" },
    }];
    renderView();
    // 紧凑态：只有跳过标记，没有结果时长读数
    expect(screen.getByText("⤬ 已跳过")).toBeInTheDocument();
    expect(screen.queryByText("4s")).not.toBeInTheDocument();

    await expandCard(user, "Nightly build");
    expect(screen.getByText('⤬ 上次到点已跳过：动作 "build" 正在运行')).toBeInTheDocument();
    // 跳过也留了运行记录：点它进运行详情
    await user.click(screen.getByRole("button", { name: /上次到点已跳过/ }));
    expect(mockRunner.openRun).toHaveBeenCalledWith("r20261125-020000-skip01");
  });
});
