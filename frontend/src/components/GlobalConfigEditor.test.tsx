import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../i18n";

const { mockGetGlobalConfig, mockSetGlobalConfig } = vi.hoisted(() => ({
  mockGetGlobalConfig: vi.fn(() => Promise.resolve({ OUTPUT_DIR: "D:/pages" })),
  mockSetGlobalConfig: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
  GetGlobalConfig: mockGetGlobalConfig,
  SetGlobalConfig: mockSetGlobalConfig,
  GetFragments: vi.fn().mockResolvedValue([]),
  SetFragments: vi.fn().mockResolvedValue(undefined),
  PickDirectory: vi.fn().mockResolvedValue(""),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => ({}) } }));

import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { GlobalConfigEditor } from "./GlobalConfigEditor";

beforeEach(async () => {
  mockGetGlobalConfig.mockReset().mockResolvedValue({ OUTPUT_DIR: "D:/pages" });
  mockSetGlobalConfig.mockReset().mockResolvedValue(undefined);
  await i18n.changeLanguage("zh");
});

describe("GlobalConfigEditor", () => {
  it("渲染已有全局配置行", async () => {
    render(
      <ActionRunnerProvider>
        <GlobalConfigEditor />
      </ActionRunnerProvider>
    );
    expect(await screen.findByDisplayValue("OUTPUT_DIR")).toBeInTheDocument();
    expect(screen.getByDisplayValue("D:/pages")).toBeInTheDocument();
  });

  it("改动后保存调用 SetGlobalConfig", async () => {
    const user = userEvent.setup();
    render(
      <ActionRunnerProvider>
        <GlobalConfigEditor />
      </ActionRunnerProvider>
    );
    const valueInput = await screen.findByDisplayValue("D:/pages");
    const saveBtn = screen.getByRole("button", { name: "保存" });
    expect(saveBtn).toBeDisabled();
    await user.type(valueInput, "x");
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);
    expect(mockSetGlobalConfig).toHaveBeenCalledWith({ OUTPUT_DIR: "D:/pagesx" });
  });
});
