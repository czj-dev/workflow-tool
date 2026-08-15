import { describe, expect, it } from "vitest";
import { hasFormFields, missingRequired } from "./params";
import type { ParamSpec } from "../../bindings/workflow-tool/internal/registry/models.js";

const mk = (p: Partial<ParamSpec>): ParamSpec => ({
  id: p.id ?? "x",
  label: p.label ?? "x",
  type: p.type ?? "text",
  required: p.required ?? false,
  default: p.default ?? "",
  options: p.options ?? [],
});

describe("hasFormFields", () => {
  it("undefined / null / 空数组 → false（直接运行）", () => {
    expect(hasFormFields(undefined)).toBe(false);
    expect(hasFormFields(null)).toBe(false);
    expect(hasFormFields([])).toBe(false);
  });

  it("有必填参数 → true（进表单）", () => {
    expect(hasFormFields([mk({ required: true })])).toBe(true);
  });

  it("必填且带默认值 → false（直接运行，如 adb-debug-activity）", () => {
    expect(hasFormFields([mk({ required: true, default: "/sdcard/" })])).toBe(false);
  });

  it("必填但默认值为空白 → true（进表单，有必须手填的内容）", () => {
    expect(hasFormFields([mk({ required: true, default: "" })])).toBe(true);
    expect(hasFormFields([mk({ required: true, default: "  " })])).toBe(true);
  });

  it("仅默认值、无必填 → false（直接运行，如 adb-scrcpy）", () => {
    expect(hasFormFields([mk({ default: "v" })])).toBe(false);
    expect(hasFormFields([mk({ default: "1280" }), mk({ type: "select", default: "h264" })])).toBe(false);
  });

  it("参数全可选且无默认值 → false（直接运行）", () => {
    expect(hasFormFields([mk({ required: false })])).toBe(false);
    expect(hasFormFields([mk({ required: false, default: "" })])).toBe(false);
    expect(
      hasFormFields([mk({ id: "a" }), mk({ id: "b", type: "select", options: ["x"] })]),
    ).toBe(false);
  });

  it("混合：只要有一个必填即 true，否则 false", () => {
    expect(
      hasFormFields([mk({ id: "a", required: true }), mk({ id: "b" })]),
    ).toBe(true);
    expect(hasFormFields([mk({ id: "a" }), mk({ id: "b", default: "d" })])).toBe(false);
  });
});

describe("missingRequired", () => {
  it("返回未填的必填项", () => {
    const params = [mk({ id: "a", required: true }), mk({ id: "b", required: true })];
    expect(missingRequired(params, { a: "1", b: "" }).map((p) => p.id)).toEqual(["b"]);
  });

  it("无必填项时返回空", () => {
    expect(missingRequired([mk({ id: "a" })], {})).toEqual([]);
  });
});
