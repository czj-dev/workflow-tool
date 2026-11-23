import { describe, expect, it } from "vitest";
import { fmtDuration, fmtGoDuration, parseGoDurationMs } from "./duration";

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
  it("非法输入兑底 0s", () => {
    expect(fmtDuration(NaN)).toBe("0s");
    expect(fmtDuration(-5)).toBe("0s");
    expect(fmtDuration(Infinity)).toBe("0s");
  });
});

describe("parseGoDurationMs / fmtGoDuration", () => {
  it("解析 Go Duration.String() 各单位与复合串", () => {
    expect(parseGoDurationMs("0s")).toBe(0);
    expect(parseGoDurationMs("4s")).toBe(4000);
    expect(parseGoDurationMs("495.555291ms")).toBeCloseTo(495.555291, 6);
    expect(parseGoDurationMs("1m2s")).toBe(62_000);
    expect(parseGoDurationMs("2h45m")).toBe(9_900_000);
    expect(parseGoDurationMs("1.5h")).toBe(5_400_000);
    expect(parseGoDurationMs("150\u00b5s")).toBeCloseTo(0.15, 9);
  });
  it("非 Go 时长串返回 null，fmtGoDuration 原样透传", () => {
    expect(parseGoDurationMs("")).toBeNull();
    expect(parseGoDurationMs("soon")).toBeNull();
    expect(parseGoDurationMs("12")).toBeNull();
    expect(parseGoDurationMs("1s2")).toBeNull();
    expect(fmtGoDuration("soon")).toBe("soon");
  });
  it("全精度 ms 归一到统一读数格式", () => {
    expect(fmtGoDuration("495.555291ms")).toBe("0.5s");
    expect(fmtGoDuration("430ms")).toBe("0.4s");
    expect(fmtGoDuration("4s")).toBe("4s");
    expect(fmtGoDuration("1m2.5s")).toBe("1m02s");
  });
});
