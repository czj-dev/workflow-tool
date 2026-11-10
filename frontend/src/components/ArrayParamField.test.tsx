import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ParamSpec } from "../../bindings/workflow-tool/internal/registry/models.js";
import i18n from "../i18n";
import { ArrayParamField } from "./ArrayParamField";

function mount(type: "list" | "arguments", initialValue: string) {
  const setValue = vi.fn();
  const spec = new ParamSpec({ id: "ITEMS", label: "Items", type });

  function Harness() {
    const [value, updateValue] = useState(initialValue);
    return <ArrayParamField spec={spec} value={value} setValue={(id, next) => {
      setValue(id, next);
      updateValue(next);
    }} />;
  }

  render(<Harness />);
  return { setValue };
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});

describe("ArrayParamField row operations", () => {
  it("moves list rows in both directions and removes only the selected row", async () => {
    const user = userEvent.setup();
    const { setValue } = mount("list", '["A","B","C"]');

    expect(screen.getByRole("button", { name: "上移Items 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下移Items 3" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "下移Items 1" }));
    expect(setValue).toHaveBeenLastCalledWith("ITEMS", '["B","A","C"]');
    await user.click(screen.getByRole("button", { name: "上移Items 3" }));
    expect(setValue).toHaveBeenLastCalledWith("ITEMS", '["B","C","A"]');
    await user.click(screen.getByRole("button", { name: "删除Items 2" }));
    expect(setValue).toHaveBeenLastCalledWith("ITEMS", '["B","A"]');
    expect(screen.getByRole("textbox", { name: "Items 2" })).toHaveValue("A");
  });

  it("moves argument rows with duplicate flags without merging values, then removes one", async () => {
    const user = userEvent.setup();
    const { setValue } = mount("arguments", JSON.stringify([
      { flag: "--es", values: ["first"] },
      { flag: "--es", values: ["second"] },
      { flag: "-W", values: [] },
    ]));

    expect(screen.getByRole("button", { name: "上移Items 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下移Items 3" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "上移Items 2" }));
    expect(JSON.parse(setValue.mock.lastCall![1])).toEqual([
      { flag: "--es", values: ["second"] },
      { flag: "--es", values: ["first"] },
      { flag: "-W", values: [] },
    ]);
    await user.click(screen.getByRole("button", { name: "下移Items 2" }));
    expect(JSON.parse(setValue.mock.lastCall![1])).toEqual([
      { flag: "--es", values: ["second"] },
      { flag: "-W", values: [] },
      { flag: "--es", values: ["first"] },
    ]);
    await user.click(screen.getByRole("button", { name: "删除Items 1" }));
    expect(setValue).toHaveBeenLastCalledWith("ITEMS", JSON.stringify([
      { flag: "-W", values: [] },
      { flag: "--es", values: ["first"] },
    ]));
  });

  it("moves and removes only the selected argument value, preserving duplicate flags and row order", async () => {
    const user = userEvent.setup();
    const { setValue } = mount("arguments", JSON.stringify([
      { flag: "--es", values: ["a", "b", "c"] },
      { flag: "--es", values: ["other"] },
    ]));

    expect(screen.getByRole("button", { name: "上移Items 1 值 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下移Items 1 值 3" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "下移Items 1 值 1" }));
    expect(JSON.parse(setValue.mock.lastCall![1])).toEqual([
      { flag: "--es", values: ["b", "a", "c"] },
      { flag: "--es", values: ["other"] },
    ]);
    await user.click(screen.getByRole("button", { name: "上移Items 1 值 3" }));
    expect(JSON.parse(setValue.mock.lastCall![1])[0].values).toEqual(["b", "c", "a"]);
    await user.click(screen.getByRole("button", { name: "删除Items 1 值 2" }));
    expect(setValue).toHaveBeenLastCalledWith("ITEMS", JSON.stringify([
      { flag: "--es", values: ["b", "a"] },
      { flag: "--es", values: ["other"] },
    ]));
  });

  it("activates labeled controls from the keyboard and keeps focus on the moved control", async () => {
    const user = userEvent.setup();
    const { setValue } = mount("list", '["one","two"]');
    const moveDown = screen.getByRole("button", { name: "下移Items 1" });

    moveDown.focus();
    expect(moveDown).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(setValue).toHaveBeenLastCalledWith("ITEMS", '["two","one"]');
    expect(moveDown).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Items 1" })).toHaveValue("two");
    expect(screen.getByRole("button", { name: "上移Items 1" })).toBeDisabled();
  });

  it("can add rows and values, and resets invalid JSON without changing the field id", async () => {
    const user = userEvent.setup();
    const { setValue } = mount("arguments", "invalid");

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "添加Items" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重置Items" }));
    expect(setValue).toHaveBeenLastCalledWith("ITEMS", "[]");
    await user.click(screen.getByRole("button", { name: "添加Items" }));
    await user.type(screen.getByRole("textbox", { name: "Items 1 flag" }), "--flag");
    await user.click(screen.getByRole("button", { name: "添加Items 1 值" }));
    await user.type(screen.getByRole("textbox", { name: "Items 1 值 1" }), "text");
    expect(setValue).toHaveBeenLastCalledWith("ITEMS", '[{"flag":"--flag","values":["text"]}]');
  });
});
