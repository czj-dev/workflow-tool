import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
  const { view, formSheetOpen, formValues } = useActionRunner();
  return (
    <>
      <div data-testid="view-probe">{view}</div>
      <div data-testid="form-open-probe">{String(formSheetOpen)}</div>
      <div data-testid="form-values-probe">{JSON.stringify(formValues)}</div>
    </>
  );
}

beforeEach(() => {
  mockListActions.mockReset();
  mockRunAction.mockReset().mockResolvedValue(undefined);
  mockOn.mockClear();
  localStorage.clear();
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

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

function mockCardBounds(card: HTMLElement) {
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
    left: 200, top: 200, width: 130, height: 130, right: 330, bottom: 330,
    x: 200, y: 200, toJSON: () => ({}),
  });
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

  it("普通点击在释放指针捕获后仍运行", async () => {
    mockListActions.mockResolvedValue({ actions: [mkAction("capture", "捕获测试", {
      presets: [{ name: "常用", values: {} }],
    })], errors: [] });
    render(wrap());
    const card = await screen.findByRole("button", { name: "捕获测试" });
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.lostPointerCapture(card, { pointerId: 1 });
    fireEvent.click(card);
    expect(mockRunAction).toHaveBeenCalledWith("capture", {});
  });

  it("长按 450ms 展开，拖到预设松开只运行一次", async () => {
    mockListActions.mockResolvedValue({
      actions: [mkAction("demo-pre", "带预设", {
        presets: [
          { name: "微信", values: { APP: "com.tencent.mm" } },
          { name: "抖音", values: { APP: "com.ss.android.ugc.aweme" } },
        ],
      })],
      errors: [],
    });
    render(wrap());
    const card = await screen.findByRole("button", { name: /带预设/ });
    mockCardBounds(card);
    vi.useFakeTimers();
    fireEvent.pointerDown(card, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 265, clientY: 265 });
    act(() => vi.advanceTimersByTime(449));
    expect(screen.queryByTestId("preset-ring")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId("preset-ring")).toBeInTheDocument();
    expect(mockRunAction).not.toHaveBeenCalled();
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 265, clientY: 365 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 265, clientY: 365 });
    fireEvent.click(card);
    expect(mockRunAction).toHaveBeenCalledTimes(1);
    expect(mockRunAction).toHaveBeenCalledWith("demo-pre", { APP: "com.ss.android.ugc.aweme" });
  });

  it("触屏长按开环后阻止原生滚动，提前滑动仍允许滚动", async () => {
    mockListActions.mockResolvedValue({ actions: [mkAction("touch", "触屏卡片", {
      presets: [{ name: "常用", values: { K: "v" } }],
    })], errors: [] });
    render(wrap());
    const card = await screen.findByRole("button", { name: "触屏卡片" });
    mockCardBounds(card);
    vi.useFakeTimers();

    fireEvent.pointerDown(card, { pointerId: 1, pointerType: "touch", button: 0, clientX: 265, clientY: 265 });
    const earlyMove = new Event("touchmove", { bubbles: true, cancelable: true });
    fireEvent(card, earlyMove);
    expect(earlyMove.defaultPrevented).toBe(false);
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 265, clientY: 280 });
    act(() => vi.advanceTimersByTime(450));
    expect(screen.queryByTestId("preset-ring")).not.toBeInTheDocument();
    fireEvent.pointerCancel(card, { pointerId: 1 });

    fireEvent.pointerDown(card, { pointerId: 2, pointerType: "touch", button: 0, clientX: 265, clientY: 265 });
    act(() => vi.advanceTimersByTime(450));
    expect(screen.getByTestId("preset-ring")).toBeInTheDocument();
    const heldMove = new Event("touchmove", { bubbles: true, cancelable: true });
    fireEvent(card, heldMove);
    expect(heldMove.defaultPrevented).toBe(true);
    fireEvent.pointerMove(card, { pointerId: 2, clientX: 265, clientY: 365 });
    fireEvent.pointerUp(card, { pointerId: 2, clientX: 265, clientY: 365 });
    fireEvent.click(card);
    expect(mockRunAction).toHaveBeenCalledExactlyOnceWith("touch", { K: "v" });
  });

  it("拖选扇区时在指针旁显示完整预设名，环外取消后隐藏", async () => {
    const fullName = "推送到临时目录的完整预设名称";
    mockListActions.mockResolvedValue({ actions: [mkAction("long-name", "完整名称", {
      presets: [{ name: fullName, values: {} }],
    })], errors: [] });
    render(wrap());
    const card = await screen.findByRole("button", { name: "完整名称" });
    mockCardBounds(card);
    vi.useFakeTimers();
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 265, clientY: 265 });
    act(() => vi.advanceTimersByTime(450));
    expect(screen.queryByTestId("preset-selection-label")).not.toBeInTheDocument();
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 265, clientY: 365 });
    expect(screen.getByTestId("preset-selection-label")).toHaveTextContent(fullName);
    expect(screen.getByTestId("preset-selection-label")).toHaveStyle({ left: "279px" });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 275, clientY: 365 });
    expect(screen.getByTestId("preset-selection-label")).toHaveStyle({ left: "289px" });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 265, clientY: 500 });
    expect(screen.queryByTestId("preset-selection-label")).not.toBeInTheDocument();
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 265, clientY: 500 });
    expect(mockRunAction).not.toHaveBeenCalled();
  });

  it("键盘选择扇区时也显示完整预设名", async () => {
    const user = userEvent.setup();
    const fullName = "检查设备详细信息的完整名称";
    mockListActions.mockResolvedValue({ actions: [mkAction("keyboard-label", "键盘名称", {
      presets: [{ name: fullName, values: {} }],
    })], errors: [] });
    render(wrap());
    const card = await screen.findByRole("button", { name: "键盘名称" });
    mockCardBounds(card);
    card.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.queryByTestId("preset-selection-label")).not.toBeInTheDocument();
    vi.stubGlobal("innerHeight", 300);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("preset-selection-label")).toHaveTextContent(fullName);
    const selectionLabel = screen.getByTestId("preset-selection-label");
    expect(parseFloat(selectionLabel.style.maxHeight) + parseFloat(selectionLabel.style.top)).toBeCloseTo(window.innerHeight - 8);
    expect(within(screen.getByTestId("preset-ring")).getByRole("option", { name: fullName })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("preset-selection-label")).not.toBeInTheDocument();
  });

  it("Shift+F10 打开预设环，方向键选择，Enter 确认", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [mkAction("demo-more", "多预设", {
        presets: [{ name: "甲", values: { K: "1" } }, { name: "乙", values: { K: "2" } }],
      })],
      errors: [],
    });
    render(wrap());
    const card = await screen.findByRole("button", { name: /多预设/ });
    mockCardBounds(card);
    card.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByTestId("preset-ring")).toBeInTheDocument();
    expect(mockRunAction).not.toHaveBeenCalled();
    await user.keyboard("{ArrowRight}{ArrowRight}{Enter}");
    expect(mockRunAction).toHaveBeenCalledWith("demo-more", { K: "2" });
    expect(screen.queryByTestId("preset-ring")).not.toBeInTheDocument();
  });

  it("预设环打开时 Enter 和空格不执行默认动作", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({ actions: [mkAction("keyboard-guard", "防误触", {
      presets: [{ name: "重启到恢复模式", values: {} }],
    })], errors: [] });
    render(wrap());
    const card = await screen.findByRole("button", { name: "防误触" });
    mockCardBounds(card);
    card.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}{Enter} ");
    expect(mockRunAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("preset-ring")).toBeInTheDocument();
    await user.keyboard("{ArrowRight} ");
    expect(mockRunAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("preset-ring")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(mockRunAction).toHaveBeenCalledTimes(1);
  });

  it("取消环形选择后，默认点击仍只触发一次", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [mkAction("demo-stop", "防冒泡", { presets: [{ name: "一号", values: { K: "x" } }] })],
      errors: [],
    });
    render(wrap());
    const card = await screen.findByRole("button", { name: /防冒泡/ });
    mockCardBounds(card);
    card.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}{Escape}");
    expect(mockRunAction).not.toHaveBeenCalled();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByTestId("preset-ring")).toBeInTheDocument();
    await user.keyboard("{Tab}");
    expect(screen.queryByTestId("preset-ring")).not.toBeInTheDocument();
    await user.click(card);
    expect(mockRunAction).toHaveBeenCalledTimes(1);
    await user.click(card);
    expect(mockRunAction).toHaveBeenCalledTimes(1);
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

  it("键盘激活编辑按钮只打开表单，不启动卡片动作", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({ actions: [mkAction("keyboard-edit", "键盘编辑")], errors: [] });
    render(wrap());
    const card = await screen.findByRole("button", { name: "键盘编辑" });
    const edit = within(card).getByRole("button", { name: "编辑参数" });
    edit.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("form-open-probe")).toHaveTextContent("true");
    expect(mockRunAction).not.toHaveBeenCalled();
  });

  it("环打开期间禁止全窗口文字选择，环外松开后恢复", async () => {
    mockListActions.mockResolvedValue({ actions: [mkAction("select", "防止文本选择", {
      presets: [{ name: "常用", values: {} }],
    })], errors: [] });
    render(wrap());
    const card = await screen.findByRole("button", { name: "防止文本选择" });
    mockCardBounds(card);
    expect(card.parentElement).toHaveClass("select-none");
    expect(card.closest("main")).not.toHaveClass("select-none");
    const selection = window.getSelection();
    selection?.selectAllChildren(screen.getByText("全部动作"));
    expect(selection?.rangeCount).toBe(1);
    expect(document.body).not.toHaveClass("preset-ring-selecting");
    vi.useFakeTimers();
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 265, clientY: 265 });
    act(() => vi.advanceTimersByTime(450));
    expect(document.body).toHaveClass("preset-ring-selecting");
    expect(selection?.rangeCount).toBe(0);
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 5, clientY: 500 });
    expect(document.body).toHaveClass("preset-ring-selecting");
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 5, clientY: 500 });
    expect(document.body).not.toHaveClass("preset-ring-selecting");
    expect(mockRunAction).not.toHaveBeenCalled();
  });

  it("环因指针取消、键盘 Escape 或卸载关闭时恢复文字选择", async () => {
    mockListActions.mockResolvedValue({ actions: [mkAction("restore", "取消禁选", {
      presets: [{ name: "常用", values: {} }],
    })], errors: [] });
    const { unmount } = render(wrap());
    const card = await screen.findByRole("button", { name: "取消禁选" });
    mockCardBounds(card);
    vi.useFakeTimers();
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 265, clientY: 265 });
    act(() => vi.advanceTimersByTime(450));
    expect(document.body).toHaveClass("preset-ring-selecting");
    fireEvent.pointerCancel(card, { pointerId: 1 });
    expect(document.body).not.toHaveClass("preset-ring-selecting");
    fireEvent.keyDown(card, { shiftKey: true, key: "F10" });
    expect(screen.getByTestId("preset-ring")).toBeInTheDocument();
    expect(document.body).not.toHaveClass("preset-ring-selecting");
    fireEvent.keyDown(card, { key: "Escape" });
    expect(document.body).not.toHaveClass("preset-ring-selecting");
    fireEvent.pointerDown(card, { pointerId: 2, button: 0, clientX: 265, clientY: 265 });
    act(() => vi.advanceTimersByTime(450));
    expect(document.body).toHaveClass("preset-ring-selecting");
    unmount();
    expect(document.body).not.toHaveClass("preset-ring-selecting");
  });

  it("无动作时渲染空态指引(不崩)", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    render(wrap());
    expect(await screen.findByText("暂无动作")).toBeInTheDocument();
    expect(screen.getByText(/actions\/ 目录新增 YAML/)).toBeInTheDocument();
  });

  it("稀疏预设保留未填写的可选参数供后端环境变量回退", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({ actions: [mkAction("sparse", "稀疏预设", {
      params: [{ id: "OPTIONAL", label: "可选", type: "text", required: false, default: "", options: [] }],
      presets: [{ name: "常用", values: { FILTER: "tag" } }],
    })], errors: [] });
    render(wrap());
    const card = await screen.findByRole("button", { name: "稀疏预设" });
    mockCardBounds(card);
    card.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}{ArrowRight}{Enter}");
    expect(mockRunAction).toHaveBeenCalledWith("sparse", { FILTER: "tag" });
  });

  it("预设显式留空必填字段时打开预填表单", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [mkAction("demo-pedit", "预设编辑", {
        params: [
          { id: "LOCAL_PATH", label: "本地文件", type: "file", required: true, default: "/tmp/file", options: [] },
          { id: "REMOTE_PATH", label: "远端", type: "text", required: true, default: "/sdcard/", options: [] },
        ],
        presets: [{ name: "微信", values: { LOCAL_PATH: "" } }],
      })],
      errors: [],
    });
    render(wrap());
    const card = await screen.findByRole("button", { name: /预设编辑/ });
    mockCardBounds(card);
    card.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}{ArrowRight}{Enter}");
    expect(mockRunAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("form-open-probe")).toHaveTextContent("true");
    expect(JSON.parse(screen.getByTestId("form-values-probe").textContent ?? "{}")).toEqual({ LOCAL_PATH: "", REMOTE_PATH: "/sdcard/" });
  });

  it("松开在环外或指针取消时不运行，移动手势不阻断滚动", async () => {
    mockListActions.mockResolvedValue({ actions: [mkAction("cancel", "取消选择", {
      presets: [{ name: "常用", values: { K: "v" } }],
    })], errors: [] });
    render(wrap());
    const card = await screen.findByRole("button", { name: /取消选择/ });
    mockCardBounds(card);
    vi.useFakeTimers();
    fireEvent.pointerDown(card, { pointerId: 1, pointerType: "touch", button: 0, clientX: 265, clientY: 265 });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 265, clientY: 280 });
    act(() => vi.advanceTimersByTime(450));
    expect(screen.queryByTestId("preset-ring")).not.toBeInTheDocument();
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 265, clientY: 280 });
    fireEvent.pointerDown(card, { pointerId: 2, button: 0, clientX: 265, clientY: 265 });
    fireEvent.pointerCancel(card, { pointerId: 2 });
    act(() => vi.advanceTimersByTime(450));
    expect(screen.queryByTestId("preset-ring")).not.toBeInTheDocument();
    fireEvent.pointerDown(card, { pointerId: 3, button: 0, clientX: 265, clientY: 265 });
    act(() => vi.advanceTimersByTime(450));
    fireEvent.pointerUp(card, { pointerId: 3, clientX: 5, clientY: 5 });
    fireEvent.click(card);
    expect(screen.queryByTestId("preset-ring")).not.toBeInTheDocument();
    expect(mockRunAction).not.toHaveBeenCalled();
  });

  it("有预设的卡片仍能直接编辑参数，无预设的卡片不打开环", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({ actions: [
      mkAction("edit-preset", "有预设", { presets: [{ name: "常用", values: {} }] }),
      mkAction("no-preset", "无预设"),
    ], errors: [] });
    render(wrap());
    const presetCard = await screen.findByRole("button", { name: "有预设" });
    await user.click(within(presetCard).getByRole("button", { name: "编辑参数" }));
    expect(screen.getByTestId("form-open-probe")).toHaveTextContent("true");
    expect(mockRunAction).not.toHaveBeenCalled();
    const card = screen.getByRole("button", { name: "无预设" });
    mockCardBounds(card);
    card.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.queryByTestId("preset-ring")).not.toBeInTheDocument();
  });
});
