import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
// back-to-grid：模拟「运行中切回 grid」的操作路径（前台点火会切走视图，grid 卸载重挂）。
function ViewProbe() {
  const { view, formSheetOpen, formValues, setView } = useActionRunner();
  return (
    <>
      <div data-testid="view-probe">{view}</div>
      <div data-testid="form-open-probe">{String(formSheetOpen)}</div>
      <div data-testid="form-values-probe">{JSON.stringify(formValues)}</div>
      <button data-testid="back-to-grid" onClick={() => setView("actions-grid")}>back</button>
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
  // 环锚点在 .action-hub（size-10=40px），中心 (220,220)；形变后圆盘直径 = 40×1.8 = 72
  // → inner=36，由视口（jsdom 默认 1024×768）得 outer=min(178,114,...)=114。
  // 卡片矩形 mock 保留（部分分支仍读取），几何推导已全部走 hub。
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
    left: 200, top: 200, width: 260, height: 72, right: 460, bottom: 272,
    x: 200, y: 200, toJSON: () => ({}),
  });
  const hub = card.querySelector<HTMLElement>(".action-hub");
  if (hub) {
    vi.spyOn(hub, "getBoundingClientRect").mockReturnValue({
      left: 200, top: 200, width: 40, height: 40, right: 240, bottom: 240,
      x: 200, y: 200, toJSON: () => ({}),
    });
  }
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

// 双态契约辅助：紧凑态 quick 入口 / 展开态 RUN 胶囊（二者不同时存在，同用 /运行/ 匹配）。
const quickRun = (card: HTMLElement) => within(card).getByRole("button", { name: /运行/ });

describe("ActionsGridView", () => {
  it("紧凑态 quick 入口对必填无默认值的卡片进表单(不直接执行)", async () => {
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
    const card = await screen.findByRole("button", { name: "必填无默认" });
    await user.click(quickRun(card));
    expect(mockRunAction).not.toHaveBeenCalled();
    // onEdit → selectPreset("") → 打开表单抽屉（主区视图原地不动）
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
    expect(screen.getByTestId("form-open-probe")).toHaveTextContent("true");
  });

  it("紧凑态 quick 入口运行必填且带默认值的卡片(回填默认值, 如 adb-debug-activity)", async () => {
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
    const card = await screen.findByRole("button", { name: "必填带默认" });
    await user.click(quickRun(card));
    expect(mockRunAction).toHaveBeenCalledWith("demo-req-def", { EXEC_ID: "展示语音链路悬框" });
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
  });

  it("紧凑态 quick 入口运行全可选无默认值的卡片(不进表单)", async () => {
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
    const card = await screen.findByRole("button", { name: "全可选" });
    await user.click(quickRun(card));
    expect(mockRunAction).toHaveBeenCalledWith("demo-opt", { TEXT: "" });
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
  });

  it("紧凑态 quick 入口运行仅带默认值(无必填)的卡片(不进表单, 如 adb-scrcpy)", async () => {
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
    const card = await screen.findByRole("button", { name: "可选带默认" });
    await user.click(quickRun(card));
    // 直接运行，且把默认值带上
    expect(mockRunAction).toHaveBeenCalledWith("demo-opt-def", { MAX_SIZE: "1280" });
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
  });

  it("展开态「编辑配置」进入该 action 的 YAML 编辑页", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({ actions: [mkAction("demo-yml", "编配卡")], errors: [] });
    render(wrap());
    const card = await screen.findByRole("button", { name: "编配卡" });
    await user.click(card); // 单击=就地展开
    await user.click(within(card).getByRole("button", { name: "编辑配置" }));
    expect(screen.getByTestId("view-probe")).toHaveTextContent("edit");
  });

  it("运行中的卡：卡身点击回跳输出视图(不展开不重跑)", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [mkAction("demo-run", "直跑")],
      errors: [],
    });
    render(wrap());
    const card = await screen.findByRole("button", { name: "直跑" });
    await user.click(quickRun(card)); // 前台运行：切到 output，done 未发 → 仍在运行
    expect(mockRunAction).toHaveBeenCalledTimes(1);
    // 切回 grid：卡面显示运行中读数，卡身点击应回跳输出而不是展开
    await user.click(screen.getByTestId("back-to-grid"));
    const card2 = screen.getByRole("button", { name: "直跑" });
    await user.click(card2);
    expect(mockRunAction).toHaveBeenCalledTimes(1);
    expect(card2).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("view-probe").textContent).toMatch(/output/);
  });

  it("点运行中的读数回到输出视图(不重复启动)", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [mkAction("demo-run", "直跑")],
      errors: [],
    });
    render(wrap());
    const card = await screen.findByRole("button", { name: "直跑" });
    await user.click(quickRun(card));
    expect(mockRunAction).toHaveBeenCalledTimes(1);
    // 仍在运行（done 未发）→ quick 入口转为读数态，点击应回到输出视图，不再发 RunAction
    await user.click(screen.getByRole("button", { name: /运行中/ }));
    expect(mockRunAction).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
  });

  it("单击卡片就地展开，再单击收起(展开态显形 RUN 主控)", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [mkAction("demo-expand", "开关卡")],
      errors: [],
    });
    render(wrap());
    const card = await screen.findByRole("button", { name: "开关卡" });
    await user.click(card);
    expect(card).toHaveAttribute("aria-expanded", "true");
    expect(within(card).getByRole("button", { name: /运行/ })).toBeInTheDocument();
    await user.click(card);
    expect(card).toHaveAttribute("aria-expanded", "false");
    expect(mockRunAction).not.toHaveBeenCalled();
  });

  it("展开态 RUN 胶囊前台运行并切到输出视图", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [mkAction("demo-run", "直跑")],
      errors: [],
    });
    render(wrap());
    const card = await screen.findByRole("button", { name: "直跑" });
    await user.click(card);
    await user.click(within(card).getByRole("button", { name: /运行/ }));
    expect(mockRunAction).toHaveBeenCalledWith("demo-run", {});
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
  });

  it("展开态 chips 直接以预设值运行", async () => {
    const user = userEvent.setup();
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
    await user.click(card);
    await user.click(within(card).getByRole("button", { name: /微信/ }));
    await waitFor(() => expect(mockRunAction).toHaveBeenCalledWith("demo-pre", { APP: "com.tencent.mm" }));
  });

  it("普通点击在释放指针捕获后正常展开(不误运行)", async () => {
    mockListActions.mockResolvedValue({ actions: [mkAction("capture", "捕获测试", {
      presets: [{ name: "常用", values: {} }],
    })], errors: [] });
    render(wrap());
    const card = await screen.findByRole("button", { name: "捕获测试" });
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.lostPointerCapture(card, { pointerId: 1 });
    fireEvent.click(card);
    // 快速点按（未达 450ms）→ 单击契约：就地展开而非运行
    expect(card).toHaveAttribute("aria-expanded", "true");
    expect(mockRunAction).not.toHaveBeenCalled();
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
    // (265,310) 距环心 (220,220) r≈101，落在下方扇区（抖音，index 1）；
    // y 取 310 而非 315：选中扇区外移 6px 后仍需在 outer=114 内
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 265, clientY: 310 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 265, clientY: 310 });
    fireEvent.click(card);
    // 摘瓣动画(300ms)结束后才执行事件
    act(() => vi.advanceTimersByTime(400));
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
    fireEvent.pointerMove(card, { pointerId: 2, clientX: 265, clientY: 310 });
    fireEvent.pointerUp(card, { pointerId: 2, clientX: 265, clientY: 310 });
    fireEvent.click(card);
    // 摘瓣动画(300ms)结束后才执行事件
    act(() => vi.advanceTimersByTime(400));
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
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 265, clientY: 310 });
    expect(screen.getByTestId("preset-selection-label")).toHaveTextContent(fullName);
    expect(screen.getByTestId("preset-selection-label")).toHaveStyle({ left: "279px" });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 275, clientY: 310 });
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
    // 摘瓣动画(300ms)结束后才执行事件
    await waitFor(() => {
      expect(mockRunAction).toHaveBeenCalledWith("demo-more", { K: "2" });
      expect(screen.queryByTestId("preset-ring")).not.toBeInTheDocument();
    });
  });

  it("预设环打开时 Enter 和空格不展开卡片也不执行默认动作", async () => {
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
    expect(card).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("preset-ring")).toBeInTheDocument();
    await user.keyboard("{ArrowRight} ");
    expect(mockRunAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("preset-ring")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    // 摘瓣动画(300ms)结束后才执行事件
    await waitFor(() => expect(mockRunAction).toHaveBeenCalledTimes(1));
  });

  it("取消环形选择后，单击卡片只展开不误运行", async () => {
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
    // 关环退场动画(210ms)结束后才卸载
    await waitFor(() => expect(screen.queryByTestId("preset-ring")).not.toBeInTheDocument());
    await user.click(card);
    // 单击契约：展开而非运行
    expect(mockRunAction).not.toHaveBeenCalled();
    expect(card).toHaveAttribute("aria-expanded", "true");
    await user.click(within(card).getByRole("button", { name: /一号/ }));
    expect(mockRunAction).toHaveBeenCalledWith("demo-stop", { K: "x" });
  });

  it("展开态编辑表单入口进表单(不运行)", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [mkAction("demo-gear", "齿轮", {
        params: [{ id: "TEXT", label: "文本", type: "text", required: false, default: "x", options: [] }],
      })],
      errors: [],
    });
    render(wrap());
    const card = await screen.findByRole("button", { name: "齿轮" });
    await user.click(card);
    await user.click(within(card).getByRole("button", { name: "编辑表单" }));
    expect(mockRunAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("form-open-probe")).toHaveTextContent("true");
  });

  it("键盘激活编辑按钮只打开表单，不启动卡片动作", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [mkAction("keyboard-edit", "键盘编辑", {
        params: [{ id: "TEXT", label: "文本", type: "text", required: false, default: "x", options: [] }],
      })],
      errors: [],
    });
    render(wrap());
    const card = await screen.findByRole("button", { name: "键盘编辑" });
    await user.click(card);
    const edit = within(card).getByRole("button", { name: "编辑表单" });
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

  it("头部搜索按标题/id/描述过滤，无匹配显示空态", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [
        mkAction("adb-foo", "甲动作", { description: "描述一" }),
        mkAction("log-bar", "乙动作", { description: "描述二" }),
      ],
      errors: [],
    });
    render(wrap());
    await screen.findByText("甲动作");
    const box = screen.getByPlaceholderText("搜索 名称 / id / 描述");
    // 按 id 前缀命中
    await user.type(box, "adb");
    expect(screen.getByText("甲动作")).toBeInTheDocument();
    expect(screen.queryByText("乙动作")).not.toBeInTheDocument();
    await user.clear(box);
    // 按标题命中
    await user.type(box, "乙动作");
    expect(screen.getByText("乙动作")).toBeInTheDocument();
    expect(screen.queryByText("甲动作")).not.toBeInTheDocument();
    await user.clear(box);
    // 无匹配 → 空态
    await user.type(box, "zzz");
    expect(screen.getByText("没有匹配的动作")).toBeInTheDocument();
  });

  it("YAML color 字段优先于组序循环注入 --amb", async () => {
    mockListActions.mockResolvedValue({
      actions: [
        mkAction("demo-plain", "缺省色卡"),
        mkAction("demo-blue", "蓝色卡", { color: "blue" }),
      ],
      errors: [],
    });
    render(wrap());
    const plain = await screen.findByRole("button", { name: "缺省色卡" });
    const blue = screen.getByRole("button", { name: "蓝色卡" });
    // 同组（demo，组序 0=amber）：未写 color 回落组循环，写了用逐卡 token
    expect(plain.style.getPropertyValue("--amb")).toBe("var(--amb-amber)");
    expect(blue.style.getPropertyValue("--amb")).toBe("var(--amb-blue)");
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
    // 摘瓣动画(300ms)结束后才执行事件
    await waitFor(() => expect(mockRunAction).toHaveBeenCalledWith("sparse", { FILTER: "tag" }));
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
    // 摘瓣动画(300ms)结束后才走预填表单分支
    await waitFor(() => expect(screen.getByTestId("form-open-probe")).toHaveTextContent("true"));
    expect(mockRunAction).not.toHaveBeenCalled();
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
    // 关环退场动画(RING_EXIT_MS=210)结束后才卸载
    act(() => vi.advanceTimersByTime(250));
    expect(screen.queryByTestId("preset-ring")).not.toBeInTheDocument();
    // 环外松开 → 抑制后续 click（不展开不运行）
    expect(card).toHaveAttribute("aria-expanded", "false");
    expect(mockRunAction).not.toHaveBeenCalled();
  });

  it("有预设的卡片展开后仍能编辑表单，无预设的卡片不打开环", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({ actions: [
      mkAction("edit-preset", "有预设", {
        params: [{ id: "T", label: "文本", type: "text", required: false, default: "", options: [] }],
        presets: [{ name: "常用", values: {} }],
      }),
      mkAction("no-preset", "无预设"),
    ], errors: [] });
    render(wrap());
    const presetCard = await screen.findByRole("button", { name: "有预设" });
    await user.click(presetCard);
    await user.click(within(presetCard).getByRole("button", { name: "编辑表单" }));
    expect(screen.getByTestId("form-open-probe")).toHaveTextContent("true");
    expect(mockRunAction).not.toHaveBeenCalled();
    const card = screen.getByRole("button", { name: "无预设" });
    mockCardBounds(card);
    card.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.queryByTestId("preset-ring")).not.toBeInTheDocument();
  });
});
