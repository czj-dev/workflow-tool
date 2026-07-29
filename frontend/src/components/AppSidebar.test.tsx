import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../bindings/workflow-tool/internal/api/service.js", () => ({
  ListActions: vi.fn().mockResolvedValue({
    actions: [{ id: "a1", title: "打个招呼", icon: "👋", description: "d" }],
    errors: [],
  }),
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: () => () => ({}) } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { AppSidebar } from "./AppSidebar";

describe("AppSidebar", () => {
  it("渲染动作列表", async () => {
    render(
      <ActionRunnerProvider>
        <SidebarProvider>
          <AppSidebar />
        </SidebarProvider>
      </ActionRunnerProvider>
    );
    expect(await screen.findByText("打个招呼")).toBeInTheDocument();
    expect(screen.getByText("动作")).toBeInTheDocument();
  });
});
