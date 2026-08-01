import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../i18n";

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
  SetFragments: mockSetFragments,
  PickDirectory: vi.fn().mockResolvedValue(""),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => ({}) } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { FragmentsView } from "./FragmentsView";

const sample = [
  {
    title: "看日志",
    content: "adb logcat -d > ${LOGS_DIR}/today.log",
    tags: ["adb", "logcat"],
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

function renderView() {
  return render(
    <SidebarProvider>
      <ActionRunnerProvider>
        <FragmentsView />
      </ActionRunnerProvider>
    </SidebarProvider>
  );
}

describe("FragmentsView - 使用视图", () => {
  it("按 tag 分组展示片段标题和预览", async () => {
    renderView();
    // 使用视图默认展示，按 tag 归类
    expect(await screen.findByText("adb")).toBeInTheDocument();
    expect(screen.getByText("logcat")).toBeInTheDocument();
    // 同一片段在两个 tag 组各出现一次
    expect(screen.getAllByText("看日志")).toHaveLength(2);
    // 预览中变量已替换
    expect(
      screen.getAllByText("adb logcat -d > /tmp/logs/today.log")
    ).toHaveLength(2);
  });

  it("复制时把 ${VAR} 替换为全局配置的值", async () => {
    const user = userEvent.setup();
    stubClipboard();
    renderView();
    await screen.findByText("adb");
    const btns = screen.getAllByRole("button", { name: "复制" });
    await user.click(btns[0]);
    expect(mockWriteText).toHaveBeenCalledWith(
      "adb logcat -d > /tmp/logs/today.log"
    );
  });

  it("未命中的变量保留原样", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE}", tags: [] },
    ]);
    const user = userEvent.setup();
    stubClipboard();
    renderView();
    await screen.findByText("x");
    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(mockWriteText).toHaveBeenCalledWith("echo ${NOPE}");
  });

  it("无 tag 的片段归入「未分类」", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "杂项", content: "ls", tags: [] },
    ]);
    renderView();
    expect(await screen.findByText("未分类")).toBeInTheDocument();
    expect(screen.getByText("杂项")).toBeInTheDocument();
  });
});

describe("FragmentsView - 编辑视图", () => {
  it("点编辑进入编辑模式，显示表单字段", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("adb");
    await user.click(screen.getByRole("tab", { name: "编辑" }));
    // 编辑模式展示输入框
    expect(screen.getByDisplayValue("看日志")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("adb logcat -d > ${LOGS_DIR}/today.log")
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("adb, logcat")).toBeInTheDocument();
  });

  it("改动后保存调用 SetFragments，tags 由逗号分隔转数组", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("adb");
    await user.click(screen.getByRole("tab", { name: "编辑" }));
    const titleInput = await screen.findByDisplayValue("看日志");
    const saveBtn = screen.getByRole("button", { name: "保存" });
    expect(saveBtn).toBeDisabled();
    await user.type(titleInput, "2");
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);
    expect(mockSetFragments).toHaveBeenCalledWith([
      {
        title: "看日志2",
        content: "adb logcat -d > ${LOGS_DIR}/today.log",
        tags: ["adb", "logcat"],
      },
    ]);
  });

  it("新增后出现空行，删除后移除该行", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("adb");
    await user.click(screen.getByRole("tab", { name: "编辑" }));
    await screen.findByDisplayValue("看日志");
    await user.click(screen.getByRole("button", { name: "新增" }));
    expect(screen.getAllByRole("button", { name: "删除" })).toHaveLength(2);
    await user.click(screen.getAllByRole("button", { name: "删除" })[0]);
    expect(screen.getAllByRole("button", { name: "删除" })).toHaveLength(1);
  });
});
