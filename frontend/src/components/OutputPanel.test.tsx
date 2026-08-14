import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({
    actions: [{ id: "a1", title: "A1", icon: "▶", description: "" }],
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
  GetActionYaml: vi.fn().mockResolvedValue("id: a1\ntitle: A1\n"),
  SetActionYaml: vi.fn().mockResolvedValue({ actions: [], errors: [] }),
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => ({}) } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { OutputPanel } from "./OutputPanel";

describe("OutputPanel", () => {
  it("渲染默认提示与工具栏按钮", async () => {
    render(
      <ThemeProvider>
        <ActionRunnerProvider>
          <SidebarProvider>
            <OutputPanel />
          </SidebarProvider>
        </ActionRunnerProvider>
      </ThemeProvider>
    );
    expect(await screen.findByText("选择一个动作")).toBeInTheDocument();
    expect(screen.getByText("停止")).toBeInTheDocument();
    expect(screen.getByText("清空")).toBeInTheDocument();
    expect(screen.getByText("复制")).toBeInTheDocument();
  });

  it("点击标题进入编辑视图", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ActionRunnerProvider>
          <SidebarProvider>
            <OutputPanel />
          </SidebarProvider>
        </ActionRunnerProvider>
      </ThemeProvider>
    );
    await screen.findByText("选择一个动作");
    await user.click(screen.getByRole("button", { name: "选择一个动作" }));
    expect(await screen.findByRole("button", { name: "保存" })).toBeInTheDocument();
  });
});
