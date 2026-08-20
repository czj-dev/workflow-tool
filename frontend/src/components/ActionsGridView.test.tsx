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

// ViewProbe：暴露 provider 内部 view / formSheetOpen 状态，让用例可断言点击后的路由与抽屉开合。
function ViewProbe() {
  const { view, formSheetOpen } = useActionRunner();
  return (
    <>
      <div data-testid="view-probe">{view}</div>
      <div data-testid="form-open-probe">{String(formSheetOpen)}</div>
    </>
  );
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
    // onEdit → selectPreset("") → 打开表单抽屉（主区视图原地不动）
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
    expect(screen.getByTestId("form-open-probe")).toHaveTextContent("true");
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
    // 用 role 查询：Tooltip 打开后其内容也含 title 文本，getByText 会命中多个
    await user.click(await screen.findByRole("button", { name: /直跑/ }));
    expect(mockRunAction).toHaveBeenCalledTimes(1);
    // 仍在运行（done 未发）→ 再点卡片应回到输出视图，不再发 RunAction
    await user.click(screen.getByRole("button", { name: /直跑/ }));
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

  it("点击 preset 分段格直跑该预设(不进表单)", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [
        mkAction("demo-pre", "带预设", {
          presets: [
            { name: "微信", values: { APP: "com.tencent.mm" } },
            { name: "抖音", values: { APP: "com.ss.android.ugc.aweme" } },
          ],
        }),
      ],
      errors: [],
    });
    render(wrap());
    await user.click(await screen.findByText("微信"));
    expect(mockRunAction).toHaveBeenCalledTimes(1);
    expect(mockRunAction).toHaveBeenCalledWith("demo-pre", { APP: "com.tencent.mm" });
    // background=false → preset 运行会切 output 视图
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
    // 有 preset 键的编辑走背面 ✎/+N，正面不出现「编辑参数」入口
    expect(screen.queryByRole("button", { name: "编辑参数" })).not.toBeInTheDocument();
    // 键身原生 tooltip 含预设全名列表（翻面空窗内可预览）
    expect(screen.getByRole("button", { name: /带预设/ })).toHaveAttribute(
      "title",
      expect.stringContaining("微信 / 抖音")
    );
  });

  it("点击 +N 格进表单选其余预设(不运行)", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [
        mkAction("demo-more", "多预设", {
          presets: [
            { name: "甲", values: { K: "1" } },
            { name: "乙", values: { K: "2" } },
            { name: "丙", values: { K: "3" } },
            { name: "丁", values: { K: "4" } },
            { name: "戊", values: { K: "5" } },
          ],
        }),
      ],
      errors: [],
    });
    render(wrap());
    await user.click(await screen.findByText("+2"));
    expect(mockRunAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("form-open-probe")).toHaveTextContent("true");
  });

  it("点击 preset 分段格不冒泡触发键身默认运行", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [
        mkAction("demo-stop", "防冒泡", {
          presets: [{ name: "一号", values: { K: "x" } }],
        }),
      ],
      errors: [],
    });
    render(wrap());
    await user.click(await screen.findByText("一号"));
    // 仅 preset 那一次调用，无第二次默认直跑
    expect(mockRunAction).toHaveBeenCalledTimes(1);
    expect(mockRunAction).toHaveBeenCalledWith("demo-stop", { K: "x" });
  });

  it("点击 hover 浮现的编辑入口进表单", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [mkAction("demo-gear", "齿轮")],
      errors: [],
    });
    render(wrap());
    const gear = await screen.findByRole("button", { name: "编辑参数" });
    await user.click(gear);
    expect(mockRunAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("form-open-probe")).toHaveTextContent("true");
  });

  it("无动作时渲染空态指引(不崩)", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    render(wrap());
    expect(await screen.findByText("暂无动作")).toBeInTheDocument();
    expect(screen.getByText(/actions\/ 目录新增 YAML/)).toBeInTheDocument();
  });

  it("点击 preset 格内 ✎ 进表单并预填该预设(不运行)", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [
        mkAction("demo-pedit", "预设编辑", {
          presets: [{ name: "微信", values: { APP: "com.tencent.mm" } }],
        }),
      ],
      errors: [],
    });
    render(wrap());
    const edit = await screen.findByRole("button", { name: "编辑预设参数" });
    await user.click(edit);
    expect(mockRunAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("form-open-probe")).toHaveTextContent("true");
  });
});
