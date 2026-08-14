import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../i18n";
import { ThemeProvider } from "@/components/theme-provider";
import { getCmValue, typeIntoCm } from "../test/codemirror";

const { mockListActions, mockGetActionYaml, mockSetActionYaml, mockOn, listeners } =
  vi.hoisted(() => {
    const listeners: Record<string, (e: unknown) => void> = {};
    return {
      mockListActions: vi.fn(),
      mockGetActionYaml: vi.fn(),
      mockSetActionYaml: vi.fn(),
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
  RunAction: vi.fn().mockResolvedValue(undefined),
  CancelAction: vi.fn(),
  GetGlobalConfig: vi.fn().mockResolvedValue({}),
  SetGlobalConfig: vi.fn().mockResolvedValue(undefined),
  GetFragments: vi.fn().mockResolvedValue([]),
  GetVarReferenceCounts: vi.fn().mockResolvedValue({}),
  SetFragments: vi.fn().mockResolvedValue(undefined),
  PickDirectory: vi.fn().mockResolvedValue(""),
  GetActionYaml: mockGetActionYaml,
  SetActionYaml: mockSetActionYaml,
  ListWorkflows: vi.fn().mockResolvedValue({ workflows: [], errors: [] }),
  RunWorkflow: vi.fn().mockResolvedValue(undefined),
  CancelWorkflow: vi.fn(),
}));
vi.mock("@wailsio/runtime", () => ({ Events: { On: mockOn } }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { ActionRunnerProvider } from "../context/ActionRunnerProvider";
import { ActionYamlEditor } from "./ActionYamlEditor";

const ORIGINAL_YAML =
  "# 注释\nid: a\ntitle: 动作A\ncommand:\n  shell: echo hi\n";

function renderEditor() {
  return render(
    <ThemeProvider>
      <SidebarProvider>
        <ActionRunnerProvider>
          <ActionYamlEditor />
        </ActionRunnerProvider>
      </SidebarProvider>
    </ThemeProvider>
  );
}

beforeEach(async () => {
  Object.keys(listeners).forEach((k) => delete listeners[k]);
  mockListActions.mockReset().mockResolvedValue({
    actions: [{ id: "a", title: "动作A", icon: "", description: "", params: [], presets: [], stream: "" }],
    errors: [],
  });
  mockGetActionYaml.mockReset().mockResolvedValue("# 注释\nid: a\ntitle: 动作A\ncommand:\n  shell: echo hi\n");
  mockSetActionYaml.mockReset().mockResolvedValue({ actions: [], errors: [] });
  mockOn.mockClear();
  await i18n.changeLanguage("zh");
});

describe("ActionYamlEditor", () => {
  it("进入时加载首个 action 原文到编辑区", async () => {
    renderEditor();
    await waitFor(() => expect(getCmValue()).toContain("# 注释"));
  });

  it("编辑后保存调用 saveActionYaml 并清 dirty", async () => {
    const user = userEvent.setup();
    renderEditor();
    await waitFor(() => expect(getCmValue()).toContain("echo hi"));
    const saveBtn = screen.getByRole("button", { name: "保存" });
    expect(saveBtn).toBeDisabled();
    typeIntoCm("\n# 新行");
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);
    await waitFor(() =>
      expect(mockSetActionYaml).toHaveBeenCalledWith(
        "a",
        expect.stringContaining("# 新行"),
      ),
    );
    // 保存成功后 dirty 清零 → 再次禁用
    await waitFor(() => expect(saveBtn).toBeDisabled());
  });

  it("保存失败显示错误文案", async () => {
    mockSetActionYaml.mockRejectedValueOnce("YAML 解析失败: line 1");
    const user = userEvent.setup();
    renderEditor();
    await waitFor(() => expect(getCmValue()).toContain("echo hi"));
    typeIntoCm("x");
    const saveBtn = screen.getByRole("button", { name: "保存" });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);
    expect(await screen.findByText(/YAML 解析失败/)).toBeInTheDocument();
  });

  it("无 action 时显示空态", async () => {
    mockListActions.mockResolvedValue({ actions: [], errors: [] });
    renderEditor();
    expect(await screen.findByText(/无 Action/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("Provider 重渲染不覆盖未保存编辑（回归）", async () => {
    const { rerender } = render(
      <ThemeProvider>
        <SidebarProvider>
          <ActionRunnerProvider>
            <ActionYamlEditor />
          </ActionRunnerProvider>
        </SidebarProvider>
      </ThemeProvider>
    );
    await waitFor(() => expect(getCmValue()).toContain("echo hi"));
    typeIntoCm("x");
    const edited = getCmValue();
    expect(edited).not.toBe(ORIGINAL_YAML);
    // 强制 Provider 重渲染 → getActionYaml 新引用；修复前 effect 会重跑覆盖，修复后保留
    rerender(
      <ThemeProvider>
        <SidebarProvider>
          <ActionRunnerProvider>
            <ActionYamlEditor />
          </ActionRunnerProvider>
        </SidebarProvider>
      </ThemeProvider>
    );
    expect(getCmValue()).toBe(edited);
  });
});
