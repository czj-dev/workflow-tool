import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../i18n";
import { Swatches } from "./swatch";
import type { AmbColorValue } from "@/lib/amb-colors";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});

// 色卡是受控原子：键盘步进基于当前值，连续按键需要父级把变更应用回去才符合真实用法。
function Harness({
  initial,
  unsetLabel,
  onChange,
}: {
  initial: AmbColorValue;
  unsetLabel?: string;
  onChange: (color: AmbColorValue) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Swatches
      value={value}
      onChange={(c) => {
        onChange(c);
        setValue(c);
      }}
      label="卡片颜色"
      unsetLabel={unsetLabel}
    />
  );
}

// 色卡是通用原子（规格 G）：只断言外部行为——可访问角色与名称、键盘交互、回调载荷。
describe("Swatches 五色色卡", () => {
  it("是带可读名的 radiogroup：五色单选项，选中项 aria-checked", () => {
    render(<Swatches value="green" onChange={() => {}} label="卡片颜色" />);

    expect(screen.getByRole("radiogroup", { name: "卡片颜色" })).toBeInTheDocument();
    for (const name of ["琥珀", "绿色", "青色", "蓝色", "紫色"]) {
      expect(screen.getByRole("radio", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("radio", { name: "绿色" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "青色" })).toHaveAttribute("aria-checked", "false");
  });

  it("点击即选中新色，回调只带颜色名", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Swatches value="amber" onChange={onChange} label="卡片颜色" />);

    await user.click(screen.getByRole("radio", { name: "蓝色" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("blue");
  });

  it("方向键切换颜色并把焦点带给新选中项，到头回绕", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="amber" onChange={onChange} />);

    screen.getByRole("radio", { name: "琥珀" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("green");
    expect(screen.getByRole("radio", { name: "绿色" })).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(onChange).toHaveBeenLastCalledWith("cyan");
    expect(screen.getByRole("radio", { name: "青色" })).toHaveFocus();

    // 到头回绕：琥珀上按 ArrowLeft 回到紫色
    screen.getByRole("radio", { name: "琥珀" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("violet");
    expect(screen.getByRole("radio", { name: "紫色" })).toHaveFocus();
  });

  it("未设置档：传入 unsetLabel 才出现，点击以 null 提交，也参与方向键循环", async () => {
    const user = userEvent.setup();

    const bare = render(<Harness initial="cyan" onChange={() => {}} />);
    expect(screen.queryByRole("radio", { name: "跟随分区色" })).not.toBeInTheDocument();
    bare.unmount();

    const onChange = vi.fn();
    render(<Harness initial="violet" onChange={onChange} unsetLabel="跟随分区色" />);
    const unset = screen.getByRole("radio", { name: "跟随分区色" });
    expect(unset).toHaveAttribute("aria-checked", "false");

    await user.click(unset);
    expect(onChange).toHaveBeenLastCalledWith(null);

    // 方向键跨过未设置档：从紫色按 ArrowRight 落到未设置档，再按一步回绕到琥珀
    await user.click(screen.getByRole("radio", { name: "紫色" }));
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole("radio", { name: "跟随分区色" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("amber");
    expect(screen.getByRole("radio", { name: "琥珀" })).toHaveFocus();
  });
});
