import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef } from "react";

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
import { WorkflowParamForm } from "./WorkflowParamForm";

// workflows 到达后选中首个(有参)→ 进 workflow-form 并设 currentId，使 WorkflowParamForm 渲染。
// memory: Provider 未 memoize，selectWorkflow 引用每渲染都变，故 effect 仅依赖 workflows。
function Setup() {
  const { workflows, selectWorkflow } = useActionRunner();
  const done = useRef(false);
  useEffect(() => {
    if (workflows.length > 0 && !done.current) {
      done.current = true;
      selectWorkflow(workflows[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflows]);
  return null;
}

function ViewProbe() {
  const { view } = useActionRunner();
  return <div data-testid="view-probe">{view}</div>;
}

beforeEach(() => {
  mockListWorkflows.mockReset();
  mockOn.mockClear();
  localStorage.clear();
});

describe("WorkflowParamForm", () => {
  it("标题点击进入 yaml 编辑态 workflow-edit", async () => {
    const user = userEvent.setup();
    mockListWorkflows.mockResolvedValue({
      workflows: [
        {
          id: "wf1",
          title: "参数化WF",
          icon: "hi:workflow",
          description: "",
          params: [
            { id: "MSG", label: "消息", type: "text", required: false, default: "", options: [] },
          ],
          steps: [{ action: "x" }],
        },
      ],
      errors: [],
    });
    render(
      <ActionRunnerProvider>
        <SidebarProvider>
          <Setup />
          <WorkflowParamForm />
          <ViewProbe />
        </SidebarProvider>
      </ActionRunnerProvider>,
    );
    const title = await screen.findByRole("button", { name: "参数化WF" });
    await user.click(title);
    expect(screen.getByTestId("view-probe")).toHaveTextContent("workflow-edit");
  });
});
