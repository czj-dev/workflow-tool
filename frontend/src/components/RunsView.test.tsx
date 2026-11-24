import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Mock } from "vitest";

const { mockRunner } = vi.hoisted(() => ({
  mockRunner: {
    runsRevision: 0,
    runsFilter: {},
    listRuns: vi.fn(),
    setRunsFilter: vi.fn(),
    openRun: vi.fn(),
    actions: [{ id: "build", title: "构建" }],
    workflows: [{ id: "deploy", title: "部署" }],
    aiTasks: [{ id: "review-bot", title: "代码审查" }],
  },
}));

vi.mock("../hooks/useActionRunner", () => ({
  useActionRunner: () => mockRunner,
}));

import { SidebarProvider } from "@/components/ui/sidebar";
import { RunsView } from "./RunsView";
import type { RunItem } from "../types/events";

const run = (extra: Partial<RunItem> = {}): RunItem => ({
  id: "r20261125-021500-a1b2c3",
  targetKind: "action",
  targetId: "build",
  origin: "manual",
  scheduleId: "",
  status: "succeeded",
  reason: "",
  startedAt: "2026-11-25T02:15:00+08:00",
  finishedAt: "2026-11-25T02:15:04+08:00",
  exitCode: 0,
  params: {},
  outputs: {},
  ...extra,
});

function renderView() {
  return render(
    <SidebarProvider>
      <RunsView />
    </SidebarProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunner.runsRevision = 0;
  mockRunner.runsFilter = {};
  mockRunner.listRuns.mockResolvedValue([]);
});

describe("RunsView", () => {
  it("renders the empty state when nothing has run yet", async () => {
    renderView();
    expect(await screen.findByText(/还没有运行记录/)).toBeInTheDocument();
    expect(mockRunner.listRuns).toHaveBeenCalledWith({});
    expect(screen.getByRole("heading", { name: "运行记录" })).toBeInTheDocument();
  });

  it("lists runs of every target kind with status, duration and origin; a row opens the run detail", async () => {
    const user = userEvent.setup();
    mockRunner.listRuns.mockResolvedValue([
      run({ id: "r-ai", targetKind: "ai", targetId: "review-bot", origin: "schedule", scheduleId: "nightly",
        params: { prompt: "夜间巡检 ${TOPIC}", TOPIC: "崩溃日志" }, outputs: { session_id: "sess-1" } }),
      run({ id: "r-fail", targetKind: "workflow", targetId: "deploy", status: "failed", reason: "退出码 3", exitCode: 3 }),
      run({ id: "r-skip", status: "skipped", reason: '动作 "build" 正在运行', exitCode: -1, finishedAt: "" }),
      run({ id: "r-ok" }),
    ]);
    renderView();
    const aiRow = await screen.findByRole("button", { name: /代码审查 · 成功/ });
    // AI 运行的摘要：当次提示词按当次输入展开；调度发起的标出来源与调度 id
    expect(within(aiRow).getByText("夜间巡检 崩溃日志")).toBeInTheDocument();
    expect(within(aiRow).getByText(/调度/)).toHaveTextContent("nightly");
    expect(within(aiRow).getByText(/· 4s/)).toBeInTheDocument();

    const failRow = screen.getByRole("button", { name: /部署 · 失败/ });
    expect(within(failRow).getByText("退出码 3")).toBeInTheDocument();
    expect(within(failRow).getByText("失败")).toHaveClass("text-destructive");
    // 手动运行不带来源标记
    expect(within(failRow).queryByText(/手动运行/)).not.toBeInTheDocument();

    const skipRow = screen.getByRole("button", { name: /构建 · 已跳过/ });
    expect(within(skipRow).getByText(/正在运行/)).toBeInTheDocument();

    // 目标已卸载时回落显示 id；计数与状态
    expect(screen.getByText("4 次运行")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /构建 · 成功/ }));
    expect(mockRunner.openRun).toHaveBeenCalledWith("r-ok");
  });

  it("filters by target kind, status and origin through the shared filter state", async () => {
    const user = userEvent.setup();
    mockRunner.listRuns.mockResolvedValue([]);
    renderView();
    await screen.findByText(/还没有运行记录/);

    await user.click(screen.getByRole("button", { name: "AI 任务" }));
    expect(mockRunner.setRunsFilter).toHaveBeenLastCalledWith({ targetKind: "ai", targetId: "" });

    await user.click(screen.getAllByRole("button", { name: "失败" })[0]);
    expect(mockRunner.setRunsFilter).toHaveBeenLastCalledWith({ status: "failed" });
    await user.click(screen.getAllByRole("button", { name: "调度" })[0]);
    expect(mockRunner.setRunsFilter).toHaveBeenLastCalledWith({ origin: "schedule" });
  });

  it("clicking the active filter again clears it; switching kind drops the selected target", async () => {
    const user = userEvent.setup();
    mockRunner.listRuns.mockResolvedValue([]);
    // 筛选状态由 Provider 持有：这里直接给定「已选中」的状态
    mockRunner.runsFilter = { targetKind: "ai", targetId: "review-bot", status: "failed", origin: "schedule" };
    const { rerender } = renderView();
    await screen.findByText(/还没有运行记录/);

    await user.click(screen.getByRole("button", { name: "AI 任务" }));
    expect(mockRunner.setRunsFilter).toHaveBeenLastCalledWith({ targetKind: "", targetId: "", status: "failed", origin: "schedule" });
    await user.click(screen.getAllByRole("button", { name: "失败" })[0]);
    expect(mockRunner.setRunsFilter).toHaveBeenLastCalledWith({ targetKind: "ai", targetId: "review-bot", status: "", origin: "schedule" });
    await user.click(screen.getAllByRole("button", { name: "调度" })[0]);
    expect(mockRunner.setRunsFilter).toHaveBeenLastCalledWith({ targetKind: "ai", targetId: "review-bot", status: "failed", origin: "" });
    // 换种类：已选的目标不再属于这个种类，一并清掉
    await user.click(screen.getByRole("button", { name: "工作流" }));
    expect(mockRunner.setRunsFilter).toHaveBeenLastCalledWith({ targetKind: "workflow", targetId: "", status: "failed", origin: "schedule" });
    expect(rerender).toBeDefined();
  });

  it("re-fetches whenever runsRevision changes (any run started or finished), keeping the list on screen", async () => {
    mockRunner.listRuns.mockResolvedValue([run({ id: "r1" }), run({ id: "r2" })]);
    const { rerender } = renderView();
    await screen.findByText("2 次运行");
    expect(mockRunner.listRuns).toHaveBeenCalledTimes(1);

    // 下一次拉取还没回来：旧列表不清屏，表头读数让位给「加载中」
    mockRunner.listRuns.mockReturnValue(new Promise(() => {}));
    mockRunner.runsRevision = 1;
    rerender(<SidebarProvider><RunsView /></SidebarProvider>);
    expect(await screen.findByText("加载中…")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /构建 · 成功/ })).toHaveLength(2);

    mockRunner.listRuns.mockResolvedValue([run({ id: "r1" })]);
    mockRunner.runsRevision = 2;
    rerender(<SidebarProvider><RunsView /></SidebarProvider>);
    await waitFor(() => expect(screen.getByText("1 次运行")).toBeInTheDocument());
    expect(mockRunner.listRuns).toHaveBeenCalledTimes(3);
  });

  it("shows a load failure instead of an empty list", async () => {
    (mockRunner.listRuns as Mock).mockRejectedValue(new Error("runs 目录不可读"));
    renderView();
    expect(await screen.findByRole("alert")).toHaveTextContent("runs 目录不可读");
    expect(screen.queryByText(/还没有运行记录/)).not.toBeInTheDocument();
  });
});
