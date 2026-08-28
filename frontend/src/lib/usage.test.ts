import { describe, expect, it, beforeEach } from "vitest";
import {
  BUCKETS,
  FOOTPRINT_SEGMENTS,
  MISC_KEY,
  decayAndBump,
  footprintOf,
  groupByPrefix,
  groupLabel,
  readUsage,
  topItems,
  writeUsage,
  type UsageMap,
} from "./usage";

// 构造最小形状（算法只要求 { id }）
const mk = (id: string) => ({ id, title: id });

// 连续记录 n 次的分数表（等价旧测试里的 recordUsage(id) × n）
const bumped = (...ids: string[]): UsageMap =>
  ids.reduce<UsageMap>((map, id) => decayAndBump(map, id), {});

beforeEach(() => {
  localStorage.clear();
});

describe("topItems", () => {
  it("无使用记录时按原顺序返回前 N 个", () => {
    // Arrange
    const items = [mk("a"), mk("b"), mk("c"), mk("d")];

    // Act
    const top = topItems(items, {}, 3);

    // Assert
    expect(top.map((a) => a.id)).toEqual(["a", "b", "c"]);
  });

  it("按使用次数降序排列", () => {
    // Arrange
    const items = [mk("a"), mk("b"), mk("c")];

    // Act：c 用 3 次、b 用 1 次、a 不用
    const usage = bumped("c", "c", "c", "b");

    // Assert
    expect(topItems(items, usage, 3).map((a) => a.id)).toEqual(["c", "b", "a"]);
  });

  it("衰减让长期不用的条目被新用的挤下去", () => {
    // Arrange：a 先积累 3 分
    const items = [mk("a"), mk("b")];
    const warm = bumped("a", "a", "a");
    expect(topItems(items, warm, 1)[0].id).toBe("a");

    // Act：b 连续用 4 次，每次都对 a 施加 0.95 衰减
    const usage = ["b", "b", "b", "b"].reduce(
      (map, id) => decayAndBump(map, id),
      warm,
    );

    // Assert
    expect(topItems(items, usage, 1)[0].id).toBe("b");
  });

  it("默认取 3 个", () => {
    const items = [mk("a"), mk("b"), mk("c"), mk("d"), mk("e")];
    expect(topItems(items, {})).toHaveLength(3);
  });

  it("items 少于 N 时返回全部", () => {
    expect(topItems([mk("a")], {}, 3)).toHaveLength(1);
  });

  it("接受任意 { id } 形状（action / workflow / llm 复用同一排序）", () => {
    const wfs = [
      { id: "demo-x", title: "t" },
      { id: "adb-y", title: "t" },
    ];
    expect(topItems(wfs, {}, 2).map((w) => w.id)).toEqual(["demo-x", "adb-y"]);
  });
});

describe("readUsage / writeUsage 持久化", () => {
  it("写入 localStorage 后可读回", () => {
    // Act
    writeUsage("action-usage", bumped("persisted"));

    // Assert
    expect(readUsage("action-usage").persisted).toBeGreaterThan(0);
  });

  it("localStorage 内容损坏时降级为空记录，不抛错", () => {
    // Arrange
    localStorage.setItem("action-usage", "{not json");

    // Act & Assert
    expect(readUsage("action-usage")).toEqual({});
  });

  it("忽略非法值（非数字、负数）", () => {
    // Arrange
    localStorage.setItem(
      "action-usage",
      JSON.stringify({ good: 5, bad: "x", negative: -3 }),
    );

    // Act
    const usage = readUsage("action-usage");

    // Assert
    expect(usage.good).toBe(5);
    expect(usage.bad).toBeUndefined();
    expect(usage.negative).toBeUndefined();
  });

  it("数组 / null 等非对象 JSON 同样降级为空", () => {
    localStorage.setItem("action-usage", JSON.stringify([1, 2]));
    expect(readUsage("action-usage")).toEqual({});
    localStorage.setItem("action-usage", "null");
    expect(readUsage("action-usage")).toEqual({});
  });

  it("按 key 隔离：一个桶的记录在另一个桶里读不到", () => {
    // Act
    writeUsage("action-usage", bumped("shared-id"));

    // Assert
    expect(readUsage("action-usage")["shared-id"]).toBeGreaterThan(0);
    expect(readUsage("workflow-usage")["shared-id"]).toBeUndefined();
  });

  it("桶名固定为三个（key 不变，已有数据零迁移）", () => {
    expect([...BUCKETS]).toEqual([
      "action-usage",
      "workflow-usage",
      "llm-usage",
    ]);
  });
});

describe("decayAndBump", () => {
  it("返回新 map，不修改入参", () => {
    // Arrange
    const prev = bumped("a");

    // Act
    const next = decayAndBump(prev, "b");

    // Assert
    expect(prev).toEqual({ a: 1 });
    expect(next).not.toBe(prev);
    expect(next.a).toBeLessThan(1);
    expect(next.b).toBe(1);
  });

  it("分数衰减到噪声阈值以下即剔除，长尾键不无限累积", () => {
    // Arrange：a 记一次后被其他 id 反复挤压
    let usage = bumped("a");

    // Act：0.95^n ≤ 0.01 需约 90 次
    for (let i = 0; i < 100; i++) usage = decayAndBump(usage, `other-${i}`);

    // Assert
    expect(usage.a).toBeUndefined();
  });
});

describe("groupByPrefix", () => {
  it("按 id 第一段前缀分组", () => {
    // Arrange
    const items = [mk("adb-logcat"), mk("adb-install"), mk("claude-ask")];

    // Act
    const groups = groupByPrefix(items);

    // Assert
    expect(Object.keys(groups).sort()).toEqual(["adb", "claude"]);
    expect(groups.adb.map((a) => a.id)).toEqual(["adb-logcat", "adb-install"]);
    expect(groups.claude.map((a) => a.id)).toEqual(["claude-ask"]);
  });

  it("无连字符的 id 归入 MISC 组", () => {
    const groups = groupByPrefix([mk("standalone"), mk("adb-logcat")]);
    expect(groups[MISC_KEY].map((a) => a.id)).toEqual(["standalone"]);
    expect(groups.adb.map((a) => a.id)).toEqual(["adb-logcat"]);
  });

  it("以连字符开头的 id 归入 MISC 组", () => {
    expect(groupByPrefix([mk("-weird")])[MISC_KEY]).toHaveLength(1);
  });

  it("组内保持原顺序", () => {
    const items = [mk("adb-c"), mk("adb-a"), mk("adb-b")];
    expect(groupByPrefix(items).adb.map((a) => a.id)).toEqual([
      "adb-c",
      "adb-a",
      "adb-b",
    ]);
  });
});

describe("groupLabel", () => {
  it("已注册前缀返回规范显示名", () => {
    expect(groupLabel("adb")).toBe("ADB");
    expect(groupLabel("claude")).toBe("Claude");
  });

  it("未注册前缀首字母大写", () => {
    expect(groupLabel("docker")).toBe("Docker");
  });

  it("MISC_KEY 原样返回，由调用方走 i18n", () => {
    expect(groupLabel(MISC_KEY)).toBe(MISC_KEY);
  });
});

describe("footprintOf", () => {
  it("从未使用为 0 段", () => {
    expect(footprintOf({}, "never")).toBe(0);
  });

  it("使用次数增加时段数单调不减", () => {
    // Arrange
    let usage: UsageMap = {};
    const levels: number[] = [];

    // Act
    for (let i = 0; i < 8; i++) {
      usage = decayAndBump(usage, "x");
      levels.push(footprintOf(usage, "x"));
    }

    // Assert
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1]);
    }
  });

  it("段数不超过 FOOTPRINT_SEGMENTS", () => {
    expect(footprintOf({ heavy: 100000 }, "heavy")).toBe(FOOTPRINT_SEGMENTS);
  });
});
