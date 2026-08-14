import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../i18n";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarProvider } from "@/components/ui/sidebar";
import { YamlEditor } from "./YamlEditor";
import { getCmValue, typeIntoCm } from "../test/codemirror";

const items = [
  { id: "a", title: "动作A" },
  { id: "b", title: "动作B" },
];

function renderEditor() {
  const getYaml = vi.fn(async (id: string) => `id: ${id}\n`);
  const saveYaml = vi.fn(async () => undefined);
  const onExit = vi.fn();
  const utils = render(
    <ThemeProvider>
      <SidebarProvider>
        <YamlEditor
          kind="action"
          items={items}
          currentId={null}
          getYaml={getYaml}
          saveYaml={saveYaml}
          onExit={onExit}
        />
      </SidebarProvider>
    </ThemeProvider>
  );
  return { ...utils, getYaml, saveYaml, onExit };
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});

describe("YamlEditor", () => {
  it("⌘/Ctrl+S 经宿主 keydown 监听触发保存（带最新编辑内容）", async () => {
    const { saveYaml } = renderEditor();
    await waitFor(() => expect(getCmValue()).toContain("id: a"));
    // 用 act 包裹，确保编辑产生的 React 状态更新 + 宿主 keydown 监听（依赖 save）已重挂载
    await act(async () => {
      typeIntoCm("\nkey: value");
    });
    expect(saveYaml).not.toHaveBeenCalled();
    const content = document.querySelector(".cm-content") as HTMLElement;
    await act(async () => {
      content.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "s",
          metaKey: true,
          bubbles: true,
        }),
      );
    });
    await waitFor(() =>
      expect(saveYaml).toHaveBeenCalledWith(
        "a",
        expect.stringContaining("key: value"),
      ),
    );
  });

  it("dirty 状态切换 editingId 弹出放弃确认弹窗，确认后继续切换", async () => {
    const user = userEvent.setup();
    renderEditor();
    await waitFor(() => expect(getCmValue()).toContain("id: a"));
    await act(async () => {
      typeIntoCm("\nchanged");
    });
    // 切换 Select（dirty）→ guard 拦截：弹确认弹窗而非直接切换
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "动作B" }));
    expect(await screen.findByText("放弃未保存的改动？")).toBeInTheDocument();
    // 取消：仍停留在 a
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(getCmValue()).toContain("id: a");
    // 再次切换并「放弃」→ 继续切换到 b
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "动作B" }));
    await user.click(await screen.findByRole("button", { name: "放弃" }));
    await waitFor(() => expect(getCmValue()).toContain("id: b"));
  });

  it("无 item 时显示空态且不渲染编辑器", async () => {
    render(
      <ThemeProvider>
        <SidebarProvider>
          <YamlEditor
            kind="action"
            items={[]}
            currentId={null}
            getYaml={vi.fn()}
            saveYaml={vi.fn()}
            onExit={vi.fn()}
          />
        </SidebarProvider>
      </ThemeProvider>
    );
    expect(await screen.findByText(/无 Action/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
