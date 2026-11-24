import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockListAiTasks, mockRunAi, mockOn } = vi.hoisted(() => ({
  mockListAiTasks: vi.fn(),
  mockRunAi: vi.fn(),
  mockOn: vi.fn(() => () => {}),
}));

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  ListAiTasks: mockListAiTasks,
  RunAi: mockRunAi,
  CancelAi: vi.fn(),
  GetAiYaml: vi.fn().mockResolvedValue(""),
  SetAiYaml: vi.fn().mockResolvedValue({ tasks: [], errors: [] }),
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
import { ActionRunnerProvider, _emitForTest } from "../context/ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import { appendAiHistory, clearAiHistory } from "../hooks/useAiHistory";
import { AiGridView } from "./AiGridView";

// 暴露 provider 内部 view / 当前任务草稿：断言卡面动作的路由与预填。
function ViewProbe() {
  const { view, aiDraft } = useActionRunner();
  return (
    <>
      <div data-testid="view-probe">{view}</div>
      <div data-testid="draft-probe">{JSON.stringify(aiDraft)}</div>
    </>
  );
}

const mkAiTask = (extra: Record<string, unknown> = {}) => ({
  id: "ai-x",
  title: "翻译助手",
  icon: "",
  description: "把内容翻成中文",
  color: "",
  params: [
    {
      id: "TEXT",
      label: "原文",
      type: "text",
      required: false,
      default: "hello",
      options: [],
      description: undefined,
    },
  ],
  // 预设值用保留键 prompt（任务的提示词模板）：稀疏预设只覆写给出的键
  presets: [{ name: "日常", description: "", values: { prompt: "翻译这段" } }],
  prompt: "把以下内容翻成中文：${TEXT}",
  system: "你是翻译",
  timeout: "",
  ...extra,
});

const TASK_IDS = ["ai-x", "ai-green", "ai-blank"];

// ❝区摘要源：该任务的运行历史（最新在前）。历史仓是模块级单例（localStorage 只在首次
// 访问时读入），所以这里经 appendAiHistory 写入、并在用例间显式清空。
const seedHistory = () =>
  appendAiHistory("ai-x", {
    prompt: "总结 ${TOPIC}",
    params: { TOPIC: "季度报告" },
    response: "好的",
    thinking: "",
    exitCode: 0,
    duration: "1s",
  });

const draft = () => JSON.parse(screen.getByTestId("draft-probe").textContent ?? "null");
const FULL_DRAFT = {
  prompt: "把以下内容翻成中文：${TEXT}",
  system: "你是翻译",
  resume: "",
  TEXT: "hello",
};
const SENT_PARAMS = { prompt: "把以下内容翻成中文：${TEXT}", system: "你是翻译" };

beforeEach(() => {
  mockListAiTasks.mockReset().mockResolvedValue({ tasks: [mkAiTask()], errors: [] });
  mockRunAi.mockReset().mockResolvedValue(undefined);
  mockOn.mockClear();
  localStorage.clear();
  for (const id of TASK_IDS) clearAiHistory(id);
});

function wrap() {
  return (
    <ActionRunnerProvider>
      <SidebarProvider>
        <AiGridView />
        <ViewProbe />
      </SidebarProvider>
    </ActionRunnerProvider>
  );
}

describe("AiGridView", () => {
  it("单击卡片就地展开，❝区显示最近会话摘要(变量展开)", async () => {
    const user = userEvent.setup();
    seedHistory();
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    expect(card).toHaveAttribute("aria-expanded", "false");
    await user.click(card);
    expect(card).toHaveAttribute("aria-expanded", "true");
    // prompt 的 ${TOPIC} 用会话 params 展开
    expect(screen.getByText(/季度报告/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /对话/ })).toBeInTheDocument();
  });

  it("无会话时❝区回落描述", async () => {
    const user = userEvent.setup();
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(card);
    expect(screen.getByText(/把内容翻成中文/)).toBeInTheDocument();
  });

  it("次级动作「对话」进入该任务的会话页（空态，草稿按定义预填）", async () => {
    const user = userEvent.setup();
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(card);
    await user.click(within(card).getByRole("button", { name: /对话/ }));
    expect(screen.getByTestId("view-probe")).toHaveTextContent("ai-chat");
    expect(draft()).toEqual(FULL_DRAFT);
  });

  it("紧凑态「▸ 运行」后台起跑：视图不动、卡面转运行徽标；运行中点卡身回到会话页(不展开)", async () => {
    const user = userEvent.setup();
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    expect(card).not.toHaveAttribute("data-running");
    await user.click(within(card).getByRole("button", { name: /运行/ }));
    expect(mockRunAi).toHaveBeenCalledTimes(1);
    expect(mockRunAi).toHaveBeenCalledWith("ai-x", SENT_PARAMS);
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
    expect(card).toHaveAttribute("data-running");
    expect(within(card).getByRole("button", { name: "运行中 ▸" })).toBeInTheDocument();
    // 读数态仍可点：点卡身 = 回到会话页回放这一轮，不展开
    await user.click(card);
    expect(card).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("view-probe")).toHaveTextContent("ai-chat");
  });

  it("YAML color 字段优先于组序循环注入 --amb", async () => {
    mockListAiTasks.mockResolvedValue({
      tasks: [mkAiTask(), mkAiTask({ id: "ai-green", title: "绿聊", color: "green" })],
      errors: [],
    });
    render(wrap());
    const plain = await screen.findByRole("button", { name: "翻译助手" });
    const green = screen.getByRole("button", { name: "绿聊" });
    // 同组（ai，组序 0=amber）：未写 color 回落组循环，写了用逐卡 token
    expect(plain.style.getPropertyValue("--amb")).toBe("var(--amb-amber)");
    expect(green.style.getPropertyValue("--amb")).toBe("var(--amb-green)");
  });

  it("chips 带预设进对话(预填 preset 值，不起跑)", async () => {
    const user = userEvent.setup();
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(card);
    await user.click(within(card).getByRole("button", { name: /日常/ }));
    expect(screen.getByTestId("view-probe")).toHaveTextContent("ai-chat");
    // 稀疏预设只覆写 prompt：没给的键保留定义默认值
    expect(draft()).toEqual({ ...FULL_DRAFT, prompt: "翻译这段" });
    expect(mockRunAi).not.toHaveBeenCalled();
  });

  it("展开态主控「运行」：后台运行，不切视图，主钮转读数态、❝区切实时摘要", async () => {
    const user = userEvent.setup();
    seedHistory();
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(card);
    await user.click(within(card).getByRole("button", { name: /运行/ }));
    expect(mockRunAi).toHaveBeenCalledWith("ai-x", SENT_PARAMS);
    expect(card).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
    // 主钮不再是按钮（不可再点），转为运行读数；❝区从历史摘要切到实时文案
    expect(within(card).queryByRole("button", { name: /运行/ })).not.toBeInTheDocument();
    expect(within(card).getByText("运行中")).toBeInTheDocument();
    expect(screen.getByText(/正在生成回复/)).toBeInTheDocument();
    expect(screen.queryByText(/季度报告/)).not.toBeInTheDocument();
  });

  it("「编辑配置」直达该任务的 YAML 编辑页", async () => {
    const user = userEvent.setup();
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(card);
    await user.click(within(card).getByRole("button", { name: "编辑配置" }));
    expect(screen.getByTestId("view-probe")).toHaveTextContent("ai-edit");
    // 编辑器以 currentId 初始化：该任务已是当前项
    expect(draft()).toEqual(FULL_DRAFT);
  });

  it("提示词为空的任务：运行改为进入对话页", async () => {
    const user = userEvent.setup();
    mockListAiTasks.mockResolvedValue({
      tasks: [mkAiTask({ id: "ai-blank", title: "空提示词", prompt: "" })],
      errors: [],
    });
    render(wrap());
    const card = await screen.findByRole("button", { name: "空提示词" });
    await user.click(within(card).getByRole("button", { name: /运行/ }));
    expect(mockRunAi).not.toHaveBeenCalled();
    expect(screen.getByTestId("view-probe")).toHaveTextContent("ai-chat");
  });

  it("后台运行结束落历史后，卡面摘要读到这一轮（会话页与网格卡共用同一份历史）", async () => {
    const user = userEvent.setup();
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    await user.click(within(card).getByRole("button", { name: /运行/ }));
    act(() => {
      _emitForTest("ai:ai-x:done", { data: { exitCode: 0, err: "", duration: "2s", seq: 1 } });
    });
    expect(card).not.toHaveAttribute("data-running");
    await user.click(card);
    expect(screen.getByText(/把以下内容翻成中文：hello/)).toBeInTheDocument();
  });

  it("无 AI 任务时显示空态；加载错误以 Alert 逐条展示", async () => {
    mockListAiTasks.mockResolvedValue({ tasks: [], errors: ["ai/broken.yaml: 未知字段 llm"] });
    render(wrap());
    expect(await screen.findByText(/无 AI 任务/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("ai/broken.yaml: 未知字段 llm");
    expect(screen.queryByRole("button", { name: "翻译助手" })).not.toBeInTheDocument();
  });

  it("加载错误与任务并存时都显示", async () => {
    mockListAiTasks.mockResolvedValue({ tasks: [mkAiTask()], errors: ["ai/broken.yaml: 预设引用了未声明的参数"] });
    render(wrap());
    expect(await screen.findByRole("button", { name: "翻译助手" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("ai/broken.yaml: 预设引用了未声明的参数");
    expect(screen.queryByText(/无 AI 任务/)).not.toBeInTheDocument();
  });

  it("键盘：卡片上 Enter 展开、Escape 收起", async () => {
    const user = userEvent.setup();
    render(wrap());
    const card = await screen.findByRole("button", { name: "翻译助手" });
    card.focus();
    await user.keyboard("{Enter}");
    expect(card).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(card).toHaveAttribute("aria-expanded", "false");
  });
});
