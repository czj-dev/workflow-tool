import { describe, expect, it } from "vitest";
import { extractVars, expandVars, resolveGlobalConfig } from "./vars";

describe("extractVars", () => {
  it("提取 ${VAR} 名（去重保序），不碰裸 $VAR", () => {
    expect(extractVars("${A} x ${B} ${A} $C ${D}")).toEqual(["A", "B", "D"]);
  });
});

describe("expandVars（单遍数据语义）", () => {
  it("按 vars 替换，未命中保留 ${VAR} 原样", () => {
    expect(expandVars("a=${A} b=${MISSING}", { A: "x" })).toBe("a=x b=${MISSING}");
  });

  it("命中值里的 ${VAR} 不再展开：用户输入是数据", () => {
    // 片段临时填写、AI 任务输入的值是数据不是模板——嵌套引用保持字面
    expect(expandVars("${A}", { A: "${B}", B: "x" })).toBe("${B}");
  });

  it("resolveGlobalConfig 后单遍展开即得终端值", () => {
    const global = {
      USER: "/Users/v",
      DOCS: "${USER}/Documents",
      OUTPUT_DIR: "${DOCS}/docs",
    };
    const vars = resolveGlobalConfig(global);
    expect(expandVars("${OUTPUT_DIR}/shot.png", vars)).toBe(
      "/Users/v/Documents/docs/shot.png",
    );
  });
});

describe("resolveGlobalConfig（config 层嵌套展开）", () => {
  it("引用链解到终值（USER → DOCS → OUTPUT_DIR）", () => {
    const global = {
      USER: "/Users/v",
      DOCS: "${USER}/Documents",
      OUTPUT_DIR: "${DOCS}/docs",
    };
    expect(resolveGlobalConfig(global)).toEqual({
      USER: "/Users/v",
      DOCS: "/Users/v/Documents",
      OUTPUT_DIR: "/Users/v/Documents/docs",
    });
  });

  it("链上的未定义变量保留 ${VAR} 原样", () => {
    expect(resolveGlobalConfig({ OUT: "${MISSING_X}/logs" })).toEqual({
      OUT: "${MISSING_X}/logs",
    });
  });

  it("自引成环：终止并保留符号引用", () => {
    // 外层解析 ${A} → 值 "${A}/x" 入链 [A] → 内层再遇 A 返回原值 "${A}/x"，
    // 内层拼 "/x"、外层再拼 "/x" → 确定值（重点是能终止）。
    expect(resolveGlobalConfig({ A: "${A}/x" })).toEqual({ A: "${A}/x/x/x" });
  });

  it("互引成环（A→B→A）：终止且回到自身符号引用", () => {
    expect(resolveGlobalConfig({ A: "${B}", B: "${A}" })).toEqual({
      A: "${A}",
      B: "${B}",
    });
  });

  it("链深上限：8 键链解到叶子；链满后再遇含引用的键收口保留原样", () => {
    const global: Record<string, string> = { A9: "leaf" };
    for (let i = 8; i >= 1; i--) global[`A${i}`] = `\${A${i + 1}}`;
    expect(resolveGlobalConfig(global).A1).toBe("leaf");
    // A9 再引 A10、A10 的值仍含引用：链上已有 8 键，${A11} 保留字面量
    global.A9 = "${A10}";
    global.A10 = "${A11}";
    global.A11 = "end";
    expect(resolveGlobalConfig(global).A1).toBe("${A11}");
  });
});
