import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findDropInput,
  joinDroppedPaths,
  valueForInput,
  writeToInput,
} from "./filedrop";

// jsdom 不做布局，也根本没实现 elementFromPoint，直接赋一个「返回指定元素」的替身
const hit = (el: Element | null) => {
  document.elementFromPoint = (() => el) as typeof document.elementFromPoint;
};

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "elementFromPoint");
  document.body.innerHTML = "";
});

describe("joinDroppedPaths", () => {
  it("单个路径原样返回", () => {
    expect(joinDroppedPaths(["/a/b.apk"])).toBe("/a/b.apk");
  });

  it("多个路径按传入顺序空格拼接", () => {
    expect(joinDroppedPaths(["/a.txt", "/b.txt", "/c.txt"])).toBe(
      "/a.txt /b.txt /c.txt",
    );
  });

  it("含空格的路径加双引号，不含空格的不加", () => {
    expect(joinDroppedPaths(["/a/b.txt", "/c/My Docs/d.txt"])).toBe(
      '/a/b.txt "/c/My Docs/d.txt"',
    );
  });
});

describe("findDropInput", () => {
  it("精确命中 input 就用它", () => {
    document.body.innerHTML = `<input id="t" />`;
    const el = document.getElementById("t")!;
    hit(el);
    expect(findDropInput(1, 1)).toBe(el);
  });

  it("命中 Field 内的非控件（标签/图标/按钮）时向下取控件", () => {
    document.body.innerHTML = `
      <div data-slot="field">
        <label id="lbl">APK 路径</label>
        <input id="t" />
      </div>`;
    hit(document.getElementById("lbl"));
    expect(findDropInput(1, 1)).toBe(document.getElementById("t"));
  });

  it("命中 Field 内的 textarea 同样可写", () => {
    document.body.innerHTML = `
      <div data-slot="field"><label id="lbl">x</label><textarea id="t"></textarea></div>`;
    hit(document.getElementById("lbl"));
    expect(findDropInput(1, 1)).toBe(document.getElementById("t"));
  });

  it("落在无输入框的区域 → null（静默忽略）", () => {
    document.body.innerHTML = `<div id="blank">空白</div>`;
    hit(document.getElementById("blank"));
    expect(findDropInput(1, 1)).toBeNull();
  });

  it("坐标什么都没命中 → null", () => {
    hit(null);
    expect(findDropInput(1, 1)).toBeNull();
  });

  it("disabled / readonly 一律跳过", () => {
    document.body.innerHTML = `<input id="d" disabled /><input id="r" readonly />`;
    hit(document.getElementById("d"));
    expect(findDropInput(1, 1)).toBeNull();
    hit(document.getElementById("r"));
    expect(findDropInput(1, 1)).toBeNull();
  });
});

describe("valueForInput", () => {
  it("普通字段拼接全部路径", () => {
    document.body.innerHTML = `<input id="t" />`;
    const el = document.getElementById("t") as HTMLInputElement;
    expect(valueForInput(el, ["/a.txt", "/b.txt"])).toBe("/a.txt /b.txt");
  });

  it("带 data-drop-single 的字段（path/file 类型）只取首个", () => {
    document.body.innerHTML = `<input id="t" data-drop-single />`;
    const el = document.getElementById("t") as HTMLInputElement;
    expect(valueForInput(el, ["/a.apk", "/b.apk"])).toBe("/a.apk");
  });
});

describe("writeToInput", () => {
  it("覆盖原值、派发 input 事件、并聚焦", () => {
    document.body.innerHTML = `<input id="t" value="旧值" />`;
    const el = document.getElementById("t") as HTMLInputElement;
    const onInput = vi.fn();
    el.addEventListener("input", onInput);

    writeToInput(el, "/new/path");

    expect(el.value).toBe("/new/path");
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(el);
  });
});
