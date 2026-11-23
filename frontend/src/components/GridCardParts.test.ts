import { describe, expect, it, vi } from "vitest";

// GridCardParts 传递依赖 ActionRunnerProvider → bindings service.js → @wailsio/runtime；
// 单测只关心纯函数，mock 掉 runtime 即可加载（Create 供 bindings 模型层 $Create.Nullable 使用）。
vi.mock("@wailsio/runtime", () => ({
  Events: { On: () => () => {} },
  // Create 的包装器（Any/Array/Map/Nullable/Events）统一恒等返回：单测不经过序列化路径
  Create: {
    Any: (f: unknown) => f,
    Array: (f: unknown) => f,
    Map: (f: unknown) => f,
    Nullable: (f: unknown) => f,
    Events: (f: unknown) => f,
  },
}));

import { ambColorFor, ambFor } from "./GridCardParts";

describe("ambColorFor", () => {
  it("四色名映射到 --amb-* token", () => {
    expect(ambColorFor("amber")).toBe("var(--amb-amber)");
    expect(ambColorFor("green")).toBe("var(--amb-green)");
    expect(ambColorFor("blue")).toBe("var(--amb-blue)");
    expect(ambColorFor("violet")).toBe("var(--amb-violet)");
  });

  it("未写 / 空串 / 未知名返回 null（调用方回落组序循环）", () => {
    expect(ambColorFor(undefined)).toBeNull();
    expect(ambColorFor("")).toBeNull();
    expect(ambColorFor("red")).toBeNull();
  });
});

describe("ambFor", () => {
  it("按组序循环四色，负数索引安全回绕", () => {
    expect(ambFor(0)).toBe("var(--amb-amber)");
    expect(ambFor(1)).toBe("var(--amb-green)");
    expect(ambFor(4)).toBe("var(--amb-amber)"); // 循环
    expect(ambFor(-1)).toBe("var(--amb-violet)"); // 回绕
  });
});
