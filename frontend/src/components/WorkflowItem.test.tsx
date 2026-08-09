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
  ListDevices: vi.fn().mockResolvedValue({ devices: [], active: "" }),
  SetActiveDevice: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { AppSidebar } from "./AppSidebar";

beforeEach(() => {
  mockListWorkflows.mockReset();
  mockRunWorkflow.mockReset().mockResolvedValue(undefined);
  mockOn.mockClear();
  localStorage.clear();
});

// 通过渲染 AppSidebar 间接测 WorkflowItem（它在侧栏内被实例化）。
function wrap() {
  return (
    <ActionRunnerProvider>
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    </ActionRunnerProvider>
  );
}

describe("WorkflowItem", () => {
  it("单击无参数 workflow 直接运行并记 usage", async () => {
    const user = userEvent.setup({ delay: null });
    // ActionItem 用 250ms 延时区分单击/双击；WorkflowItem 同款，跳过延时。
    mockListWorkflows.mockResolvedValue({
      workflows: [
        { id: "w-run", title: "直跑", icon: "hi:workflow", description: "", params: [], steps: [{ action: "x" }] },
      ],
      errors: [],
    });
    render(wrap());
    await user.click(await screen.findByText("直跑"));
    // WorkflowItem.handleClick 内部 setTimeout(250) 区分单击/双击；
    // delay:null 只跳过 userEvent 的延时，组件内定时器仍按真实时间跑，等它落地。
    await new Promise((r) => setTimeout(r, 300));
    expect(mockRunWorkflow).toHaveBeenCalledWith("w-run", {});
    expect(localStorage.getItem("workflow-usage")).toContain("w-run");
  });

  it("双击有参数 workflow 也直接运行", async () => {
    const user = userEvent.setup({ delay: null });
    mockListWorkflows.mockResolvedValue({
      workflows: [
        {
          id: "w-form", title: "带参", icon: "hi:workflow", description: "",
          params: [{ id: "MSG", label: "消息", type: "text", required: false, default: "", options: [] }],
          steps: [{ action: "x" }],
        },
      ],
      errors: [],
    });
    render(wrap());
    await user.dblClick(await screen.findByText("带参"));
    expect(mockRunWorkflow).toHaveBeenCalledWith("w-form", {});
    // 双击路径同步触发 recordUsage（userEvent.dblClick 清掉单击延时定时器，无需 await）
    expect(localStorage.getItem("workflow-usage")).toContain("w-form");
  });
});
