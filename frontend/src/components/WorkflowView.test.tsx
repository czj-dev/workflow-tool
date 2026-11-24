import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockListWorkflows, mockOn } = vi.hoisted(() => ({
  mockListWorkflows: vi.fn(),
  mockOn: vi.fn(() => () => {}),
}));

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  ListAiTasks: vi.fn().mockResolvedValue({ tasks: [], errors: [] }),
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
  ListSchedules: vi.fn().mockResolvedValue({ schedules: [], errors: [] }),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ActionRunnerProvider, _emitForTest } from "../context/ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import { WorkflowView } from "./WorkflowView";
import { WorkflowStepList } from "./WorkflowStepList";

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

// RunProbe：前台起跑这个 workflow（Provider 内部同步订阅事件，再发 RPC）。
function RunProbe() {
  const { runWorkflow } = useActionRunner();
  return (
    <button type="button" data-testid="run-probe" onClick={() => { void runWorkflow("demo-x"); }}>
      run
    </button>
  );
}

// 回放用的步骤列表（运行详情直接渲染它，不经 Provider）
function ReplayHarness({ steps }: { steps: Parameters<typeof WorkflowStepList>[0]["steps"] }) {
  // 输出行渲染（OutputLines）要读 Provider：树节点的点击映射用到动作列表
  return (
    <ActionRunnerProvider>
      <WorkflowStepList steps={steps} running={false} now={0} />
    </ActionRunnerProvider>
  );
}

beforeEach(() => {
  mockListWorkflows.mockReset().mockResolvedValue({ workflows: [], errors: [] });
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

  // —— AI 步骤在 Pipeline Spine 中以工序段渲染（M3）——

  const wfWithAiStep = {
    workflows: [
      {
        id: "demo-x",
        title: "演示",
        icon: "hi:workflow",
        description: "",
        params: [],
        steps: [{ kind: "ai", label: "t1", name: "分析卡片" }],
      },
    ],
    errors: [],
  };

  const emit = (stream: string, line: string) =>
    _emitForTest("workflow:demo-x:output", { data: { stream, line, step: "0" } });

  it("实时：AI 步骤的回复 / 思考 / 工具调用渲染成工序段面板，不逐增量落文本行", async () => {
    const user = userEvent.setup();
    mockListWorkflows.mockResolvedValue(wfWithAiStep);
    render(
      <ActionRunnerProvider>
        <SidebarProvider>
          <WorkflowView />
          <RunProbe />
        </SidebarProvider>
      </ActionRunnerProvider>,
    );
    await user.click(await screen.findByTestId("run-probe"));
    await screen.findByText("分析卡片");
    act(() => {
      emit("step-start", "0");
      emit("ai-thinking", "想一想");
      emit("ai-tool", JSON.stringify({ id: "call_1", name: "Read", input: { file_path: "/a/package.json" } }));
      emit("ai-tool", JSON.stringify({ id: "call_1", content: "react 19" }));
      emit("ai", "最终");
      emit("ai", "结论");
      emit("stderr", "warn-line");
    });
    // AI 步骤的卡默认展开：工序段头与回答都在卡内
    const card = screen.getByText("分析卡片").closest("[data-slot='card']") as HTMLElement;
    expect(within(card).getByText("思考")).toBeInTheDocument();
    expect(within(card).getByText(/Read/)).toBeInTheDocument();
    expect(within(card).getByText("· package.json")).toBeInTheDocument();
    // 回复只以工序段出现一次（旧逻辑会把每个增量另落一条文本行）
    expect(within(card).getAllByText(/最终结论/)).toHaveLength(1);
    // stdout/stderr 诊断行另起一块
    expect(within(card).getByText("[stderr] warn-line")).toBeInTheDocument();
    act(() => {
      emit("step-done", "0:0");
    });
    expect(await screen.findByText("完成")).toBeInTheDocument();
  });

  it("回放：步骤列表由外部喂入（运行详情），AI 步骤同样以工序段呈现并显示耗时", () => {
    render(
      <ReplayHarness
        steps={[
          {
            index: 0, name: "分析卡片", status: "done", lines: [], startedAt: 100, endedAt: 900,
            aiPanel: {
              segments: [{ kind: "answer", text: "回放回答", startedAt: 300, durationMs: 500 }],
              readout: { isError: false },
              streaming: false,
            },
          },
          { index: 1, name: "构建", status: "error", exitCode: 1, lines: [{ kind: "text", text: "build failed" }], startedAt: 900, endedAt: 1200 },
          { index: 2, name: "收尾", status: "done", lines: [{ kind: "text", text: "all good" }], startedAt: 1200, endedAt: 1300 },
        ]}
      />,
    );
    // AI 步骤与出错步骤默认展开；顺利完成且没有工序段的步骤默认折叠（点开才看）
    expect(screen.getByText("回放回答")).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.getByText("exit 1")).toBeInTheDocument();
    expect(screen.getByText("build failed")).toBeInTheDocument();
    expect(screen.queryByText("all good")).not.toBeInTheDocument();
    // 两个已完成步骤的卡头徽标各一处；步骤内嵌的工序段面板不再带终点读数行（不说两遍）
    expect(screen.getAllByText("完成")).toHaveLength(2);
    // 耗时取打点差值
    expect(screen.getByText("0.8s")).toBeInTheDocument();
    expect(screen.getByText("0.3s")).toBeInTheDocument();
    // 用户点开后照常展开
    fireEvent.click(screen.getByText("收尾"));
    expect(screen.getByText("all good")).toBeInTheDocument();
  });
});
