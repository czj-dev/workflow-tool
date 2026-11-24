import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockListAiTasks, mockGetAiYaml, mockSetAiYaml, mockOn } = vi.hoisted(() => ({
  mockListAiTasks: vi.fn(),
  mockGetAiYaml: vi.fn(),
  mockSetAiYaml: vi.fn(),
  mockOn: vi.fn(() => () => {}),
}));

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  ListAiTasks: mockListAiTasks,
  RunAi: vi.fn(),
  CancelAi: vi.fn(),
  GetAiYaml: mockGetAiYaml,
  SetAiYaml: mockSetAiYaml,
  RunAction: vi.fn(),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn(),
  GetFragments: vi.fn().mockResolvedValue([]),
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: vi.fn(),
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  ListSchedules: vi.fn().mockResolvedValue({ schedules: [], errors: [] }),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import { AiYamlEditor } from "./AiYamlEditor";
import { getCmValue, typeIntoCm } from "../test/codemirror";

const mkAi = (id: string, title: string) => ({
  id,
  title,
  icon: "",
  description: "",
  color: "",
  params: [],
  presets: [],
  prompt: "你好",
  system: "",
  timeout: "",
});

const YAML_A = "id: ai-a\ntitle: 任务A\n";
const yamlFor = (id: string) => `id: ${id}\n`;

// 模拟 OutputPanel 的分派（view === "ai-edit" 才挂载编辑页），并暴露 provider 状态。
// 「直达编辑」= 网格卡展开态「编辑配置」走的 openYamlEditor(id, "ai")。
function Host() {
  const { view, currentId, aiTasks, setView, openYamlEditor } = useActionRunner();
  return (
    <>
      {view === "ai-edit" && <AiYamlEditor />}
      <div data-testid="view-probe">{view}</div>
      <div data-testid="id-probe">{currentId ?? "none"}</div>
      <div data-testid="tasks-probe">{aiTasks.map((t) => t.title).join("|")}</div>
      <button onClick={() => setView("ai-edit")}>无当前任务进编辑页</button>
      <button onClick={() => openYamlEditor("ai-b", "ai")}>直达编辑</button>
    </>
  );
}

function wrap() {
  return (
    <ThemeProvider>
      <ActionRunnerProvider>
        <SidebarProvider>
          <Host />
        </SidebarProvider>
      </ActionRunnerProvider>
    </ThemeProvider>
  );
}

beforeEach(() => {
  mockListAiTasks.mockReset().mockResolvedValue({
    tasks: [mkAi("ai-a", "任务A"), mkAi("ai-b", "任务B")],
    errors: [],
  });
  mockGetAiYaml.mockReset().mockImplementation((id: string) => Promise.resolve(yamlFor(id)));
  mockSetAiYaml.mockReset().mockResolvedValue({
    tasks: [mkAi("ai-a", "任务A"), mkAi("ai-b", "任务B")],
    errors: [],
  });
  mockOn.mockClear();
  localStorage.clear();
});

describe("AiYamlEditor", () => {
  it("从卡面「编辑配置」进入：以该任务初始化编辑目标并加载其 yaml", async () => {
    const user = userEvent.setup();
    render(wrap());
    // 等任务列表到位再点（真实入口是已渲染的网格卡，列表必然已加载）
    await waitFor(() =>
      expect(screen.getByTestId("tasks-probe")).toHaveTextContent("任务A|任务B"),
    );
    await user.click(screen.getByRole("button", { name: "直达编辑" }));
    expect(screen.getByTestId("view-probe")).toHaveTextContent("ai-edit");
    expect(screen.getByTestId("id-probe")).toHaveTextContent("ai-b");
    await waitFor(() => expect(mockGetAiYaml).toHaveBeenCalledWith("ai-b"));
    await waitFor(() => expect(getCmValue()).toBe(yamlFor("ai-b")));
    // 列表里 ai-a 在前：编辑目标仍是点击的那张卡，不是列表首项
    expect(mockGetAiYaml).toHaveBeenCalledTimes(1);
    // 触发器回显所选条目的标题，而不是 id
    expect(screen.getByRole("combobox")).toHaveTextContent("任务B");
  });

  it("无 currentId 时回落到首个 AI 任务", async () => {
    const user = userEvent.setup();
    render(wrap());
    await user.click(await screen.findByRole("button", { name: "无当前任务进编辑页" }));
    await waitFor(() => expect(mockGetAiYaml).toHaveBeenCalledWith("ai-a"));
    await waitFor(() => expect(getCmValue()).toBe(yamlFor("ai-a")));
    expect(screen.getByRole("combobox")).toHaveTextContent("任务A");
  });

  it("Select 切换编辑目标后加载新任务的 yaml", async () => {
    const user = userEvent.setup();
    render(wrap());
    await user.click(await screen.findByRole("button", { name: "直达编辑" }));
    await waitFor(() => expect(getCmValue()).toBe(yamlFor("ai-b")));

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "任务A" }));

    await waitFor(() => expect(mockGetAiYaml).toHaveBeenCalledWith("ai-a"));
    await waitFor(() => expect(getCmValue()).toBe(yamlFor("ai-a")));
  });

  it("退出编辑回到该任务的会话页", async () => {
    const user = userEvent.setup();
    render(wrap());
    await user.click(await screen.findByRole("button", { name: "直达编辑" }));
    await waitFor(() => expect(getCmValue()).toBe(yamlFor("ai-b")));
    await user.click(screen.getByRole("button", { name: "退出编辑" }));
    expect(screen.getByTestId("view-probe")).toHaveTextContent("ai-chat");
    expect(screen.getByTestId("id-probe")).toHaveTextContent("ai-b");
    expect(document.querySelector(".cm-editor")).toBeNull();
  });

  it("有未保存改动时退出：取消留在编辑页且改动不丢，放弃后回到会话页", async () => {
    const user = userEvent.setup();
    render(wrap());
    await user.click(await screen.findByRole("button", { name: "直达编辑" }));
    await waitFor(() => expect(getCmValue()).toBe(yamlFor("ai-b")));
    act(() => typeIntoCm("# 备注\n"));

    await user.click(screen.getByRole("button", { name: "退出编辑" }));
    expect(await screen.findByText("放弃未保存的改动？")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(screen.queryByText("放弃未保存的改动？")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("view-probe")).toHaveTextContent("ai-edit");
    expect(getCmValue()).toBe(`${yamlFor("ai-b")}# 备注\n`);

    await user.click(screen.getByRole("button", { name: "退出编辑" }));
    await user.click(await screen.findByRole("button", { name: "放弃" }));
    expect(screen.getByTestId("view-probe")).toHaveTextContent("ai-chat");
    expect(mockSetAiYaml).not.toHaveBeenCalled();
  });

  it("⌘/Ctrl+S 保存：写回编辑目标与全文；成功后任务列表按返回值刷新并提示", async () => {
    mockGetAiYaml.mockResolvedValue(YAML_A);
    mockSetAiYaml.mockResolvedValue({
      tasks: [mkAi("ai-a", "任务A（已改名）"), mkAi("ai-b", "任务B")],
      errors: [],
    });
    const user = userEvent.setup();
    render(wrap());
    await user.click(await screen.findByRole("button", { name: "无当前任务进编辑页" }));
    await waitFor(() => expect(getCmValue()).toBe(YAML_A));
    // 未改动时保存钮禁用
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();

    act(() => typeIntoCm("# 备注\n"));
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    // 标题栏脉冲点旁 + 状态栏各一处
    expect(screen.getAllByText("已修改")).toHaveLength(2);

    fireEvent.keyDown(document.querySelector(".cm-content") as Element, {
      key: "s",
      metaKey: true,
    });

    await waitFor(() =>
      expect(mockSetAiYaml).toHaveBeenCalledWith("ai-a", `${YAML_A}# 备注\n`),
    );
    await waitFor(() =>
      expect(screen.getByTestId("tasks-probe")).toHaveTextContent("任务A（已改名）|任务B"),
    );
    expect(screen.getByText("已保存，下次运行生效")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("保存被后端拒绝：原因为 string 也能上屏，改动保留可重试", async () => {
    const user = userEvent.setup();
    mockGetAiYaml.mockResolvedValue(YAML_A);
    mockSetAiYaml.mockRejectedValue("ai/ai-a.yaml: prompt 必填");
    render(wrap());
    await user.click(await screen.findByRole("button", { name: "无当前任务进编辑页" }));
    await waitFor(() => expect(getCmValue()).toBe(YAML_A));
    act(() => typeIntoCm("x"));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("ai/ai-a.yaml: prompt 必填");
    expect(screen.getAllByText("已修改")).toHaveLength(2);
    expect(getCmValue()).toBe(`${YAML_A}x`);
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    expect(screen.getByTestId("tasks-probe")).toHaveTextContent("任务A|任务B");
  });

  it("加载 yaml 失败：错误上屏，不渲染出可保存的旧内容", async () => {
    const user = userEvent.setup();
    mockGetAiYaml.mockRejectedValue("读取 ai/ai-b.yaml 失败");
    render(wrap());
    await user.click(await screen.findByRole("button", { name: "直达编辑" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("读取 ai/ai-b.yaml 失败");
    expect(screen.getByText("未改动")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("无 AI 任务：空态给出 ai/ 落盘提示，不渲染编辑器", async () => {
    const user = userEvent.setup();
    mockListAiTasks.mockResolvedValue({ tasks: [], errors: [] });
    render(wrap());
    // 等列表加载完（结果为空）再进编辑页，区分「还没加载」与「加载后确实为空」
    await waitFor(() => expect(mockListAiTasks).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "无当前任务进编辑页" }));

    expect(screen.getByText("编辑 AI 任务")).toBeInTheDocument();
    expect(screen.getByText("（无 AI 任务，可在 ai/ 放 YAML）")).toBeInTheDocument();
    expect(document.querySelector(".cm-editor")).toBeNull();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(mockGetAiYaml).not.toHaveBeenCalled();
  });
});
