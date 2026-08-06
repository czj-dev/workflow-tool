import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// mock bindings 与 runtime（hoisted 模式，便于引用）
const { mockListActions, mockRunAction, mockOn, listeners } = vi.hoisted(() => {
  const listeners: Record<string, (e: unknown) => void> = {};
  return {
    mockListActions: vi.fn(),
    mockRunAction: vi.fn(() => Promise.resolve()),
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
  PickDirectory: vi.fn().mockResolvedValue(""),
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { AppSidebar } from "./AppSidebar";

beforeEach(() => {
  Object.keys(listeners).forEach((k) => delete listeners[k]);
  mockListActions.mockReset();
  mockRunAction.mockReset().mockResolvedValue(undefined);
  mockOn.mockClear();
  // 主题测试需要：jsdom 无 matchMedia，mock 之；清 storage 保证初始态
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  localStorage.clear();
});

function wrap() {
  return (
    <ThemeProvider defaultTheme="light" storageKey="theme-test">
      <ActionRunnerProvider>
        <SidebarProvider>
          <AppSidebar />
        </SidebarProvider>
      </ActionRunnerProvider>
    </ThemeProvider>
  );
}

describe("AppSidebar", () => {
  it("渲染动作列表与常用动作分区标题", async () => {
    mockListActions.mockResolvedValue({
      actions: [
        { id: "a1", title: "打个招呼", icon: "👋", description: "d", params: [], presets: [] },
      ],
      errors: [],
    });
    render(wrap());
    expect(await screen.findByText("打个招呼")).toBeInTheDocument();
    expect(screen.getByText("常用动作")).toBeInTheDocument();
  });

  it("渲染底部全局配置入口", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    render(wrap());
    expect(await screen.findByText("全局配置")).toBeInTheDocument();
  });

  it("点击有参数动作后展开预设子项", async () => {
    const user = userEvent.setup();
    mockListActions.mockResolvedValue({
      actions: [
        {
          id: "scrape",
          title: "抓取",
          icon: "🌐",
          description: "",
          params: [
            { id: "URL", label: "网址", type: "text", required: true, default: "", options: [] },
          ],
          presets: [{ name: "首页", values: { URL: "https://x.com" } }],
        },
      ],
      errors: [],
    });
    render(wrap());
    const item = await screen.findByText("抓取");
    await user.click(item);
    expect(await screen.findByText("首页")).toBeInTheDocument();
  });

  it("底部 Footer 展示设置入口，不再直接显示主题按钮", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    render(wrap());
    // 主题/语言归拢进「设置」页；侧边栏只剩入口按钮
    expect(await screen.findByText("设置")).toBeInTheDocument();
    expect(screen.queryByText("浅色")).not.toBeInTheDocument();
    expect(screen.queryByText("深色")).not.toBeInTheDocument();
  });
});
