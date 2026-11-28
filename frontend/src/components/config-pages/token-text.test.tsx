import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../i18n";
import { TokenText } from "./token-text";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});

// 只断言外部行为（规格 Testing）：用户可见文本、可访问角色与名称、DOM 契约属性（data-drop-*）、
// 提交给回调的载荷。不断言 class 名或内部 state。
describe("TokenText ${VAR} token 渲染与就地填写", () => {
  it("token 按原样写法渲染：已定义的琥珀字带 title 当前值，缺失的是可点按钮", () => {
    render(
      <TokenText
        content="cat ${DOCS}/log.txt | grep ${MISSING}"
        vars={{ DOCS: "/data/docs" }}
        fragIndex={0}
        onSetVar={() => {}}
      />,
    );

    // 已定义：文本是 ${DOCS} 原样写法，悬停能看到当前值
    expect(screen.getByTitle("/data/docs")).toHaveTextContent("${DOCS}");
    // 缺失：红字可点的 token，可访问名即 ${MISSING} 原样
    expect(screen.getByRole("button", { name: "${MISSING}" })).toBeInTheDocument();
    // 非 token 的文字原样保留（getByText 会把两侧空白折叠修剪，所以这里用归一化后的文本）
    expect(screen.getByText("cat")).toBeInTheDocument();
    expect(screen.getByText("/log.txt | grep")).toBeInTheDocument();
  });

  it("点击缺失 token 原地变输入框：回车提交，token 显示填入的值", async () => {
    const user = userEvent.setup();
    const onSetVar = vi.fn();
    render(
      <TokenText
        content="grep ${MISSING} file"
        vars={{}}
        fragIndex={2}
        onSetVar={onSetVar}
      />,
    );

    await user.click(screen.getByRole("button", { name: "${MISSING}" }));
    const input = screen.getByRole("textbox", { name: "MISSING" });
    await user.type(input, "/tmp/x.log");
    await user.keyboard("{Enter}");

    expect(onSetVar).toHaveBeenCalledTimes(1);
    expect(onSetVar).toHaveBeenCalledWith("MISSING", "/tmp/x.log");
  });

  it("已填的临时值显示填入的值（不再是 ${VAR} 写法），悬停提示仅本次会话生效", () => {
    render(
      <TokenText
        content="grep ${MISSING} file"
        vars={{}}
        overrides={{ MISSING: "/tmp/x.log" }}
        fragIndex={0}
        onSetVar={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "/tmp/x.log" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "/tmp/x.log" }),
    ).toHaveAttribute("title", "MISSING · 仅本次会话生效");
  });

  it("Esc 取消不提交；空值失焦也不提交", async () => {
    const user = userEvent.setup();
    const onSetVar = vi.fn();
    const { rerender } = render(
      <TokenText content="grep ${A} file" vars={{}} fragIndex={0} onSetVar={onSetVar} />,
    );

    // Esc 取消
    await user.click(screen.getByRole("button", { name: "${A}" }));
    await user.type(screen.getByRole("textbox", { name: "A" }), "abc");
    await user.keyboard("{Escape}");
    expect(onSetVar).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "${A}" })).toBeInTheDocument();

    // 空值失焦不提交
    await user.click(screen.getByRole("button", { name: "${A}" }));
    await user.click(document.body);
    expect(onSetVar).not.toHaveBeenCalled();

    // 失焦提交非空值（走 blur 路径而非回车）
    rerender(<TokenText content="grep ${A} file" vars={{}} fragIndex={0} onSetVar={onSetVar} />);
    await user.click(screen.getByRole("button", { name: "${A}" }));
    await user.type(screen.getByRole("textbox", { name: "A" }), "zzz");
    await user.click(document.body);
    expect(onSetVar).toHaveBeenCalledWith("A", "zzz");
  });

  it("缺失 token 带拖拽契约属性，供 file:dropped 按坐标定位；已定义 token 不带", () => {
    render(
      <TokenText content="x ${A} ${B}" vars={{ B: "1" }} fragIndex={3} onSetVar={() => {}} />,
    );

    const missing = screen.getByRole("button", { name: "${A}" });
    expect(missing).toHaveAttribute("data-drop-var", "A");
    expect(missing).toHaveAttribute("data-drop-frag", "3");
    expect(screen.getByTitle("1")).not.toHaveAttribute("data-drop-var");
  });

  it("interactive=false 时缺失 token 退化为纯文字（可安全放进本身就是按钮的行里）", () => {
    render(
      <TokenText
        content="cmd ${MISSING}"
        vars={{}}
        overrides={{ MISSING: "val" }}
        interactive={false}
      />,
    );

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    // 已填的仍显示填入的值
    expect(screen.getByText("val")).toBeInTheDocument();
    // 无临时值的缺失 token 显示 ${MISSING} 原样
    render(<TokenText content="cmd ${OTHER}" vars={{}} interactive={false} />);
    expect(screen.getByText("${OTHER}")).toBeInTheDocument();
  });
});
