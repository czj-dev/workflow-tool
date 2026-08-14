import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockListWorkflows, mockGetWorkflowYaml, mockOn } = vi.hoisted(() => ({
  mockListWorkflows: vi.fn(),
  mockGetWorkflowYaml: vi.fn(),
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
  GetWorkflowYaml: mockGetWorkflowYaml,
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { WorkflowYamlEditor } from "./WorkflowYamlEditor";
import { getCmValue } from "../test/codemirror";

const mkWf = (id: string, title: string) => ({
  id,
  title,
  icon: "hi:workflow",
  description: "",
  params: [],
  steps: [{ action: "x" }],
});

beforeEach(() => {
  mockListWorkflows.mockReset();
  mockGetWorkflowYaml.mockReset();
  mockOn.mockClear();
  localStorage.clear();
});

function wrap() {
  return (
    <ThemeProvider>
      <ActionRunnerProvider>
        <SidebarProvider>
          <WorkflowYamlEditor />
        </SidebarProvider>
      </ActionRunnerProvider>
    </ThemeProvider>
  );
}

describe("WorkflowYamlEditor", () => {
  it("进入时初始化 editingId 为首个 workflow 并加载其 yaml", async () => {
    mockListWorkflows.mockResolvedValue({
      workflows: [mkWf("wf-a", "工作流A"), mkWf("wf-b", "工作流B")],
      errors: [],
    });
    mockGetWorkflowYaml.mockResolvedValue("id: wf-a\ntitle: 工作流A\n");
    render(wrap());
    // currentId 初始 null → editingId 取 workflows[0] = wf-a → 加载其 yaml
    await waitFor(() => {
      expect(mockGetWorkflowYaml).toHaveBeenCalledWith("wf-a");
    });
    // 加载完成后编辑器显示该 yaml 原文
    await waitFor(() => {
      expect(getCmValue()).toBe("id: wf-a\ntitle: 工作流A\n");
    });
  });

  it("Select 切换 editingId 后加载新 workflow 的 yaml", async () => {
    const user = userEvent.setup();
    mockListWorkflows.mockResolvedValue({
      workflows: [mkWf("wf-a", "工作流A"), mkWf("wf-b", "工作流B")],
      errors: [],
    });
    mockGetWorkflowYaml.mockImplementation((id: string) =>
      Promise.resolve(id === "wf-b" ? "id: wf-b\n" : "id: wf-a\n"),
    );
    render(wrap());
    await waitFor(() => expect(mockGetWorkflowYaml).toHaveBeenCalledWith("wf-a"));

    // 打开 Select 并切换到工作流B
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "工作流B" }));

    await waitFor(() => {
      expect(mockGetWorkflowYaml).toHaveBeenCalledWith("wf-b");
    });
  });
});
