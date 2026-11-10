import { describe, expect, it } from "vitest";
import { invalidArrayParams, normalizeArrayParams, parseArgumentRows, parseStringList } from "./arrayParams";

describe("JSON array parameters", () => {
  it("preserves repeated flags, order, and spaces in values", () => {
    expect(parseArgumentRows('[{"flag":"--es","values":["exec_button","hello world"]},{"flag":"-W","values":[]},{"flag":"--es","values":["other","yes"]}]')).toEqual([
      { flag: "--es", values: ["exec_button", "hello world"] },
      { flag: "-W", values: [] },
      { flag: "--es", values: ["other", "yes"] },
    ]);
  });

  it("rejects malformed lists and legacy whitespace-delimited values", () => {
    expect(parseStringList('["DVR_A","DVR B"]')).toEqual(["DVR_A", "DVR B"]);
    expect(() => parseStringList("DVR_A DVR_B")).toThrow();
    expect(() => parseStringList('["ok",7]')).toThrow();
    expect(() => parseArgumentRows('[{"flag":"--es","values":"key value"}]')).toThrow();
  });

  it("normalizes empty fields and allows explicitly ignored TAG with a valid FILTER", () => {
    const specs = [{ id: "TAG", type: "list" }, { id: "ARGS", type: "arguments" }];
    const values = { TAG: "legacy tag", ARGS: " ", EXTRA: "keep" };
    expect(invalidArrayParams(specs, values)).toEqual(["TAG"]);
    expect(invalidArrayParams(specs, values, ["TAG"])).toEqual([]);
    expect(normalizeArrayParams(specs, { TAG: "", ARGS: " ", EXTRA: "keep" })).toEqual({
      TAG: "[]", ARGS: "[]", EXTRA: "keep",
    });
    expect(values).toEqual({ TAG: "legacy tag", ARGS: " ", EXTRA: "keep" });
  });
});
