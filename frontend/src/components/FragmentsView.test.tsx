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
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: mockSetFragments,
  PickDirectory: vi.fn().mockResolvedValue(""),
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
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
  it("多 tag 片段只归到首个 tag 组，不重复显示", async () => {
    renderView();
    await screen.findByPlaceholderText("搜索 标题 / 内容 / 标签");
    // 未选 tag 时按第一个 tag(adb) 归组，logcat 不单独成组
    expect(
      screen.getByRole("heading", { level: 3, name: /adb/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { level: 3, name: /^logcat/i }),
    ).not.toBeInTheDocument();
    // 同一片段只出现一次
    expect(screen.getAllByText("看日志")).toHaveLength(1);
    // 预览中变量已替换
    expect(
      screen.getByText("adb logcat -d > /tmp/logs/today.log")
    ).toBeInTheDocument();
  });

  it("复制时把 ${VAR} 替换为全局配置的值", async () => {
    const user = userEvent.setup();
    stubClipboard();
    renderView();
    await screen.findByPlaceholderText("搜索 标题 / 内容 / 标签");
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

  it("搜索过滤片段（标题/内容/标签）", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "看日志", content: "adb logcat", tags: ["adb"] },
      { title: "清理", content: "rm -rf tmp", tags: ["clean"] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("看日志");
    await user.type(
      screen.getByPlaceholderText("搜索 标题 / 内容 / 标签"),
      "清理",
    );
    expect(screen.getByText("清理")).toBeInTheDocument();
    expect(screen.queryByText("看日志")).not.toBeInTheDocument();
  });

  it("点击 Tag 筛选只剩该 Tag 的片段", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "F1", content: "a", tags: ["adb"] },
      { title: "F2", content: "b", tags: ["rg"] },
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("F1");
    // 点 adb chip → 只剩 F1，F2 消失
    await user.click(screen.getByRole("button", { name: /adb/i }));
    expect(screen.getByText("F1")).toBeInTheDocument();
    expect(screen.queryByText("F2")).not.toBeInTheDocument();
  });

  it("未命中的变量在预览下列出缺失", async () => {
    mockGetFragments.mockResolvedValue([
      { title: "x", content: "echo ${NOPE}", tags: [] },
    ]);
    renderView();
    // 预览保留 ${NOPE}，且提示行明确列出缺失变量
    expect(await screen.findByText(/缺变量.*NOPE/)).toBeInTheDocument();
  });
});

describe("FragmentsView - 编辑视图", () => {
  it("点编辑进入编辑模式，显示表单字段", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByPlaceholderText("搜索 标题 / 内容 / 标签");
    await user.click(screen.getByRole("tab", { name: "编辑" }));
    // 编辑模式展示输入框
    expect(screen.getByDisplayValue("看日志")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("adb logcat -d > ${LOGS_DIR}/today.log")
    ).toBeInTheDocument();
    // tags 以 chip 形式展示（用移除按钮定位，避开使用视图里的同名分组标题）
    expect(
      screen.getByRole("button", { name: "移除标签 adb" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "移除标签 logcat" })
    ).toBeInTheDocument();
  });

  it("改动后保存调用 SetFragments，tags 保持数组", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByPlaceholderText("搜索 标题 / 内容 / 标签");
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
    await screen.findByPlaceholderText("搜索 标题 / 内容 / 标签");
    await user.click(screen.getByRole("tab", { name: "编辑" }));
    await screen.findByDisplayValue("看日志");
    await user.click(screen.getByRole("button", { name: "新增" }));
    expect(screen.getAllByRole("button", { name: "删除" })).toHaveLength(2);
    await user.click(screen.getAllByRole("button", { name: "删除" })[0]);
    expect(screen.getAllByRole("button", { name: "删除" })).toHaveLength(1);
  });

  it("编辑视图标注引用的变量是否已定义", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByPlaceholderText("搜索 标题 / 内容 / 标签");
    await user.click(screen.getByRole("tab", { name: "编辑" }));
    // 「引用」标签 + 已定义的 LOGS_DIR chip
    expect(await screen.findByText("引用")).toBeInTheDocument();
    expect(screen.getByText("LOGS_DIR")).toBeInTheDocument();
  });

  it("TagInput 回车提交整段带空格的 tag，× 单独移除", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByPlaceholderText("搜索 标题 / 内容 / 标签");
    await user.click(screen.getByRole("tab", { name: "编辑" }));
    await screen.findByDisplayValue("看日志");

    // 空格是合法 tag 字符，不被拆分
    await user.type(screen.getByLabelText("添加标签（回车确认）"), "Lanv AI_BOX{Enter}");
    expect(screen.getByText("Lanv AI_BOX")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "移除标签 adb" }));
    expect(screen.queryByText("adb")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(mockSetFragments).toHaveBeenCalledWith([
      {
        title: "看日志",
        content: "adb logcat -d > ${LOGS_DIR}/today.log",
        tags: ["logcat", "Lanv AI_BOX"],
      },
    ]);
  });
});
