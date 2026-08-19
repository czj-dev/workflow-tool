import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

describe("FragmentsSheet - 开关", () => {
  it("默认关闭，⌘K 打开显示片段列表", async () => {
    renderSheet();
    expect(screen.queryByText("看日志")).not.toBeInTheDocument();
    pressHotkey();
    expect(await screen.findByText("看日志")).toBeInTheDocument();
  });

  it("再按 ⌘K 关闭；Ctrl+K 同样生效", async () => {
    renderSheet();
    pressHotkey(true);
    await screen.findByText("看日志");
    pressHotkey(true);
    await waitFor(() =>
      expect(screen.queryByText("看日志")).not.toBeInTheDocument(),
    );
    pressHotkey(false);
    expect(await screen.findByText("看日志")).toBeInTheDocument();
  });

  it("Esc 关闭抽屉", async () => {
    renderSheet();
    pressHotkey();
    await screen.findByText("看日志");
    pressEscape();
    await waitFor(() =>
      expect(screen.queryByText("看日志")).not.toBeInTheDocument(),
    );
  });
});

describe("FragmentsSheet - 抽屉内操作", () => {
  it("复制时展开 ${VAR} 写入剪贴板", async () => {
    const user = userEvent.setup();
    stubClipboard(); // userEvent.setup 会接管 navigator.clipboard，之后再打回桩
    renderSheet();
    pressHotkey();
    await screen.findByText("看日志");
    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(mockWriteText).toHaveBeenCalledWith(
      "adb logcat -d > /tmp/logs/today.log",
    );
  });

  it("头部关闭按钮关闭抽屉", async () => {
    const user = userEvent.setup();
    renderSheet();
    pressHotkey();
    await screen.findByText("看日志");
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByText("看日志")).not.toBeInTheDocument(),
    );
  });

  it("打开后焦点落在搜索框，而非关闭按钮", async () => {
    renderSheet();
    pressHotkey();
    const search = await screen.findByPlaceholderText("搜索 标题 / 内容 / 标签");
    await waitFor(() => expect(search).toHaveFocus());
  });
});
