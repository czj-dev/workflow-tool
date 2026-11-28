import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Folder01Icon } from "@hugeicons/core-free-icons";
import { SectionHead } from "./section-head";

// 只断言外部行为（规格 Testing）：用户可见文本、可访问角色与名称、aria-expanded 语义、
// 回调是否被调。不断言 class 名或内部 state。
describe("SectionHead 两行分区头", () => {
  it("画出组名、副行与计数；可折叠时是带 aria-expanded 的按钮", () => {
    render(
      <SectionHead icon={Folder01Icon} name="常用片段" sub="环境" count={12} onToggle={() => {}} />,
    );

    expect(screen.getByText("常用片段")).toBeInTheDocument();
    expect(screen.getByText("环境")).toBeInTheDocument();
    expect(screen.getByText("·12")).toBeInTheDocument();

    const btn = screen.getByRole("button", { name: /常用片段/ });
    expect(btn).toHaveAttribute("aria-expanded", "true");
  });

  it("collapsed=true 时 aria-expanded=false；点击按钮触发 onToggle", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(
      <SectionHead
        icon={Folder01Icon}
        name="常用片段"
        sub="环境"
        count={0}
        collapsed
        onToggle={onToggle}
      />,
    );

    expect(screen.getByRole("button", { name: /常用片段/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await user.click(screen.getByRole("button", { name: /常用片段/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <SectionHead
        icon={Folder01Icon}
        name="常用片段"
        sub="环境"
        count={0}
        onToggle={onToggle}
      />,
    );
    expect(screen.getByRole("button", { name: /常用片段/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("省略 onToggle = 纯展示（对话框预览）：不渲染按钮、不进 Tab 序", () => {
    render(<SectionHead icon={Folder01Icon} name="常用片段" sub="环境" count={3} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("常用片段")).toBeInTheDocument();
    expect(screen.getByText("·3")).toBeInTheDocument();
  });

  it("action 插槽渲染在头右侧，是独立的可点元素", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <SectionHead
        icon={Folder01Icon}
        name="常用片段"
        sub="环境"
        count={1}
        onToggle={() => {}}
        action={
          <button type="button" onClick={onAction}>
            删除分组
          </button>
        }
      />,
    );

    // 头本身一个按钮（折叠开关），插槽又是一个按钮，互不嵌套
    await user.click(screen.getByRole("button", { name: "删除分组" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /常用片段/ })).toBeInTheDocument();
  });
});
