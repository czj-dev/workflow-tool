import { describe, expect, it, vi } from "vitest";
import { ringGeometry, ringHit } from "./actionRingGeometry";

const geometry = { x: 200, y: 200, inner: 65, outer: 150, count: 4 };

describe("ringHit", () => {
  it("按顺时针依次命中四个扇区", () => {
    expect(ringHit(geometry, 200, 100)).toBe(0);
    expect(ringHit(geometry, 300, 200)).toBe(1);
    expect(ringHit(geometry, 200, 300)).toBe(2);
    expect(ringHit(geometry, 100, 200)).toBe(3);
  });

  it("中心、外部与扇区间隙都不命中", () => {
    expect(ringHit(geometry, 200, 200)).toBe(-1);
    expect(ringHit(geometry, 200, 40)).toBe(-1);
    expect(ringHit(geometry, 200 + 100 / Math.SQRT2, 200 - 100 / Math.SQRT2)).toBe(-1);
  });

  it("高亮扇区位移后仍按位移后的几何命中", () => {
    expect(ringHit(geometry, 200, 43, 0)).toBe(-1);
    expect(ringHit(geometry, 200, 46)).toBe(-1);
    expect(ringHit(geometry, 200, 46, 0)).toBe(0);
  });

  it("单个预设有完整的圆环命中范围", () => {
    expect(ringHit({ ...geometry, count: 1 }, 200, 300)).toBe(0);
  });
});

describe("ringGeometry", () => {
  it("限制圆环在视口内且保持卡片中心", () => {
    vi.stubGlobal("innerWidth", 320);
    vi.stubGlobal("innerHeight", 480);
    const actual = ringGeometry({ left: 8, top: 100, width: 130, height: 130 } as DOMRect, 3);
    expect(actual.x).toBe(73);
    expect(actual.y).toBe(165);
    expect(actual.outer).toBe(65);
    expect(actual.inner).toBeLessThan(actual.outer);
    expect(ringGeometry({ left: -60, top: 0, width: 130, height: 130 } as DOMRect, 1).outer).toBe(0);
    vi.unstubAllGlobals();
  });
});
