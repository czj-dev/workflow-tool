import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
import { useActionRunner } from "../hooks/useActionRunner";
import { WorkflowsGridView } from "./WorkflowsGridView";

// ViewProbe：暴露 provider 内部 view / formSheetOpen / status 状态，让用例可断言点击后的路由、抽屉开合与运行态。
function ViewProbe() {
  const { view, formSheetOpen, status } = useActionRunner();
  return (
    <>
      <div data-testid="view-probe">{view}</div>
      <div data-testid="form-open-probe">{String(formSheetOpen)}</div>
      <div data-testid="status-probe">{status}</div>
    </>
  );
}

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
        <ViewProbe />
      </SidebarProvider>
    </ActionRunnerProvider>
  );
}

const mkWf = (id: string, title: string, extra: Partial<Record<string, unknown>> = {}) => ({
  id,
  title,
  icon: "hi:workflow",
  description: "",
  params: [],
  steps: [{ action: "x" }],
  ...extra,
});

// 双态契约：单击卡=就地展开；运行走展开态 RUN 胶囊（前台）。
const expand = async (user: ReturnType<typeof userEvent.setup>, title: string) => {
  const card = await screen.findByRole("button", { name: title });
  await user.click(card);
  return card;
};
const runPill = (card: HTMLElement) => within(card).getByRole("button", { name: /运行/ });

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
    expect(screen.getByText("演示")).toBeInTheDocument();
    expect(screen.getByText("ADB")).toBeInTheDocument();
  });

  it("单击卡片就地展开，再单击收起", async () => {
    const user = userEvent.setup();
    mockListWorkflows.mockResolvedValue({ workflows: [mkWf("demo-t", "开关卡")], errors: [] });
    render(wrap());
    const card = await expand(user, "开关卡");
    expect(card).toHaveAttribute("aria-expanded", "true");
    expect(runPill(card)).toBeInTheDocument(); // 展开态显形 RUN 主控
    await user.click(card);
    expect(card).toHaveAttribute("aria-expanded", "false");
    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  it("展开态「编辑配置」进入该 workflow 的 YAML 编辑页", async () => {
    const user = userEvent.setup();
    mockListWorkflows.mockResolvedValue({ workflows: [mkWf("demo-yml", "编配卡")], errors: [] });
    render(wrap());
    const card = await expand(user, "编配卡");
    await user.click(within(card).getByRole("button", { name: "编辑配置" }));
    expect(screen.getByTestId("view-probe")).toHaveTextContent("workflow-edit");
  });

  it("展开后 RUN 胶囊直接运行无参数 workflow 并记 usage", async () => {
    const user = userEvent.setup();
    mockListWorkflows.mockResolvedValue({
      workflows: [mkWf("demo-run", "直跑")],
      errors: [],
    });
    render(wrap());
    const card = await expand(user, "直跑");
    await user.click(runPill(card));
    expect(mockRunWorkflow).toHaveBeenCalledWith("demo-run", {});
    expect(localStorage.getItem("workflow-usage")).toContain("demo-run");
  });

  it("RUN 胶囊运行仅带默认值(无必填)的 workflow(前端回填默认值)", async () => {
    const user = userEvent.setup();
    mockListWorkflows.mockResolvedValue({
      workflows: [
        mkWf("demo-form", "带默认值", {
          params: [
            {
              id: "MSG",
              label: "消息",
              type: "text",
              required: false,
              default: "hi",
              options: [],
            },
          ],
        }),
      ],
      errors: [],
    });
    render(wrap());
    const card = await expand(user, "带默认值");
    await user.click(runPill(card));
    // runWorkflow 会在前端回填默认值（MSG: hi）再调服务
    expect(mockRunWorkflow).toHaveBeenCalledWith("demo-form", { MSG: "hi" });
    // 精确匹配：避免误匹配 workflow-form
    expect(screen.getByTestId("view-probe")).toHaveTextContent(/^workflow$/);
  });

  it("RUN 胶囊运行必填且带默认值的 workflow(回填默认值, 如 adb-debug-activity)", async () => {
    const user = userEvent.setup();
    mockListWorkflows.mockResolvedValue({
      workflows: [
        mkWf("demo-req-def", "必填带默认", {
          params: [
            {
              id: "PACKAGE",
              label: "包名",
              type: "text",
              required: true,
              default: "com.example.app",
              options: [],
            },
          ],
        }),
      ],
      errors: [],
    });
    render(wrap());
    const card = await expand(user, "必填带默认");
    await user.click(runPill(card));
    expect(mockRunWorkflow).toHaveBeenCalledWith("demo-req-def", { PACKAGE: "com.example.app" });
    expect(screen.getByTestId("view-probe")).toHaveTextContent(/^workflow$/);
  });

  it("必填无默认的 workflow RUN 胶囊打开表单抽屉(不直接运行)", async () => {
    const user = userEvent.setup();
    mockListWorkflows.mockResolvedValue({
      workflows: [
        mkWf("demo-req", "必填", {
          params: [
            {
              id: "MSG",
              label: "消息",
              type: "text",
              required: true,
              default: "",
              options: [],
            },
          ],
        }),
      ],
      errors: [],
    });
    render(wrap());
    const card = await expand(user, "必填");
    await user.click(runPill(card));
    expect(mockRunWorkflow).not.toHaveBeenCalled();
    // selectWorkflow → 打开表单抽屉，主区视图原地不动
    expect(screen.getByTestId("form-open-probe")).toHaveTextContent("true");
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
  });

  it("RUN 胶囊运行全可选且无默认值的 workflow(不进表单)", async () => {
    const user = userEvent.setup();
    mockListWorkflows.mockResolvedValue({
      workflows: [
        mkWf("demo-opt", "全可选", {
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
    const card = await expand(user, "全可选");
    await user.click(runPill(card));
    expect(mockRunWorkflow).toHaveBeenCalledWith("demo-opt", {});
  });

  it("后台静默运行的卡：卡身点击回跳 workflow 视图并补订阅(不展开不重跑)", async () => {
    const user = userEvent.setup();
    mockListWorkflows.mockResolvedValue({ workflows: [mkWf("demo-bg", "后台跑")], errors: [] });
    render(wrap());
    const card = await screen.findByRole("button", { name: "后台跑" });
    // hover 快捷入口 = 后台运行：不切视图，卡面转运行中读数
    await user.click(within(card).getByRole("button", { name: /运行/ }));
    expect(mockRunWorkflow).toHaveBeenCalledWith("demo-bg", {});
    // 后台运行不切视图（用例里 view 维持初始 output，grid 未被切走）
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
    mockOn.mockClear();
    // 运行中：卡身点击=回跳 workflow 视图（focusWorkflow），不再就地展开
    await user.click(card);
    expect(card).toHaveAttribute("aria-expanded", "false");
    expect(mockRunWorkflow).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("view-probe")).toHaveTextContent(/^workflow$/);
    // 后台路径只订了持久 done：focusWorkflow 必须补建 output/done 订阅并置 running 态
    expect(mockOn).toHaveBeenCalledWith("workflow:demo-bg:output", expect.anything());
    expect(mockOn).toHaveBeenCalledWith("workflow:demo-bg:done", expect.anything());
    expect(screen.getByTestId("status-probe")).toHaveTextContent("running");
  });

  it("YAML color 字段优先于组序循环注入 --amb", async () => {
    mockListWorkflows.mockResolvedValue({
      workflows: [
        mkWf("demo-plain", "缺省色流"),
        mkWf("demo-violet", "紫色流", { color: "violet" }),
      ],
      errors: [],
    });
    render(wrap());
    const plain = await screen.findByRole("button", { name: "缺省色流" });
    const violet = screen.getByRole("button", { name: "紫色流" });
    // 同组（demo，组序 0=amber）：未写 color 回落组循环，写了用逐卡 token
    expect(plain.style.getPropertyValue("--amb")).toBe("var(--amb-amber)");
    expect(violet.style.getPropertyValue("--amb")).toBe("var(--amb-violet)");
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
