import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import i18n from "../i18n";

// mock bindings 与 runtime：参照 ActionRunnerProvider.test 的 hoisted 模式
const { mockListActions, mockRunAction, mockPickDirectory, mockOn, listeners } =
  vi.hoisted(() => {
    const listeners: Record<string, (e: unknown) => void> = {};
    return {
      mockListActions: vi.fn(),
      mockRunAction: vi.fn(() => Promise.resolve()),
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
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
}));

vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));

import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import { ParamForm } from "./ParamForm";

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

// Harness：actions 加载后自动进表单视图（模拟"点动作"触发 ParamForm 渲染）
function Harness() {
  const { actions, selectPreset, view } = useActionRunner();
  useEffect(() => {
    if (actions.length > 0 && view === "output") {
      selectPreset(actions[0].id, "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, view]);
  return <ParamForm />;
}

beforeEach(async () => {
  Object.keys(listeners).forEach((k) => delete listeners[k]);
  mockListActions.mockReset().mockResolvedValue({ actions: [action], errors: [] });
  mockRunAction.mockReset().mockResolvedValue(undefined);
  mockPickDirectory.mockReset().mockResolvedValue("D:/picked");
  mockOn.mockClear();
  await i18n.changeLanguage("zh");
});

describe("ParamForm", () => {
  it("渲染四类型字段", async () => {
    render(
      <ActionRunnerProvider>
        <Harness />
      </ActionRunnerProvider>
    );
    expect(await screen.findByText(/网址/)).toBeInTheDocument();
    expect(screen.getByText(/打开/)).toBeInTheDocument();
    expect(screen.getByText(/模式/)).toBeInTheDocument();
    expect(screen.getByText(/目录/)).toBeInTheDocument();
  });

  it("params[].description 渲染为字段说明；未配置的字段不渲染", async () => {
    render(
      <ActionRunnerProvider>
        <Harness />
      </ActionRunnerProvider>
    );
    // text 字段（控件下方）与 bool 字段（label 下方）都渲染说明
    expect(await screen.findByText("如 https://example.com")).toBeInTheDocument();
    expect(screen.getByText("启用后自动跳转浏览器")).toBeInTheDocument();
    // MODE / DIR 未配置 description → 无额外说明节点
    expect(screen.queryByText("如 fast")).not.toBeInTheDocument();
  });

  it("required 未填时运行按钮禁用", async () => {
    render(
      <ActionRunnerProvider>
        <Harness />
      </ActionRunnerProvider>
    );
    const runBtn = await screen.findByRole("button", { name: "运行" });
    expect(runBtn).toBeDisabled();
  });

  it("填入必填后运行按钮启用并提交", async () => {
    const user = userEvent.setup();
    render(
      <ActionRunnerProvider>
        <Harness />
      </ActionRunnerProvider>
    );
    const urlInput = await screen.findByLabelText(/网址/);
    await user.type(urlInput, "https://x.com");
    const runBtn = screen.getByRole("button", { name: "运行" });
    expect(runBtn).not.toBeDisabled();
    await user.click(runBtn);
    expect(mockRunAction).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({ URL: "https://x.com" })
    );
  });

  it("渲染保存按钮并可打开保存弹窗", async () => {
    const user = userEvent.setup();
    render(
      <ActionRunnerProvider>
        <Harness />
      </ActionRunnerProvider>
    );
    const saveBtn = await screen.findByRole("button", { name: "保存" });
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);
    expect(await screen.findByText(/保存为预设/)).toBeInTheDocument();
  });

  it("就绪读数：未填显示已装配计数，必填满足后显示就绪", async () => {
    const user = userEvent.setup();
    render(
      <ActionRunnerProvider>
        <Harness />
      </ActionRunnerProvider>
    );
    // URL/DIR 空，OPEN/MODE 有默认值 → 2/4
    expect(await screen.findByText("已装配 2/4")).toBeInTheDocument();
    const urlInput = await screen.findByLabelText(/网址/);
    await user.type(urlInput, "https://x.com");
    expect(await screen.findByText("就绪")).toBeInTheDocument();
  });

  it("点预设 chip 把整套值填入表单（不直接运行）", async () => {
    const user = userEvent.setup();
    render(
      <ActionRunnerProvider>
        <Harness />
      </ActionRunnerProvider>
    );
    await user.click(await screen.findByRole("button", { name: "p1" }));
    const urlInput = await screen.findByLabelText(/网址/);
    expect(urlInput).toHaveValue("https://preset.example");
    expect(mockRunAction).not.toHaveBeenCalled();
  });

  it("双击预设 chip 直接运行该预设（与侧边栏预设子项一致）", async () => {
    const user = userEvent.setup();
    render(
      <ActionRunnerProvider>
        <Harness />
      </ActionRunnerProvider>
    );
    await user.dblClick(await screen.findByRole("button", { name: "p1" }));
    expect(mockRunAction).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({ URL: "https://preset.example" })
    );
  });

  it("发射台：点运行后收起为参数摘要并原位展开输出，展开编辑可回表单", async () => {
    const user = userEvent.setup();
    render(
      <ActionRunnerProvider>
        <Harness />
      </ActionRunnerProvider>
    );
    const urlInput = await screen.findByLabelText(/网址/);
    await user.type(urlInput, "https://x.com");
    await user.click(screen.getByRole("button", { name: "运行" }));
    // 发射态：摘要条出现、表单字段收起、停在 form 视图（Harness 不再触发 selectPreset）
    expect(await screen.findByText("本次装配")).toBeInTheDocument();
    expect(screen.getByTitle("URL=https://x.com")).toBeInTheDocument();
    expect(screen.queryByLabelText(/网址/)).not.toBeInTheDocument();
    // 展开编辑：回到装配表单，值保留
    await user.click(screen.getByRole("button", { name: "展开编辑" }));
    expect(await screen.findByLabelText(/网址/)).toHaveValue("https://x.com");
  });
});
