import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../i18n";

const { mockGetAgentConfig, mockSetAgentConfig } = vi.hoisted(() => ({
  mockGetAgentConfig: vi.fn(),
  mockSetAgentConfig: vi.fn(),
}));

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  ListAiTasks: vi.fn().mockResolvedValue({ tasks: [], errors: [] }),
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn().mockResolvedValue(undefined),
  GetAgentConfig: mockGetAgentConfig,
  SetAgentConfig: mockSetAgentConfig,
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  GetFragments: vi.fn().mockResolvedValue([]),
  SetFragments: vi.fn().mockResolvedValue(undefined),
  PickDirectory: vi.fn().mockResolvedValue(""),
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => ({}) } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { SettingsView } from "./SettingsView";

beforeEach(async () => {
  mockGetAgentConfig
    .mockReset()
    .mockResolvedValue({ baseUrl: "http://gw:8000/v1", authKey: "k-123", model: "GLM-5.3-Flash" });
  mockSetAgentConfig.mockReset().mockResolvedValue(undefined);
  await i18n.changeLanguage("zh");
});

function renderView() {
  return render(
    <SidebarProvider>
      <ThemeProvider>
        <ActionRunnerProvider>
          <SettingsView />
        </ActionRunnerProvider>
      </ThemeProvider>
    </SidebarProvider>,
  );
}

describe("SettingsView Agent 分区", () => {
  it("渲染 Agent 三键当前值（来自 GetAgentConfig）", async () => {
    renderView();
    expect(await screen.findByDisplayValue("http://gw:8000/v1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("k-123")).toBeInTheDocument();
    expect(screen.getByDisplayValue("GLM-5.3-Flash")).toBeInTheDocument();
  });

  it("密钥输入框遮蔽显示", async () => {
    renderView();
    const auth = await screen.findByDisplayValue("k-123");
    expect(auth).toHaveAttribute("type", "password");
  });

  it("未改动时保存禁用；改动后保存下发三键并复位 dirty", async () => {
    const user = userEvent.setup();
    renderView();
    const model = await screen.findByDisplayValue("GLM-5.3-Flash");
    const saveBtn = screen.getByRole("button", { name: "保存 Agent 配置" });
    expect(saveBtn).toBeDisabled();
    await user.type(model, "-X");
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);
    expect(mockSetAgentConfig).toHaveBeenCalledWith({
      baseUrl: "http://gw:8000/v1",
      authKey: "k-123",
      model: "GLM-5.3-Flash-X",
      extra: undefined,
    });
    expect(saveBtn).toBeDisabled();
  });

});
