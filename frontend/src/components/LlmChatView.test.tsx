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
          { id: "SID", label: "会话", type: "text", required: false },
        ],
        presets: [{ name: "打招呼", description: "", values: { TASK: "介绍你自己" } }],
        stream: "",
        llm: { systemParam: "ROLE", promptParam: "TASK", resumeParam: "SID" },
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
// 拦截 useStickToBottomContext：jsdom 无真实布局，用 spy 验证「进入历史查看时显式滚到底」；
// 布局修复（min-h-0）另以类名断言守护。StickToBottom/Content 保持真实实现。
const { scrollToBottomMock } = vi.hoisted(() => ({ scrollToBottomMock: vi.fn() }));
vi.mock("use-stick-to-bottom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("use-stick-to-bottom")>();
  return {
    ...actual,
    useStickToBottomContext: () => ({ isAtBottom: true, scrollToBottom: scrollToBottomMock }),
  };
});

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

  it("llm-tool 事件渲染为工序段（工具名 · 主参数摘要）", async () => {
    renderChat();
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    act(() => {
      _emitForTest("action:c1:output", {
        data: {
          stream: "llm-tool",
          line: JSON.stringify({ id: "call_1", name: "Read", input: { file_path: "C:\\tmp\\package.json" } }),
        },
      });
    });
    // 段头标签：工具名 + summarizeInput 提取的路径末段（分属两个 span，分别断言）
    expect(await screen.findByText("Read")).toBeInTheDocument();
    expect(screen.getByText("· package.json")).toBeInTheDocument();
  });

  it("完成后写入历史，抽屉可浏览", async () => {
    renderChat();
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    // 历史按钮常驻，初始无计数（badge 不渲染、aria-label 不带 N）
    const historyBtn = await screen.findByRole("button", { name: "历史" });
    expect(historyBtn.textContent).not.toMatch(/\d/);
    act(() => {
      _emitForTest("action:c1:output", { data: { stream: "llm", line: "done-text" } });
    });
    act(() => {
      _emitForTest("action:c1:done", { data: { exitCode: 0, err: "", duration: "1.2s" } });
    });
    // done 写入 1 条历史 → badge 出现、aria-label 变「历史 · 1」
    expect(await screen.findByRole("button", { name: "历史 · 1" })).toBeInTheDocument();
    // 打开抽屉能看到该条目的 prompt
    fireEvent.click(screen.getByRole("button", { name: "历史 · 1" }));
    expect(await screen.findByText("历史记录 · 1")).toBeInTheDocument();
  });

  it("点历史条目显示完成态而非生成中（liveIndex 三态契约回归）", async () => {
    renderChat();
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    act(() => {
      _emitForTest("action:c1:output", { data: { stream: "llm-thinking", line: "想一想" } });
      _emitForTest("action:c1:output", {
        data: {
          stream: "llm-tool",
          line: JSON.stringify({ id: "call_1", name: "Read", input: { file_path: "/a/package.json" } }),
        },
      });
      _emitForTest("action:c1:output", {
        data: { stream: "llm-tool", line: JSON.stringify({ id: "call_1", content: "react 19" }) },
      });
      _emitForTest("action:c1:output", { data: { stream: "llm", line: "最终回答" } });
    });
    act(() => {
      _emitForTest("action:c1:done", {
        data: {
          exitCode: 0,
          err: "",
          duration: "3.5s",
          readout: { durationMs: 3500, inputTokens: 100, outputTokens: 20, costUsd: 0.01, sessionId: "sess-a1b2c3" },
        },
      });
    });
    // 打开历史抽屉并点选条目 → 只读查看态（进入查看时需显式滚到底，读数行才可见）
    scrollToBottomMock.mockClear();
    fireEvent.click(await screen.findByRole("button", { name: "历史 · 1" }));
    fireEvent.click(await screen.findByText("请处理卡片"));
    await act(() => Promise.resolve());
    expect(scrollToBottomMock).toHaveBeenCalled();
    // Thread 必须带 min-h-0：基类 h-full（height:100%）在 flex 列里会把末尾读数行/composer 挤出视口
    expect(document.querySelector('[data-slot="thread"]')).toHaveClass("min-h-0");
    // 查看横幅 + 会话 id（顶部展示 + 回填到 resume chip，故有两处）+ 终点读数行存在
    expect(await screen.findByText(/正在查看历史记录/)).toBeInTheDocument();
    expect(screen.getAllByText(/sess-a1b2c3/).length).toBeGreaterThan(0);
    expect(screen.getByText("3.5s")).toBeInTheDocument();
    // live 态文案不得出现（历史段 durationMs 为 undefined，不能误判为 null=进行中）
    expect(screen.queryByText("生成中")).not.toBeInTheDocument();
    expect(screen.queryByText("调用中")).not.toBeInTheDocument();
    expect(screen.queryByText("思考中")).not.toBeInTheDocument();
    // 历史回答正文仍在渲染
    expect(screen.getByText(/最终回答/)).toBeInTheDocument();
    // 查看历史时 session id 回填到 resume param（chip 摘要即该 param 的当前值）
    expect(screen.getByRole("button", { name: /SID\s*sess-a1b2c3/ })).toBeInTheDocument();
    // 退出查看（返回当前）清空 resume 值
    fireEvent.click(screen.getByRole("button", { name: /返回当前/ }));
    await act(() => Promise.resolve());
    expect(screen.queryByRole("button", { name: /SID\s*sess-a1b2c3/ })).not.toBeInTheDocument();
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
