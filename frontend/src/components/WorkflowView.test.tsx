import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockListWorkflows, mockOn } = vi.hoisted(() => ({
  mockListWorkflows: vi.fn(),
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
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import { WorkflowView } from "./WorkflowView";

// ViewProbe：暴露 provider 内部 view 状态，让用例可断言点击返回按钮后的视图路由。
function ViewProbe() {
  const { view } = useActionRunner();
  return <div data-testid="view-probe">{view}</div>;
}

beforeEach(() => {
  mockListWorkflows.mockReset();
  mockOn.mockClear();
  localStorage.clear();
});

describe("WorkflowView", () => {
  it("点击返回按钮切回 workflows-grid", async () => {
    const user = userEvent.setup();
    mockListWorkflows.mockResolvedValue({
      workflows: [
        {
          id: "demo-x",
          title: "演示",
          icon: "hi:workflow",
          description: "",
          params: [],
          steps: [{ action: "a" }],
        },
      ],
      errors: [],
    });
    render(
      <ActionRunnerProvider>
        <SidebarProvider>
          <WorkflowView />
          <ViewProbe />
        </SidebarProvider>
      </ActionRunnerProvider>,
    );
    // 返回按钮的 aria-label = t("sidebar.allWorkflows") = 中文「全部工作流」
    const backBtn = await screen.findByRole("button", { name: "全部工作流" });
    await user.click(backBtn);
    expect(screen.getByTestId("view-probe")).toHaveTextContent("workflows-grid");
  });
});
