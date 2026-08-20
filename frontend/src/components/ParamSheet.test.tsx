import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef } from "react";
import i18n from "../i18n";

// mock bindings 与 runtime：参照 ActionRunnerProvider.test 的 hoisted 模式
const {
  mockListActions,
  mockListWorkflows,
  mockRunAction,
  mockRunWorkflow,
  mockPickDirectory,
  mockOn,
  listeners,
} = vi.hoisted(() => {
  const listeners: Record<string, (e: unknown) => void> = {};
  return {
    mockListActions: vi.fn(),
    mockListWorkflows: vi.fn(),
    mockRunAction: vi.fn(() => Promise.resolve()),
    mockRunWorkflow: vi.fn(() => Promise.resolve()),
    mockPickDirectory: vi.fn(() => Promise.resolve("D:/picked")),
    mockOn: vi.fn((name: string, cb: (e: unknown) => void) => {
      listeners[name] = cb;
      return () => {
        delete listeners[name];
      };
    }),
    listeners,
  };
});

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: mockListActions,
  RunAction: mockRunAction,
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn().mockResolvedValue(undefined),
  GetFragments: vi.fn().mockResolvedValue([]),
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: vi.fn().mockResolvedValue(undefined),
  PickDirectory: mockPickDirectory,
  OpenActionsDir: vi.fn().mockResolvedValue(undefined),
  GetActionYaml: vi.fn().mockResolvedValue(""),
  SetActionYaml: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  AddPreset: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  ListWorkflows: mockListWorkflows,
  RunWorkflow: mockRunWorkflow,
  CancelWorkflow: vi.fn(),
}));

vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import { ParamSheet } from "./ParamSheet";

const action = {
  id: "a1",
  title: "A",
  icon: "▶",
  description: "",
  params: [
    { id: "URL", label: "网址", type: "text", required: true, default: "", options: [], description: "如 https://example.com" },
    { id: "OPEN", label: "打开", type: "bool", required: false, default: "false", options: [], description: "启用后自动跳转浏览器" },
    { id: "MODE", label: "模式", type: "select", required: false, default: "fast", options: ["fast", "full"] },
    { id: "DIR", label: "目录", type: "path", required: false, default: "", options: [] },
  ],
  presets: [{ name: "p1", values: { URL: "https://preset.example" } }],
};

const workflow = {
  id: "wf1",
  title: "参数化WF",
  icon: "hi:workflow",
  description: "",
  params: [
    { id: "MSG", label: "消息", type: "text", required: false, default: "", options: [] },
  ],
  steps: [{ action: "x" }],
};

// actions 到达后选中首个动作 → 打开表单抽屉（模拟侧栏/网格点卡片）
function ActionSetup() {
  const { actions, selectPreset } = useActionRunner();
  const done = useRef(false);
  useEffect(() => {
    if (actions.length > 0 && !done.current) {
      done.current = true;
      selectPreset(actions[0].id, "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions]);
  return null;
}

// workflows 到达后选中首个（有参）→ 打开表单抽屉
function WfSetup() {
  const { workflows, selectWorkflow } = useActionRunner();
  const done = useRef(false);
  useEffect(() => {
    if (workflows.length > 0 && !done.current) {
      done.current = true;
      selectWorkflow(workflows[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflows]);
  return null;
}

function ViewProbe() {
  const { view } = useActionRunner();
  return <div data-testid="view-probe">{view}</div>;
}

function SheetProbe() {
  const { formSheetOpen } = useActionRunner();
  return <div data-testid="sheet-probe">{String(formSheetOpen)}</div>;
}

function mount(setup: React.ReactNode) {
  return render(
    <ActionRunnerProvider>
      <SidebarProvider>
        {setup}
        <ParamSheet />
        <ViewProbe />
        <SheetProbe />
      </SidebarProvider>
    </ActionRunnerProvider>,
  );
}

beforeEach(async () => {
  Object.keys(listeners).forEach((k) => delete listeners[k]);
  mockListActions.mockReset().mockResolvedValue({ actions: [action], errors: [] });
  mockListWorkflows.mockReset().mockResolvedValue({ workflows: [workflow], errors: [] });
  mockRunAction.mockReset().mockResolvedValue(undefined);
  mockRunWorkflow.mockReset().mockResolvedValue(undefined);
  mockPickDirectory.mockReset().mockResolvedValue("D:/picked");
  mockOn.mockClear();
  localStorage.clear();
  await i18n.changeLanguage("zh");
});

describe("ParamSheet — action 形态", () => {
  it("渲染四类型字段", async () => {
    mount(<ActionSetup />);
    expect(await screen.findByText(/网址/)).toBeInTheDocument();
    expect(screen.getByText(/打开/)).toBeInTheDocument();
    expect(screen.getByText(/模式/)).toBeInTheDocument();
    expect(screen.getByText(/目录/)).toBeInTheDocument();
  });

  it("params[].description 渲染为字段说明；未配置的字段不渲染", async () => {
    mount(<ActionSetup />);
    expect(await screen.findByText("如 https://example.com")).toBeInTheDocument();
    expect(screen.getByText("启用后自动跳转浏览器")).toBeInTheDocument();
    expect(screen.queryByText("如 fast")).not.toBeInTheDocument();
  });

  it("required 未填时运行按钮禁用", async () => {
    mount(<ActionSetup />);
    const runBtn = await screen.findByRole("button", { name: "运行" });
    expect(runBtn).toBeDisabled();
  });

  it("填入必填后运行按钮启用并提交，且点火即关抽屉（主区视图不动）", async () => {
    const user = userEvent.setup();
    mount(<ActionSetup />);
    const urlInput = await screen.findByLabelText(/网址/);
    await user.type(urlInput, "https://x.com");
    const runBtn = screen.getByRole("button", { name: "运行" });
    expect(runBtn).not.toBeDisabled();
    await user.click(runBtn);
    expect(mockRunAction).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({ URL: "https://x.com" }),
    );
    // 点火即关：抽屉关闭，视图不切走（仍停在打开前的视图）
    expect(screen.getByTestId("sheet-probe")).toHaveTextContent("false");
    expect(screen.getByTestId("view-probe")).toHaveTextContent("output");
  });

  it("渲染保存按钮并可打开保存弹窗", async () => {
    const user = userEvent.setup();
    mount(<ActionSetup />);
    const saveBtn = await screen.findByRole("button", { name: "保存" });
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);
    expect(await screen.findByText(/保存为预设/)).toBeInTheDocument();
  });

  it("就绪读数：未填显示已装配计数，必填满足后显示就绪", async () => {
    const user = userEvent.setup();
    mount(<ActionSetup />);
    // URL/DIR 空，OPEN/MODE 有默认值 → 2/4
    expect(await screen.findByText("已装配 2/4")).toBeInTheDocument();
    const urlInput = await screen.findByLabelText(/网址/);
    await user.type(urlInput, "https://x.com");
    expect(await screen.findByText("就绪")).toBeInTheDocument();
  });

  it("点预设 chip 把整套值填入表单（不直接运行）", async () => {
    const user = userEvent.setup();
    mount(<ActionSetup />);
    await user.click(await screen.findByRole("button", { name: "p1" }));
    const urlInput = await screen.findByLabelText(/网址/);
    expect(urlInput).toHaveValue("https://preset.example");
    expect(mockRunAction).not.toHaveBeenCalled();
  });

  it("双击预设 chip 直接运行该预设（与侧边栏预设子项一致）", async () => {
    const user = userEvent.setup();
    mount(<ActionSetup />);
    await user.dblClick(await screen.findByRole("button", { name: "p1" }));
    expect(mockRunAction).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({ URL: "https://preset.example" }),
    );
  });

  it("标题点击进入 yaml 编辑态 edit", async () => {
    const user = userEvent.setup();
    mount(<ActionSetup />);
    // 可访问名含图标字符（▶ A），用正则匹配标题文本
    const title = await screen.findByRole("button", { name: /A/ });
    await user.click(title);
    expect(screen.getByTestId("view-probe")).toHaveTextContent("edit");
  });
});

describe("ParamSheet — workflow 形态", () => {
  beforeEach(() => {
    mockListActions.mockReset().mockResolvedValue({ actions: [], errors: [] });
  });

  it("渲染步骤概览；标题点击进入 yaml 编辑态 workflow-edit", async () => {
    const user = userEvent.setup();
    mount(<WfSetup />);
    expect(await screen.findByText("执行流程")).toBeInTheDocument();
    const title = await screen.findByRole("button", { name: "参数化WF" });
    await user.click(title);
    expect(screen.getByTestId("view-probe")).toHaveTextContent("workflow-edit");
  });

  it("点运行提交 RunWorkflow 并关闭抽屉（主区切 workflow 视图）", async () => {
    const user = userEvent.setup();
    mount(<WfSetup />);
    const runBtn = await screen.findByRole("button", { name: "运行" });
    expect(runBtn).not.toBeDisabled();
    await user.click(runBtn);
    expect(mockRunWorkflow).toHaveBeenCalledWith(
      "wf1",
      expect.objectContaining({ MSG: "" }),
    );
    expect(screen.getByTestId("sheet-probe")).toHaveTextContent("false");
    expect(screen.getByTestId("view-probe")).toHaveTextContent("workflow");
  });

  it("workflow 形态不渲染保存预设按钮", async () => {
    mount(<WfSetup />);
    await screen.findByText(/消息/);
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });
});
