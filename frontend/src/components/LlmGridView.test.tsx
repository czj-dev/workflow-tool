import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockListActions, mockOn } = vi.hoisted(() => ({
  mockListActions: vi.fn(),
  mockOn: vi.fn(() => () => {}),
}));

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: mockListActions,
  RunAction: vi.fn(),
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
import { LlmGridView } from "./LlmGridView";

// ViewProbe：暴露 provider 内部 view / formValues，断言「带预设进对话」的路由与预填。
function ViewProbe() {
  const { view, formValues } = useActionRunner();
  return (
    <>
      <div data-testid="view-probe">{view}</div>
      <div data-testid="form-values-probe">{JSON.stringify(formValues)}</div>
    </>
  );
}

const mkLlmAction = () => ({
  id: "llm-x",
  title: "翻译助手",
  icon: "",
  description: "把内容翻成中文",
  params: [
    { id: "PROMPT", label: "提示词", type: "text", required: true, default: "", options: [] },
  ],
  presets: [{ name: "日常", values: { PROMPT: "翻译这段" } }],
  llm: { systemParam: "", promptParam: "PROMPT" },
});

// ❝区摘要源：llm-history:<id> 最新在前（useLlmHistory 同一形状）
const seedHistory = () =>
  localStorage.setItem(
    "llm-history:llm-x",
    JSON.stringify([
      {
        id: "h1",
        timestamp: Date.now(),
        prompt: "总结 ${TOPIC}",
        params: { TOPIC: "季度报告" },
        response: "好的",
        thinking: "",
        exitCode: 0,
        duration: "1s",
      },
    ]),
  );

beforeEach(() => {
  mockListActions.mockReset();
  mockOn.mockClear();
  localStorage.clear();
});

function wrap() {
  return (
    <ActionRunnerProvider>
      <SidebarProvider>
        <LlmGridView />
        <ViewProbe />
      </SidebarProvider>
    </ActionRunnerProvider>
  );
}

describe("LlmGridView", () => {
  it("单击卡片就地展开，❝区显示最近会话摘要(变量展开)", async () => {
    const user = userEvent.setup();
    seedHistory();
    mockListActions.mockResolvedValue({ actions: [mkLlmAction()], errors: [] });
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(card);
    expect(card).toHaveAttribute("aria-expanded", "true");
    // prompt 的 ${TOPIC} 用会话 params 展开
    expect(screen.getByText(/季度报告/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /对话/ })).toBeInTheDocument();
  });

  it("无会话时❝区回落描述", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({ actions: [mkLlmAction()], errors: [] });
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(card);
    expect(screen.getByText(/把内容翻成中文/)).toBeInTheDocument();
  });

  it("主控「对话」进入聊天页空态", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({ actions: [mkLlmAction()], errors: [] });
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(card);
    await user.click(within(card).getByRole("button", { name: /对话/ }));
    expect(screen.getByTestId("view-probe")).toHaveTextContent("llm-chat");
  });

  it("chips 带预设进对话(预填 preset 值)", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({ actions: [mkLlmAction()], errors: [] });
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(card);
    await user.click(within(card).getByRole("button", { name: /日常/ }));
    expect(screen.getByTestId("view-probe")).toHaveTextContent("llm-chat");
    expect(JSON.parse(screen.getByTestId("form-values-probe").textContent ?? "{}")).toEqual({
      PROMPT: "翻译这段",
    });
  });
});
