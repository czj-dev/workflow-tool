import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockListAiTasks, mockGetAiYaml } = vi.hoisted(() => ({
  mockListAiTasks: vi.fn(),
  mockGetAiYaml: vi.fn(),
}));

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({
    actions: [{ id: "a1", title: "A1", icon: "▶", description: "" }],
    errors: [],
  }),
  ListAiTasks: mockListAiTasks,
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn().mockResolvedValue(undefined),
  GetFragments: vi.fn().mockResolvedValue([]),
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: vi.fn().mockResolvedValue(undefined),
  PickDirectory: vi.fn().mockResolvedValue(""),
  GetActionYaml: vi.fn().mockResolvedValue("id: a1\ntitle: A1\n"),
  SetActionYaml: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  GetAiYaml: mockGetAiYaml,
  SetAiYaml: vi.fn().mockResolvedValue({ tasks: [], errors: [] }),
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
  ListSchedules: vi.fn().mockResolvedValue({ schedules: [], errors: [] }),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => ({}) } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import { OutputPanel } from "./OutputPanel";

// 模拟 AI 网格卡展开态的「编辑配置」：走 openYamlEditor(id, "ai")
function EditConfig() {
  const { aiTasks, openYamlEditor } = useActionRunner();
  return (
    <>
      <div data-testid="ai-count">{aiTasks.length}</div>
      <button onClick={() => openYamlEditor("t1", "ai")}>编辑配置</button>
    </>
  );
}

beforeEach(() => {
  mockListAiTasks.mockReset().mockResolvedValue({ tasks: [], errors: [] });
  mockGetAiYaml.mockReset().mockResolvedValue("id: t1\n");
});

describe("OutputPanel", () => {
  it("渲染默认提示与工具栏按钮", async () => {
    render(
      <ThemeProvider>
        <ActionRunnerProvider>
          <SidebarProvider>
            <OutputPanel />
          </SidebarProvider>
        </ActionRunnerProvider>
      </ThemeProvider>
    );
    expect(await screen.findByText("选择一个动作")).toBeInTheDocument();
    // 工具栏按钮已图标化：文字只在 aria-label（tooltip）里
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清空" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制" })).toBeInTheDocument();
  });

  it("点击标题进入编辑视图", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ActionRunnerProvider>
          <SidebarProvider>
            <OutputPanel />
          </SidebarProvider>
        </ActionRunnerProvider>
      </ThemeProvider>
    );
    await screen.findByText("选择一个动作");
    await user.click(screen.getByRole("button", { name: "选择一个动作" }));
    expect(await screen.findByRole("button", { name: "保存" })).toBeInTheDocument();
  });

  it("AI 任务「编辑配置」切到 ai-edit：右栏换成 AI 任务的 YAML 编辑器", async () => {
    const user = userEvent.setup();
    mockListAiTasks.mockResolvedValue({
      tasks: [
        {
          id: "t1",
          title: "翻译",
          icon: "",
          description: "",
          color: "",
          params: [],
          presets: [],
          prompt: "翻译 ${TEXT}",
          system: "",
          timeout: "",
        },
      ],
      errors: [],
    });
    render(
      <ThemeProvider>
        <ActionRunnerProvider>
          <SidebarProvider>
            <OutputPanel />
            <EditConfig />
          </SidebarProvider>
        </ActionRunnerProvider>
      </ThemeProvider>
    );
    // 等任务列表到位（网格卡此时才可点）
    await waitFor(() => expect(screen.getByTestId("ai-count")).toHaveTextContent("1"));
    await user.click(screen.getByRole("button", { name: "编辑配置" }));

    expect(await screen.findByRole("button", { name: "退出编辑" })).toBeInTheDocument();
    await waitFor(() => expect(mockGetAiYaml).toHaveBeenCalledWith("t1"));
    // 编辑目标是点「编辑配置」的那张卡（选择器回显其标题）
    expect(screen.getByRole("combobox")).toHaveTextContent("翻译");
    // 默认输出工具栏不再渲染（右栏已被编辑页替换）
    expect(screen.queryByRole("button", { name: "清空" })).not.toBeInTheDocument();
  });
});
