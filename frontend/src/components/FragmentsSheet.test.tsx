import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../i18n";
import { TooltipProvider } from "@/components/ui/tooltip";

const { mockGetFragments, mockSetFragments, mockWriteText } = vi.hoisted(() => ({
  mockGetFragments: vi.fn(),
  mockSetFragments: vi.fn(() => Promise.resolve()),
  mockWriteText: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  ListAiTasks: vi.fn().mockResolvedValue({ tasks: [], errors: [] }),
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({ LOGS_DIR: "/tmp/logs" }),
  SetGlobalConfig: vi.fn().mockResolvedValue(undefined),
  GetFragments: mockGetFragments,
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: mockSetFragments,
  PickDirectory: vi.fn().mockResolvedValue(""),
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => ({}) } }));

import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { FragmentsSheet } from "./FragmentsSheet";

const sample = [
  {
    title: "看日志",
    content: "adb logcat -d > ${LOGS_DIR}/today.log",
    tags: ["adb"],
  },
];

function stubClipboard() {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: mockWriteText },
    configurable: true,
  });
}

beforeEach(async () => {
  mockGetFragments.mockReset().mockResolvedValue(sample);
  mockSetFragments.mockReset().mockResolvedValue(undefined);
  mockWriteText.mockReset().mockResolvedValue(undefined);
  stubClipboard();
  await i18n.changeLanguage("zh");
});

function renderSheet() {
  return render(
    <TooltipProvider>
      <ActionRunnerProvider>
        <FragmentsSheet />
      </ActionRunnerProvider>
    </TooltipProvider>,
  );
}

// meta=true → ⌘K（macOS）；meta=false → Ctrl+K（Windows）
const pressHotkey = (meta = true) =>
  fireEvent.keyDown(window, { key: "k", metaKey: meta, ctrlKey: !meta });

// Esc 打在抽屉面板上（冒泡到 base-ui 的 document 监听）
const pressEscape = () => {
  const el = document.querySelector('[data-slot="sheet-content"]');
  if (el) fireEvent.keyDown(el, { key: "Escape", bubbles: true });
};

// 片段卡按「标题即复制按钮」的可访问名定位：分区头副行也含标题文本（拼进分区头
// 按钮名），纯 getByText 会命中两个节点，而按钮名永远不会整条等于标题。
const card = (title: string) => screen.getByRole("button", { name: title });
const findCard = (title: string) => screen.findByRole("button", { name: title });
const noCard = (title: string) =>
  screen.queryByRole("button", { name: title });

describe("FragmentsSheet - 开关", () => {
  it("默认关闭，⌘K 打开显示片段列表", async () => {
    renderSheet();
    expect(noCard("看日志")).not.toBeInTheDocument();
    pressHotkey();
    expect(await findCard("看日志")).toBeInTheDocument();
  });

  it("再按 ⌘K 关闭；Ctrl+K 同样生效", async () => {
    renderSheet();
    pressHotkey(true);
    await findCard("看日志");
    pressHotkey(true);
    await waitFor(() => expect(noCard("看日志")).not.toBeInTheDocument());
    pressHotkey(false);
    expect(await findCard("看日志")).toBeInTheDocument();
  });

  it("Esc 关闭抽屉", async () => {
    renderSheet();
    pressHotkey();
    await findCard("看日志");
    pressEscape();
    await waitFor(() => expect(noCard("看日志")).not.toBeInTheDocument());
  });
});

describe("FragmentsSheet - 抽屉内操作", () => {
  it("面板与整页一致：页签 + 琥珀分区 + 卡片颜色，不显示「N 个片段 · G 个标签」", async () => {
    const user = userEvent.setup();
    mockGetFragments.mockResolvedValue([
      { title: "绿片段", content: "a", tags: ["adb"], color: "green" },
      { title: "素片段", content: "b", tags: ["rg"] },
    ]);
    renderSheet();
    pressHotkey();
    expect(await screen.findByRole("tab", { name: /^全部/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^adb/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^rg/ })).toBeInTheDocument();

    // 分区固定琥珀；带色的卡片带自己的 data-amb
    expect(document.querySelector('[data-sec="adb"]')).toHaveAttribute(
      "data-amb",
      "amber",
    );
    const greenCard = screen
      .getByRole("button", { name: "绿片段" })
      .closest("article");
    expect(greenCard).toHaveAttribute("data-amb", "green");

    // 面板不显示页头的统计行
    expect(screen.queryByText(/个片段 ·/)).not.toBeInTheDocument();

    // 选中标签后只剩该标签的片段
    await user.click(screen.getByRole("tab", { name: /^rg/ }));
    expect(screen.getByRole("button", { name: "素片段" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "绿片段" })).not.toBeInTheDocument();
  });

  it("面板内新增片段的弹窗带色卡，保存载荷带默认颜色", async () => {
    const user = userEvent.setup();
    renderSheet();
    pressHotkey();
    await findCard("看日志");
    await user.click(screen.getByRole("button", { name: "新增" }));

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("radiogroup", { name: "卡片颜色" }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("标题"), "面板片段");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(mockSetFragments).toHaveBeenCalledWith([
      sample[0],
      { title: "面板片段", content: "", tags: [], color: "amber" },
    ]);
  });

  it("对话框打开时 Esc 归对话框：弹窗关闭，抽屉不关", async () => {
    const user = userEvent.setup();
    renderSheet();
    pressHotkey();
    await findCard("看日志");
    await user.click(screen.getByRole("button", { name: "新增" }));
    expect(screen.getByText("新增片段")).toBeInTheDocument();

    pressEscape();
    await waitFor(() =>
      expect(screen.queryByText("新增片段")).not.toBeInTheDocument(),
    );
    // 抽屉仍开着
    expect(card("看日志")).toBeInTheDocument();

    // 弹窗关闭后再按 Esc 才关抽屉
    pressEscape();
    await waitFor(() => expect(noCard("看日志")).not.toBeInTheDocument());
  });

  it("复制时展开 ${VAR} 写入剪贴板", async () => {
    const user = userEvent.setup();
    stubClipboard(); // userEvent.setup 会接管 navigator.clipboard，之后再打回桩
    renderSheet();
    pressHotkey();
    await findCard("看日志");
    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(mockWriteText).toHaveBeenCalledWith(
      "adb logcat -d > /tmp/logs/today.log",
    );
  });

  it("头部关闭按钮关闭抽屉", async () => {
    const user = userEvent.setup();
    renderSheet();
    pressHotkey();
    await findCard("看日志");
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(noCard("看日志")).not.toBeInTheDocument());
  });

  it("打开后焦点落在搜索框，而非关闭按钮", async () => {
    renderSheet();
    pressHotkey();
    const search = await screen.findByPlaceholderText("搜索 标题 / 内容 / 标签");
    await waitFor(() => expect(search).toHaveFocus());
  });
});
