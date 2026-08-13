import { describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useEffect } from "react";

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({
    actions: [
      {
        id: "c1",
        title: "卡片一",
        icon: "◆",
        description: "描述",
        params: [
          { id: "ROLE", label: "角色", type: "textarea", required: false, default: "你是助手" },
          { id: "TASK", label: "任务", type: "textarea", required: true, default: "请处理 ${X}" },
        ],
        presets: [],
        stream: "",
        llm: { systemParam: "ROLE", promptParam: "TASK" },
      },
    ],
    errors: [],
  }),
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn().mockResolvedValue(undefined),
  GetFragments: vi.fn().mockResolvedValue([]),
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: vi.fn().mockResolvedValue(undefined),
  PickDirectory: vi.fn().mockResolvedValue(""),
  PickFile: vi.fn().mockResolvedValue(""),
  OpenActionsDir: vi.fn().mockResolvedValue(undefined),
  GetActionYaml: vi.fn().mockResolvedValue(""),
  SetActionYaml: vi.fn().mockResolvedValue(undefined),
  AddPreset: vi.fn().mockResolvedValue(undefined),
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
  GetWorkflowYaml: vi.fn().mockResolvedValue(""),
  SetWorkflowYaml: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => ({}) } }));

import { ActionRunnerProvider, _emitForTest } from "../context/ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import { SidebarProvider } from "@/components/ui/sidebar";
import { LlmChatView } from "./LlmChatView";

function Drive() {
  const { openLlmChat, runAction } = useActionRunner();
  useEffect(() => {
    openLlmChat("c1");
    runAction("c1", { ROLE: "你是助手", TASK: "请处理卡片" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <LlmChatView />;
}

function renderChat() {
  return render(
    <ActionRunnerProvider>
      <SidebarProvider>
        <Drive />
      </SidebarProvider>
    </ActionRunnerProvider>,
  );
}

describe("LlmChatView", () => {
  it("渲染卡片标题", async () => {
    renderChat();
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    expect(await screen.findByText("卡片一")).toBeInTheDocument();
  });

  it("流式渲染 assistant 文本", async () => {
    renderChat();
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    act(() => {
      _emitForTest("action:c1:output", { data: { stream: "llm", line: "处理完成" } });
    });
    expect(await screen.findByText(/处理完成/)).toBeInTheDocument();
  });
});
