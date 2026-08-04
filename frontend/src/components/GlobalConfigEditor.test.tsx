import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../i18n";

const { mockGetGlobalConfig, mockSetGlobalConfig, mockGetFragments, mockGetVarRefCounts } = vi.hoisted(() => ({
  mockGetGlobalConfig: vi.fn(() => Promise.resolve({ OUTPUT_DIR: "D:/pages" })),
  mockSetGlobalConfig: vi.fn(() => Promise.resolve()),
  mockGetFragments: vi.fn(),
  mockGetVarRefCounts: vi.fn(() => Promise.resolve({})),
}));

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
  GetGlobalConfig: mockGetGlobalConfig,
  SetGlobalConfig: mockSetGlobalConfig,
  GetVarReferenceCounts: mockGetVarRefCounts,
  GetFragments: mockGetFragments,
  SetFragments: vi.fn().mockResolvedValue(undefined),
  PickDirectory: vi.fn().mockResolvedValue(""),
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => ({}) } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { GlobalConfigEditor } from "./GlobalConfigEditor";

beforeEach(async () => {
  mockGetGlobalConfig.mockReset().mockResolvedValue({ OUTPUT_DIR: "D:/pages" });
  mockSetGlobalConfig.mockReset().mockResolvedValue(undefined);
  mockGetFragments.mockReset().mockResolvedValue([]);
  mockGetVarRefCounts.mockReset().mockResolvedValue({});
  await i18n.changeLanguage("zh");
});

function renderView() {
  return render(
    <SidebarProvider>
      <ActionRunnerProvider>
        <GlobalConfigEditor />
      </ActionRunnerProvider>
    </SidebarProvider>,
  );
}

describe("GlobalConfigEditor", () => {
  it("渲染已有全局配置行", async () => {
    renderView();
    expect(await screen.findByDisplayValue("OUTPUT_DIR")).toBeInTheDocument();
    expect(screen.getByDisplayValue("D:/pages")).toBeInTheDocument();
  });

  it("改动后保存调用 SetGlobalConfig", async () => {
    const user = userEvent.setup();
    renderView();
    const valueInput = await screen.findByDisplayValue("D:/pages");
    const saveBtn = screen.getByRole("button", { name: "保存" });
    expect(saveBtn).toBeDisabled();
    await user.type(valueInput, "x");
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);
    expect(mockSetGlobalConfig).toHaveBeenCalledWith({ OUTPUT_DIR: "D:/pagesx" });
  });

  it("显示变量被多少处引用（后端综合 actions + 片段）", async () => {
    mockGetVarRefCounts.mockResolvedValue({ OUTPUT_DIR: 3 });
    renderView();
    expect(await screen.findByText("3处")).toBeInTheDocument();
  });

  it("未被引用的变量标记为未用", async () => {
    renderView();
    expect(await screen.findByText("未用")).toBeInTheDocument();
  });

  it("重复键名给出红字提示", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByDisplayValue("OUTPUT_DIR");
    await user.click(screen.getByRole("button", { name: "新增" }));
    const keyInputs = screen.getAllByPlaceholderText("变量名");
    await user.type(keyInputs[1], "OUTPUT_DIR");
    // 两行同键 → 都标「重复」，底部出现覆盖说明
    expect(screen.getAllByText("重复")).toHaveLength(2);
    expect(screen.getByText(/保存时后者将覆盖/)).toBeInTheDocument();
  });
});
