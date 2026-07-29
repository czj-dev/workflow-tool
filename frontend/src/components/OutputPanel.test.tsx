import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({
    actions: [{ id: "a1", title: "A1", icon: "▶", description: "" }],
    errors: [],
  }),
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn().mockResolvedValue(undefined),
  PickDirectory: vi.fn().mockResolvedValue(""),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => ({}) } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { OutputPanel } from "./OutputPanel";

describe("OutputPanel", () => {
  it("渲染默认提示与工具栏按钮", async () => {
    render(
      <ActionRunnerProvider>
        <SidebarProvider>
          <OutputPanel />
        </SidebarProvider>
      </ActionRunnerProvider>
    );
    expect(await screen.findByText("选择一个动作")).toBeInTheDocument();
    expect(screen.getByText("停止")).toBeInTheDocument();
    expect(screen.getByText("清空")).toBeInTheDocument();
    expect(screen.getByText("复制")).toBeInTheDocument();
    // 语言切换默认显示 EN（当前中文）
    expect(screen.getByText("EN")).toBeInTheDocument();
  });
});
