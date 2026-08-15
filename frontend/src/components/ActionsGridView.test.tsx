import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockListActions, mockRunAction, mockOn } = vi.hoisted(() => ({
  mockListActions: vi.fn(),
  mockRunAction: vi.fn(() => Promise.resolve()),
  mockOn: vi.fn(() => () => {}),
}));

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: mockListActions,
  RunAction: mockRunAction,
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn(),
  GetFragments: vi.fn().mockResolvedValue([]),
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: vi.fn(),
  PickDirectory: vi.fn(),
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import { ActionsGridView } from "./ActionsGridView";

// ViewProbe：暴露 provider 内部 view 状态，让用例可断言点击后的视图路由。
function ViewProbe() {
  const { view } = useActionRunner();
  return <div data-testid="view-probe">{view}</div>;
}

beforeEach(() => {
  mockListActions.mockReset();
  mockRunAction.mockReset().mockResolvedValue(undefined);
  mockOn.mockClear();
  localStorage.clear();
});

function wrap() {
  return (
    <ActionRunnerProvider>
      <SidebarProvider>
        <ActionsGridView />
        <ViewProbe />
      </SidebarProvider>
    </ActionRunnerProvider>
  );
}

const mkAction = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  icon: "",
  description: "",
  params: [],
  presets: [],
  ...extra,
});

describe("ActionsGridView", () => {
  it("点击必填无默认值的卡片进表单(不直接执行)", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [
        mkAction("demo-req", "必填无默认", {
          params: [
            { id: "TEXT", label: "文本", type: "text", required: true, default: "", options: [] },
          ],
        }),
      ],
      errors: [],
    });
    render(wrap());
    await user.click(await screen.findByText("必填无默认"));
    expect(mockRunAction).not.toHaveBeenCalled();
    // onEdit → selectPreset("") → setView("form")
    expect(screen.getByTestId("view-probe")).toHaveTextContent("form");
  });

  it("点击必填且带默认值的卡片直接运行(回填默认值, 如 adb-debug-activity)", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [
        mkAction("demo-req-def", "必填带默认", {
          params: [
            { id: "EXEC_ID", label: "执行项目", type: "text", required: true, default: "展示语音链路悬框", options: [] },
          ],
        }),
      ],
      errors: [],
    });
    render(wrap());
    await user.click(await screen.findByText("必填带默认"));
    expect(mockRunAction).toHaveBeenCalledWith("demo-req-def", { EXEC_ID: "展示语音链路悬框" });
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
  });

  it("点击全可选无默认值的卡片直接运行(不进表单)", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [
        mkAction("demo-opt", "全可选", {
          params: [
            { id: "TEXT", label: "文本", type: "text", required: false, default: "", options: [] },
          ],
        }),
      ],
      errors: [],
    });
    render(wrap());
    await user.click(await screen.findByText("全可选"));
    expect(mockRunAction).toHaveBeenCalledWith("demo-opt", { TEXT: "" });
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
  });

  it("点击仅带默认值(无必填)的卡片直接运行(不进表单, 如 adb-scrcpy)", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [
        mkAction("demo-opt-def", "可选带默认", {
          params: [
            { id: "MAX_SIZE", label: "尺寸", type: "text", required: false, default: "1280", options: [] },
          ],
        }),
      ],
      errors: [],
    });
    render(wrap());
    await user.click(await screen.findByText("可选带默认"));
    // 直接运行，且把默认值带上
    expect(mockRunAction).toHaveBeenCalledWith("demo-opt-def", { MAX_SIZE: "1280" });
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
  });

  it("点击运行中的卡片回到输出视图(不重复启动)", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [mkAction("demo-run", "直跑")],
      errors: [],
    });
    render(wrap());
    await user.click(await screen.findByText("直跑"));
    expect(mockRunAction).toHaveBeenCalledTimes(1);
    // 仍在运行（done 未发）→ 再点卡片应回到输出视图，不再发 RunAction
    await user.click(screen.getByText("直跑"));
    expect(mockRunAction).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
  });

  it("点击无参数卡片直接运行", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [mkAction("demo-run", "直跑")],
      errors: [],
    });
    render(wrap());
    await user.click(await screen.findByText("直跑"));
    expect(mockRunAction).toHaveBeenCalledWith("demo-run", {});
  });
});
