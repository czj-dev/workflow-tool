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
  it("锚定 hub 中心：内孔半径 = 卡高一半，外径钳制在视口内", () => {
    vi.stubGlobal("innerWidth", 320);
    vi.stubGlobal("innerHeight", 480);
    const hub = { left: 180, top: 100, width: 40, height: 40 } as DOMRect;
    const actual = ringGeometry(hub, 3, 72);
    expect(actual.x).toBe(200);
    expect(actual.y).toBe(120);
    expect(actual.inner).toBe(36);
    // min(178, inner+78=114, x-10=190, 320-x-10=110, y-10=110, 480-y-10=350)
    expect(actual.outer).toBe(110);
    // hub 贴到视口边缘外：外径被 x-10 钳到 0
    expect(ringGeometry({ left: -20, top: 100, width: 40, height: 40 } as DOMRect, 1, 72).outer).toBe(0);
    vi.unstubAllGlobals();
  });

  it("卡高异常时内孔半径被钳制在 [28, 64]", () => {
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("innerHeight", 800);
    const hub = { left: 400, top: 300, width: 40, height: 40 } as DOMRect;
    expect(ringGeometry(hub, 2, 40).inner).toBe(28);
    expect(ringGeometry(hub, 2, 200).inner).toBe(64);
    vi.unstubAllGlobals();
  });
});
