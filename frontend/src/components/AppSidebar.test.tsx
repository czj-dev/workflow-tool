import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// mock bindings 与 runtime（hoisted 模式，便于引用）
const {
  mockListActions,
  mockListWorkflows,
  mockListAiTasks,
  mockRunAction,
  mockRunAi,
  mockOn,
  listeners,
} = vi.hoisted(() => {
  const listeners: Record<string, (e: unknown) => void> = {};
  return {
    mockListActions: vi.fn(),
    mockListWorkflows: vi.fn(),
    mockListAiTasks: vi.fn(),
    mockRunAction: vi.fn(() => Promise.resolve()),
    mockRunAi: vi.fn(() => Promise.resolve()),
    mockOn: vi.fn((name: string, cb: (e: unknown) => void) => {
      listeners[name] = cb;
      return () => {
        delete listeners[name];
      };
    }),
    listeners,
  };
});

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: mockListActions,
  RunAction: mockRunAction,
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn().mockResolvedValue(undefined),
  GetFragments: vi.fn().mockResolvedValue([]),
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: vi.fn().mockResolvedValue(undefined),
  PickDirectory: vi.fn().mockResolvedValue(""),
  ListWorkflows: mockListWorkflows,
  ListAiTasks: mockListAiTasks,
  RunAi: mockRunAi,
  CancelAi: vi.fn(),
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
  ListDevices: vi.fn().mockResolvedValue({ devices: [], active: "" }),
  SetActiveDevice: vi.fn().mockResolvedValue(undefined),
  // 运行记录列表进入视图时才拉取
  ListRuns: vi.fn().mockResolvedValue({ runs: [] }),
  GetRun: vi.fn(),
  GetRunEvents: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { AppSidebar } from "./AppSidebar";
import { useActionRunner } from "../hooks/useActionRunner";

function ViewProbe() {
  const { view } = useActionRunner();
  return <div data-testid="view-probe">{view}</div>;
}

beforeEach(() => {
  Object.keys(listeners).forEach((k) => delete listeners[k]);
  mockListActions.mockReset();
  mockListWorkflows.mockReset().mockResolvedValue({ workflows: [], errors: [] });
  mockListAiTasks.mockReset().mockResolvedValue({ tasks: [], errors: [] });
  mockRunAction.mockReset().mockResolvedValue(undefined);
  mockRunAi.mockReset().mockResolvedValue(undefined);
  mockOn.mockClear();
  // 主题测试需要：jsdom 无 matchMedia，mock 之；清 storage 保证初始态
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  localStorage.clear();
});

function wrap() {
  return (
    <ThemeProvider defaultTheme="light" storageKey="theme-test">
      <ActionRunnerProvider>
        <SidebarProvider>
          <AppSidebar />
          <ViewProbe />
        </SidebarProvider>
      </ActionRunnerProvider>
    </ThemeProvider>
  );
}

describe("AppSidebar", () => {
  it("渲染动作列表与常用动作分区标题", async () => {
    mockListActions.mockResolvedValue({
      actions: [
        { id: "a1", title: "打个招呼", icon: "👋", description: "d", params: [], presets: [] },
      ],
      errors: [],
    });
    render(wrap());
    expect(await screen.findByText("打个招呼")).toBeInTheDocument();
    expect(screen.getByText("常用动作")).toBeInTheDocument();
  });

  it("渲染底部全局配置入口", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    render(wrap());
    expect(await screen.findByText("全局配置")).toBeInTheDocument();
  });

  it("渲染运行记录入口并打开运行记录列表", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    render(wrap());
    const entry = await screen.findByRole("button", { name: "运行记录" });
    await user.click(entry);
    expect(screen.getByTestId("view-probe")).toHaveTextContent("runs");
  });

  it("渲染调度入口并打开调度面板", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    render(wrap());
    const schedules = await screen.findByRole("button", { name: "调度" });
    expect(schedules).toBeInTheDocument();
    await user.click(schedules);
    expect(screen.getByTestId("view-probe")).toHaveTextContent("schedules");
  });

  it("点击有参数动作后展开预设子项", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [
        {
          id: "scrape",
          title: "抓取",
          icon: "🌐",
          description: "",
          params: [
            { id: "URL", label: "网址", type: "text", required: true, default: "", options: [] },
          ],
          presets: [{ name: "首页", values: { URL: "https://x.com" } }],
        },
      ],
      errors: [],
    });
    render(wrap());
    const item = await screen.findByText("抓取");
    await user.click(item);
    expect(await screen.findByText("首页")).toBeInTheDocument();
  });

  it("底部 Footer 展示设置入口，不再直接显示主题按钮", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    render(wrap());
    // 主题/语言归拢进「设置」页；侧边栏只剩入口按钮
    expect(await screen.findByText("设置")).toBeInTheDocument();
    expect(screen.queryByText("浅色")).not.toBeInTheDocument();
    expect(screen.queryByText("深色")).not.toBeInTheDocument();
  });

  it("workflow 超过 3 个时侧栏只展示前 3 个 + 全部工作流入口", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockListWorkflows.mockResolvedValue({
      workflows: [
        { id: "w1", title: "W1", icon: "hi:workflow", description: "", params: [], steps: [{ action: "x" }] },
        { id: "w2", title: "W2", icon: "hi:workflow", description: "", params: [], steps: [{ action: "x" }] },
        { id: "w3", title: "W3", icon: "hi:workflow", description: "", params: [], steps: [{ action: "x" }] },
        { id: "w4", title: "W4", icon: "hi:workflow", description: "", params: [], steps: [{ action: "x" }] },
      ],
      errors: [],
    });
    render(wrap());
    expect(await screen.findByText("常用工作流")).toBeInTheDocument();
    expect(screen.getByText("W1")).toBeInTheDocument();
    expect(screen.getByText("W3")).toBeInTheDocument();
    expect(screen.queryByText("W4")).not.toBeInTheDocument();
    expect(screen.getByText("全部工作流")).toBeInTheDocument();
  });

  it("workflow 为空时显示空提示,不显示全部入口", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockListWorkflows.mockResolvedValue({ workflows: [], errors: [] });
    render(wrap());
    expect(await screen.findByText(/无工作流/)).toBeInTheDocument();
    expect(screen.queryByText("全部工作流")).not.toBeInTheDocument();
  });

  it("分组头整块可点：点「全部工作流」行打开 workflows-grid", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockListWorkflows.mockResolvedValue({
      workflows: [
        { id: "w1", title: "W1", icon: "hi:workflow", description: "", params: [], steps: [{ action: "x" }] },
      ],
      errors: [],
    });
    render(wrap());
    // 分组头两行里第二行是入口名（可访问名 = 全部工作流），等数据加载后点击整块生效
    const entry = await screen.findByText("全部工作流");
    await user.click(entry);
    expect(screen.getByTestId("view-probe")).toHaveTextContent("workflows-grid");
  });

  it("workflow 色块不常亮：跑过后切去非 workflow 页蓝组熄灭，在 workflow 视图才亮", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockListWorkflows.mockResolvedValue({
      workflows: [
        { id: "w1", title: "W1", icon: "hi:workflow", description: "", params: [], steps: [{ action: "x" }] },
      ],
      errors: [],
    });
    render(wrap());
    const blueLit = () =>
      document.querySelector('.side-sec[data-amb="blue"]')?.hasAttribute("data-lit") ?? false;
    // 单击无参 workflow → 前台运行：view=workflow，currentId=w1（单击有 250ms 双击窗口）
    await user.click(await screen.findByText("W1"));
    await waitFor(() =>
      expect(screen.getByTestId("view-probe")).toHaveTextContent("workflow"),
    );
    expect(blueLit()).toBe(true); // 在 workflow 视图：蓝组亮（正控）
    // 经底栏切去调度页：currentId 残留 w1 但无承接态 → 蓝组必须熄灭（回归：旧代码常亮）
    await user.click(screen.getByRole("button", { name: "调度" }));
    await waitFor(() =>
      expect(screen.getByTestId("view-probe")).toHaveTextContent("schedules"),
    );
    expect(blueLit()).toBe(false);
    expect(
      document.querySelector('.side-sec[data-amb="green"]')?.hasAttribute("data-lit"),
    ).toBeFalsy();
  });
});

// 后台起跑 AI 任务（等价于在网格卡上点「运行」：不切视图），用来观察侧栏的运行徽标。
function AiRunProbe({ id }: { id: string }) {
  const { runAi } = useActionRunner();
  return (
    <button data-testid="run-ai" onClick={() => void runAi(id, undefined, true)}>
      run
    </button>
  );
}

function wrapAi() {
  return (
    <ThemeProvider defaultTheme="light" storageKey="theme-test">
      <ActionRunnerProvider>
        <SidebarProvider>
          <AppSidebar />
          <ViewProbe />
          <AiRunProbe id="t1" />
        </SidebarProvider>
      </ActionRunnerProvider>
    </ThemeProvider>
  );
}

describe("AppSidebar — AI 任务组", () => {
  const mkAi = (id: string, title: string) => ({
    id,
    title,
    icon: "",
    description: "",
    params: [],
    presets: [],
    prompt: `p-${id}`,
    system: "",
  });

  it("渲染 AI 任务分区，单击任务进会话页", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockListAiTasks.mockResolvedValue({ tasks: [mkAi("t1", "问代码")], errors: [] });
    render(wrap());
    expect(await screen.findByText("问代码")).toBeInTheDocument();
    expect(screen.getByText("AI 任务")).toBeInTheDocument();
    expect(screen.getByText("全部 AI 任务")).toBeInTheDocument();
    await user.click(screen.getByText("问代码"));
    expect(screen.getByTestId("view-probe")).toHaveTextContent("ai-chat");
  });

  it("AI 任务超过 3 个时侧栏只展示前 3 个 + 全部 AI 任务入口", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockListAiTasks.mockResolvedValue({
      tasks: [mkAi("a1", "AI一"), mkAi("a2", "AI二"), mkAi("a3", "AI三"), mkAi("a4", "AI四")],
      errors: [],
    });
    render(wrap());
    expect(await screen.findByText("AI一")).toBeInTheDocument();
    expect(screen.getByText("AI三")).toBeInTheDocument();
    expect(screen.queryByText("AI四")).not.toBeInTheDocument();
    expect(screen.getByText("全部 AI 任务")).toBeInTheDocument();
  });

  it("无 AI 任务且无加载错误时不渲染 AI 分区", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    render(wrap());
    await screen.findByText(/无工作流/);
    expect(screen.queryByText("AI 任务")).not.toBeInTheDocument();
    expect(document.querySelector('.side-sec[data-amb="violet"]')).toBeNull();
  });

  it("AI 任务加载出错时分区保留，错误就地展示", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockListAiTasks.mockResolvedValue({
      tasks: [],
      errors: ["ai/demo-ask.yaml: 第 3 行: 未知字段"],
    });
    render(wrap());
    expect(await screen.findByText("ai/demo-ask.yaml: 第 3 行: 未知字段")).toBeInTheDocument();
    expect(screen.getByText("AI 任务")).toBeInTheDocument();
    // 没有可进的任务：入口行不出现
    expect(screen.queryByText("全部 AI 任务")).not.toBeInTheDocument();
  });

  it("分组头整块可点：点「全部 AI 任务」行打开 ai-grid", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockListAiTasks.mockResolvedValue({ tasks: [mkAi("t1", "问代码")], errors: [] });
    render(wrap());
    const entry = await screen.findByText("全部 AI 任务");
    await user.click(entry);
    expect(screen.getByTestId("view-probe")).toHaveTextContent("ai-grid");
  });

  it("运行中的 AI 任务亮起条目徽标与分组头 LED，结束后熄灭", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    mockListAiTasks.mockResolvedValue({ tasks: [mkAi("t1", "问代码")], errors: [] });
    render(wrapAi());
    await screen.findByText("问代码");
    const violet = () => document.querySelector('.side-sec[data-amb="violet"]');
    const badge = () => violet()?.querySelector(".live-pulse") != null;
    const led = () => violet()?.querySelector(".side-led") != null;
    expect(badge()).toBe(false);
    expect(led()).toBe(false);
    await user.click(screen.getByTestId("run-ai"));
    await waitFor(() => expect(badge()).toBe(true));
    expect(led()).toBe(true);
    act(() => {
      listeners["ai:t1:done"]({ data: { exitCode: 0, err: "", duration: "" } });
    });
    expect(badge()).toBe(false);
    expect(led()).toBe(false);
  });
});
