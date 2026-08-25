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

// FocusProbe：用例里唯一能让 provider 选中 workflow 的入口。
// 仪表带读数取自 workflows.find(w => w.id === currentId)?.steps，currentId 初值为 null 时
// 步骤列表为空，整条仪表带被空态短路（WorkflowView 落 Empty），读数节点根本不进 DOM，
// 所以断言 00/01 之前必须先选中。这里用 focusWorkflow 而非 runWorkflow：它只写
// currentId + view，不动 status、不打运行起始时间，正合「定义态 1 步、未运行」的语义。
function FocusProbe() {
  const { focusWorkflow } = useActionRunner();
  return (
    <button type="button" data-testid="focus-probe" onClick={() => focusWorkflow("demo-x")}>
      focus
    </button>
  );
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
          // 后端 ListWorkflows 给前端的形状是 WorkflowStepInfo{kind,label,name}
          // （internal/api/workflows.go），不是 workflow YAML 里的 step 形状。
          steps: [{ kind: "action", label: "a", name: "" }],
        },
      ],
      errors: [],
    });
    render(
      <ActionRunnerProvider>
        <SidebarProvider>
          <WorkflowView />
          <ViewProbe />
          <FocusProbe />
        </SidebarProvider>
      </ActionRunnerProvider>,
    );
    // 先选中 workflow，否则仪表带整块不渲染（见 FocusProbe 注释）
    await user.click(screen.getByTestId("focus-probe"));
    // 返回按钮的 aria-label = t("sidebar.allWorkflows") = 中文「全部工作流」
    const backBtn = await screen.findByRole("button", { name: "全部工作流" });
    // 仪表带：定义态 1 步、未运行 → 读数 00/01，eyebrow 为中文「步骤」
    expect(await screen.findByText("00/01")).toBeInTheDocument();
    expect(screen.getByText("步骤")).toBeInTheDocument();
    await user.click(backBtn);
    expect(screen.getByTestId("view-probe")).toHaveTextContent("workflows-grid");
  });
});
