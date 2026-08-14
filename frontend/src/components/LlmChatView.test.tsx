import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
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
        presets: [{ name: "打招呼", description: "", values: { TASK: "介绍你自己" } }],
        stream: "",
        llm: { systemParam: "ROLE", promptParam: "TASK" },
      },
      {
        id: "c2",
        title: "卡片二",
        icon: "◇",
        description: "描述二",
        params: [
          { id: "TASK", label: "任务", type: "textarea", required: true, default: "C2_TASK_DEFAULT" },
        ],
        presets: [],
        stream: "",
        llm: { promptParam: "TASK" },
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
  // 历史存 localStorage，同文件内测试共享 jsdom：逐例清空保证隔离
  beforeEach(() => localStorage.clear());

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

  it("完成后写入历史，抽屉可浏览", async () => {
    renderChat();
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    // 历史按钮常驻，初始无计数
    const historyBtn = await screen.findByRole("button", { name: /历史/ });
    expect(historyBtn.textContent).not.toMatch(/\d/);
    act(() => {
      _emitForTest("action:c1:output", { data: { stream: "llm", line: "done-text" } });
    });
    act(() => {
      _emitForTest("action:c1:done", { data: { exitCode: 0, err: "", duration: "1.2s" } });
    });
    // done 写入 1 条历史 → 按钮出现计数
    expect(await screen.findByRole("button", { name: /历史\s*1/ })).toBeInTheDocument();
    // 打开抽屉能看到该条目的 prompt
    fireEvent.click(screen.getByRole("button", { name: /历史\s*1/ }));
    expect(await screen.findByText("历史记录 · 1")).toBeInTheDocument();
  });

  it("必填 param 仅有 default（用户未编辑）时发送按钮可用", async () => {
    render(
      <ActionRunnerProvider>
        <SidebarProvider>
          <OpenOnly />
        </SidebarProvider>
      </ActionRunnerProvider>,
    );
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    const sendBtn = await screen.findByRole("button", { name: /发送/ });
    expect(sendBtn).toBeEnabled();
  });

  it("点预设 chip 把预设值填入 composer", async () => {
    render(
      <ActionRunnerProvider>
        <SidebarProvider>
          <OpenOnly />
        </SidebarProvider>
      </ActionRunnerProvider>,
    );
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    // 打开时 composer 显示 TASK 的 default
    const textarea = await screen.findByPlaceholderText(/输入/);
    expect(textarea).toHaveValue("请处理 ${X}");
    // 点预设 chip → TASK 被替换为预设值
    fireEvent.click(screen.getByRole("button", { name: /打招呼/ }));
    expect(textarea).toHaveValue("介绍你自己");
  });

  it("切换卡片时 formValues 不串改（c1 编辑后打开 c2 显示 c2 默认值）", async () => {
    render(
      <ActionRunnerProvider>
        <SidebarProvider>
          <CrossCardDrive />
        </SidebarProvider>
      </ActionRunnerProvider>,
    );
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    // c2 的 composer 应显示其 TASK 默认值，而非 c1 上编辑过的值（formValues 须被重置）
    const textarea = await screen.findByPlaceholderText(/输入/) as HTMLTextAreaElement;
    expect(textarea).toHaveValue("C2_TASK_DEFAULT");
    expect(textarea).not.toHaveValue("EDITED_ON_C1");
  });
});

// 只打开聊天页、不发送——复现「带 default 的必填 param 未编辑时按钮置灰」的场景。
function OpenOnly() {
  const { openLlmChat } = useActionRunner();
  useEffect(() => {
    openLlmChat("c1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <LlmChatView />;
}

// 打开 c1 并编辑共享参数 TASK，再打开 c2——复现「跨卡片同名 param 残留」场景。
function CrossCardDrive() {
  const { openLlmChat, setFormValue } = useActionRunner();
  useEffect(() => {
    openLlmChat("c1");
    setFormValue("TASK", "EDITED_ON_C1");
    openLlmChat("c2");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <LlmChatView />;
}
