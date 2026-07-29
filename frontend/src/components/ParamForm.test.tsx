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
  PickDirectory: mockPickDirectory,
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
    { id: "URL", label: "网址", type: "text", required: true, default: "", options: [] },
    { id: "OPEN", label: "打开", type: "bool", required: false, default: "false", options: [] },
    { id: "MODE", label: "模式", type: "select", required: false, default: "fast", options: ["fast", "full"] },
    { id: "DIR", label: "目录", type: "path", required: false, default: "", options: [] },
  ],
  presets: [],
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
});
