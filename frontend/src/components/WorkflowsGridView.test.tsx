import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockListWorkflows, mockRunWorkflow, mockOn } = vi.hoisted(() => ({
  mockListWorkflows: vi.fn(),
  mockRunWorkflow: vi.fn(() => Promise.resolve()),
  mockOn: vi.fn(() => () => {}),
}));

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  RunAction: vi.fn(),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn(),
  GetFragments: vi.fn().mockResolvedValue([]),
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: vi.fn(),
  PickDirectory: vi.fn(),
  ListWorkflows: mockListWorkflows,
  RunWorkflow: mockRunWorkflow,
  CancelWorkflow: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { WorkflowsGridView } from "./WorkflowsGridView";

beforeEach(() => {
  mockListWorkflows.mockReset();
  mockRunWorkflow.mockReset().mockResolvedValue(undefined);
  mockOn.mockClear();
  localStorage.clear();
});

function wrap() {
  return (
    <ActionRunnerProvider>
      <SidebarProvider>
        <WorkflowsGridView />
      </SidebarProvider>
    </ActionRunnerProvider>
  );
}

const mkWf = (id: string, title: string, extra: Partial<{}> = {}) => ({
  id,
  title,
  icon: "hi:workflow",
  description: "",
  params: [],
  steps: [{ action: "x" }],
  ...extra,
});

describe("WorkflowsGridView", () => {
  it("按 id 前缀分组渲染 workflow 卡片与分组头", async () => {
    mockListWorkflows.mockResolvedValue({
      workflows: [
        mkWf("demo-a", "演示A"),
        mkWf("adb-b", "ADB串流"),
      ],
      errors: [],
    });
    render(wrap());
    expect(await screen.findByText("演示A")).toBeInTheDocument();
    expect(screen.getByText("ADB串流")).toBeInTheDocument();
    expect(screen.getByText("Demo")).toBeInTheDocument();
    expect(screen.getByText("ADB")).toBeInTheDocument();
  });

  it("点击无参数 workflow 卡片直接运行并记 usage", async () => {
    const user = userEvent.setup();
    mockListWorkflows.mockResolvedValue({
      workflows: [mkWf("demo-run", "直跑")],
      errors: [],
    });
    render(wrap());
    await user.click(await screen.findByText("直跑"));
    expect(mockRunWorkflow).toHaveBeenCalledWith("demo-run", {});
    expect(localStorage.getItem("workflow-usage")).toContain("demo-run");
  });

  it("点击有参数 workflow 卡片进表单,不直接运行", async () => {
    const user = userEvent.setup();
    mockListWorkflows.mockResolvedValue({
      workflows: [
        mkWf("demo-form", "带参", {
          params: [
            {
              id: "MSG",
              label: "消息",
              type: "text",
              required: false,
              default: "",
              options: [],
            },
          ],
        }),
      ],
      errors: [],
    });
    render(wrap());
    await user.click(await screen.findByText("带参"));
    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  it("渲染个性图标(emoji 原样显示)", async () => {
    mockListWorkflows.mockResolvedValue({
      workflows: [mkWf("demo-emoji", "表情", { icon: "🚀" })],
      errors: [],
    });
    render(wrap());
    expect(await screen.findByText("🚀")).toBeInTheDocument();
  });
});
