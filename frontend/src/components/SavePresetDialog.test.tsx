import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import i18n from "../i18n";

const { mockAddPreset, action } = vi.hoisted(() => ({
  mockAddPreset: vi.fn(() => Promise.resolve({ actions: [], errors: [] })),
  // addPreset 内部依赖 currentId（preset 属于某个动作），Harness 会在 actions 加载后
  // selectPreset 把 currentId 设置好，模拟真实使用场景（用户先选动作再保存预设）。
  action: {
    id: "a1",
    title: "A",
    icon: "",
    description: "",
    params: [],
    presets: [],
  },
}));

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({ actions: [action], errors: [] }),
  RunAction: vi.fn(),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn(),
  GetFragments: vi.fn().mockResolvedValue([]),
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: vi.fn(),
  PickDirectory: vi.fn(),
  OpenActionsDir: vi.fn(),
  GetActionYaml: vi.fn(),
  SetActionYaml: vi.fn(),
  AddPreset: mockAddPreset,
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
}));

vi.mock("@wailsio/runtime", () => ({ Events: { On: vi.fn() } }));

import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { useActionRunner } from "../hooks/useActionRunner";
import { SavePresetDialog } from "./SavePresetDialog";

// Harness：actions 加载后自动选中第一个动作，设置 currentId（addPreset 的前置条件）。
function Harness({ onClose }: { onClose: () => void }) {
  const { actions, selectPreset } = useActionRunner();
  useEffect(() => {
    if (actions.length > 0) selectPreset(actions[0].id, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions]);
  return <SavePresetDialog open={true} onClose={onClose} />;
}

beforeEach(async () => {
  mockAddPreset.mockReset().mockResolvedValue({ actions: [], errors: [] });
  await i18n.changeLanguage("zh");
});

describe("SavePresetDialog", () => {
  it("名称为空时确定按钮禁用", async () => {
    render(
      <ActionRunnerProvider>
        <Harness onClose={() => {}} />
      </ActionRunnerProvider>
    );
    // 等 ListActions 解析、selectPreset 跑完，Dialog 渲染出按钮
    expect(await screen.findByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("填名称后确定调用 addPreset 并关闭", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ActionRunnerProvider>
        <Harness onClose={onClose} />
      </ActionRunnerProvider>
    );
    await user.type(await screen.findByLabelText(/名称/), "我的预设");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/名称/); // 等一拍让 async 完成
    expect(mockAddPreset).toHaveBeenCalledWith("a1", "我的预设", "", {});
    expect(onClose).toHaveBeenCalled();
  });
});
