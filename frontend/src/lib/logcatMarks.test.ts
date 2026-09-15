import { describe, expect, it } from "vitest";
import {
  MARK_FIELD_MESSAGE,
  MARK_FIELD_PID,
  MARK_FIELD_TAG,
  fieldMarkColor,
  markColorOf,
  splitMarked,
} from "./logcatMarks";

describe("markColorOf", () => {
  it("序位 → 色号 1..8 循环", () => {
    expect(markColorOf(0)).toBe(1);
    expect(markColorOf(7)).toBe(8);
    expect(markColorOf(8)).toBe(1);
    expect(markColorOf(9)).toBe(2);
  });

  it("负下标绕回色板（防御）", () => {
    expect(markColorOf(-1)).toBe(8);
  });
});

describe("splitMarked", () => {
  it("marks 缺省/空 → 单段原文", () => {
    expect(splitMarked("hello", undefined, MARK_FIELD_MESSAGE)).toEqual([
      { text: "hello", color: null },
    ]);
    expect(splitMarked("hello", [], MARK_FIELD_MESSAGE)).toEqual([
      { text: "hello", color: null },
    ]);
  });

  it("命中子串带色、前后为普通段（与 Go Marks 用例同构）", () => {
    // Go TestMarksContainsAllOccurrences：\"a >==>> b >==>> c\" → (2,5)(10,5)
    const marks = [
      [0, 0, 2, 5],
      [0, 0, 10, 5],
    ];
    expect(splitMarked("a >==>> b >==>> c", marks, MARK_FIELD_MESSAGE)).toEqual([
      { text: "a ", color: null },
      { text: ">==>>", color: 1 },
      { text: " b ", color: null },
      { text: ">==>>", color: 1 },
      { text: " c", color: null },
    ]);
  });

  it("只应用当前域的 marks（域码过滤）", () => {
    const marks = [
      [0, 0, 0, 3],
      [1, 1, 0, 3],
    ];
    expect(splitMarked("tagtext", marks, MARK_FIELD_TAG)).toEqual([
      { text: "tag", color: 2 },
      { text: "text", color: null },
    ]);
    expect(splitMarked("message", marks, MARK_FIELD_MESSAGE)).toEqual([
      { text: "mes", color: 1 },
      { text: "sage", color: null },
    ]);
  });

  it("重叠区间按序后者覆盖（契约：后端 (t,f,s) 升序即覆盖优先级）", () => {
    const marks = [
      [0, 0, 0, 4],
      [1, 0, 2, 4],
    ];
    expect(splitMarked("abcdefgh", marks, MARK_FIELD_MESSAGE)).toEqual([
      { text: "ab", color: 1 },
      { text: "cdef", color: 2 },
      { text: "gh", color: null },
    ]);
  });

  it("越界与非法四元组钳制跳过，不抛错", () => {
    const marks = [
      [0, 0, -3, 5], // 起点为负：钳到 0，标注前 2 格
      [0, 0, 6, 99], // 起点已越界：无标注（终界同时截断）
      [0, 9, 0, 1], // 非法域码：忽略
      [0, 0, 1], // 缺长度：忽略
    ];
    expect(splitMarked("abcd", marks, MARK_FIELD_MESSAGE)).toEqual([
      { text: "ab", color: 1 },
      { text: "cd", color: null },
    ]);
  });

  it("多 token 相邻命中不合并为一段（色号不同）", () => {
    const marks = [
      [0, 0, 0, 2],
      [1, 0, 2, 2],
    ];
    expect(splitMarked("abcd", marks, MARK_FIELD_MESSAGE)).toEqual([
      { text: "ab", color: 1 },
      { text: "cd", color: 2 },
    ]);
  });
});

describe("fieldMarkColor", () => {
  it("取该域首个命中的色号", () => {
    const marks = [
      [0, 0, 0, 3],
      [2, 2, 0, 4],
    ];
    expect(fieldMarkColor(marks, MARK_FIELD_PID)).toBe(3);
    expect(fieldMarkColor(marks, MARK_FIELD_TAG)).toBeNull();
  });

  it("marks 缺省 → null", () => {
    expect(fieldMarkColor(undefined, MARK_FIELD_PID)).toBeNull();
  });
});
