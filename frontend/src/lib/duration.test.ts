import { describe, expect, it } from "vitest";
import { fmtDuration } from "./duration";

describe("fmtDuration", () => {
  it("亚秒保留一位小数", () => {
    expect(fmtDuration(430)).toBe("0.4s");
    expect(fmtDuration(12_430)).toBe("12.4s");
  });
  it("整秒不带小数尾巴", () => {
    expect(fmtDuration(0)).toBe("0s");
    expect(fmtDuration(12_000)).toBe("12s");
    expect(fmtDuration(59_000)).toBe("59s");
  });
  it("超过一分钟走 1m02s，秒补零", () => {
    expect(fmtDuration(60_000)).toBe("1m00s");
    expect(fmtDuration(72_300)).toBe("1m12s");
    expect(fmtDuration(3_615_000)).toBe("60m15s");
  });
  it("非法输入兜底 0s", () => {
    expect(fmtDuration(NaN)).toBe("0s");
    expect(fmtDuration(-5)).toBe("0s");
    expect(fmtDuration(Infinity)).toBe("0s");
  });
});
