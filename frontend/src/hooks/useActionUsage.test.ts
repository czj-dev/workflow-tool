import { describe, expect, it, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useActionUsage, groupLabel, MISC_KEY, FOOTPRINT_SEGMENTS } from "./useActionUsage";
import type { ActionItem } from "../../bindings/workflow-tool/internal/api/models.js";

// 构造最小 ActionItem（只用到 id）
const mk = (id: string) => ({ id, title: id }) as ActionItem;

beforeEach(() => {
  localStorage.clear();
});

describe("useActionUsage", () => {
  describe("topActions", () => {
    it("无使用记录时按 actions 原顺序返回前 N 个", () => {
      // Arrange
      const actions = [mk("a"), mk("b"), mk("c"), mk("d")];
      const { result } = renderHook(() => useActionUsage());

      // Act
      const top = result.current.topActions(actions, 3);

      // Assert
      expect(top.map((a) => a.id)).toEqual(["a", "b", "c"]);
    });

    it("按使用次数降序排列", () => {
      // Arrange
      const actions = [mk("a"), mk("b"), mk("c")];
      const { result } = renderHook(() => useActionUsage());

      // Act：c 用 3 次、b 用 1 次、a 不用
      act(() => {
        result.current.recordUsage("c");
        result.current.recordUsage("c");
        result.current.recordUsage("c");
        result.current.recordUsage("b");
      });

      // Assert
      expect(result.current.topActions(actions, 3).map((a) => a.id)).toEqual([
        "c",
        "b",
        "a",
      ]);
    });

    it("衰减让长期不用的条目被新用的挤下去", () => {
      // Arrange：a 先积累 3 分
      const actions = [mk("a"), mk("b")];
      const { result } = renderHook(() => useActionUsage());
      act(() => {
        result.current.recordUsage("a");
        result.current.recordUsage("a");
        result.current.recordUsage("a");
      });
      expect(result.current.topActions(actions, 1)[0].id).toBe("a");

      // Act：b 连续用 4 次，每次都对 a 施加 0.95 衰减
      act(() => {
        result.current.recordUsage("b");
        result.current.recordUsage("b");
        result.current.recordUsage("b");
        result.current.recordUsage("b");
      });

      // Assert
      expect(result.current.topActions(actions, 1)[0].id).toBe("b");
    });

    it("默认取 3 个", () => {
      const actions = [mk("a"), mk("b"), mk("c"), mk("d"), mk("e")];
      const { result } = renderHook(() => useActionUsage());
      expect(result.current.topActions(actions)).toHaveLength(3);
    });

    it("actions 少于 N 时返回全部", () => {
      const actions = [mk("a")];
      const { result } = renderHook(() => useActionUsage());
      expect(result.current.topActions(actions, 3)).toHaveLength(1);
    });
  });

  describe("recordUsage 持久化", () => {
    it("写入 localStorage 并在新 hook 实例中可读", () => {
      // Arrange
      const { result: first } = renderHook(() => useActionUsage());

      // Act
      act(() => {
        first.current.recordUsage("persisted");
      });
      const { result: second } = renderHook(() => useActionUsage());

      // Assert
      expect(second.current.getScore("persisted")).toBeGreaterThan(0);
    });

    it("localStorage 内容损坏时降级为空记录，不抛错", () => {
      // Arrange
      localStorage.setItem("action-usage", "{not json");

      // Act
      const { result } = renderHook(() => useActionUsage());

      // Assert
      expect(result.current.getScore("anything")).toBe(0);
    });

    it("忽略非法值（非数字、负数）", () => {
      // Arrange
      localStorage.setItem(
        "action-usage",
        JSON.stringify({ good: 5, bad: "x", negative: -3 }),
      );

      // Act
      const { result } = renderHook(() => useActionUsage());

      // Assert
      expect(result.current.getScore("good")).toBe(5);
      expect(result.current.getScore("bad")).toBe(0);
      expect(result.current.getScore("negative")).toBe(0);
    });
  });

  describe("groupByPrefix", () => {
    it("按 id 第一段前缀分组", () => {
      // Arrange
      const actions = [
        mk("adb-logcat"),
        mk("adb-install"),
        mk("claude-ask"),
      ];
      const { result } = renderHook(() => useActionUsage());

      // Act
      const groups = result.current.groupByPrefix(actions);

      // Assert
      expect(Object.keys(groups).sort()).toEqual(["adb", "claude"]);
      expect(groups.adb.map((a) => a.id)).toEqual(["adb-logcat", "adb-install"]);
      expect(groups.claude.map((a) => a.id)).toEqual(["claude-ask"]);
    });

    it("无连字符的 id 归入 MISC 组", () => {
      // Arrange
      const actions = [mk("standalone"), mk("adb-logcat")];
      const { result } = renderHook(() => useActionUsage());

      // Act
      const groups = result.current.groupByPrefix(actions);

      // Assert
      expect(groups[MISC_KEY].map((a) => a.id)).toEqual(["standalone"]);
      expect(groups.adb.map((a) => a.id)).toEqual(["adb-logcat"]);
    });

    it("以连字符开头的 id 归入 MISC 组", () => {
      const actions = [mk("-weird")];
      const { result } = renderHook(() => useActionUsage());
      expect(result.current.groupByPrefix(actions)[MISC_KEY]).toHaveLength(1);
    });

    it("组内保持 actions 原顺序", () => {
      const actions = [mk("adb-c"), mk("adb-a"), mk("adb-b")];
      const { result } = renderHook(() => useActionUsage());
      expect(result.current.groupByPrefix(actions).adb.map((a) => a.id)).toEqual([
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

  describe("footprintLevel", () => {
    it("从未使用为 0 段", () => {
      const { result } = renderHook(() => useActionUsage());
      expect(result.current.footprintLevel("never")).toBe(0);
    });

    it("使用次数增加时段数单调不减", () => {
      // Arrange
      const { result } = renderHook(() => useActionUsage());
      const levels: number[] = [];

      // Act
      for (let i = 0; i < 8; i++) {
        act(() => {
          result.current.recordUsage("x");
        });
        levels.push(result.current.footprintLevel("x"));
      }

      // Assert
      for (let i = 1; i < levels.length; i++) {
        expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1]);
      }
    });

    it("段数不超过 FOOTPRINT_SEGMENTS", () => {
      // Arrange
      localStorage.setItem("action-usage", JSON.stringify({ heavy: 100000 }));

      // Act
      const { result } = renderHook(() => useActionUsage());

      // Assert
      expect(result.current.footprintLevel("heavy")).toBe(FOOTPRINT_SEGMENTS);
    });
  });

  describe("storageKey 隔离与泛型", () => {
    it("不同 storageKey 的计数互不干扰(workflow 复用算法但数据隔离)", () => {
      const { result: actionUsage } = renderHook(() =>
        useActionUsage("action-usage"),
      );
      const { result: wfUsage } = renderHook(() =>
        useActionUsage("workflow-usage"),
      );

      act(() => {
        actionUsage.current.recordUsage("shared-id");
      });

      expect(actionUsage.current.getScore("shared-id")).toBeGreaterThan(0);
      expect(wfUsage.current.getScore("shared-id")).toBe(0);
    });

    it("topActions / groupByPrefix 接受任意 { id } 形状(workflow 复用)", () => {
      const { result } = renderHook(() => useActionUsage("workflow-usage"));
      const wfs = [
        { id: "demo-x", title: "t" },
        { id: "adb-y", title: "t" },
      ] as { id: string; title: string }[];

      expect(result.current.topActions(wfs, 2).map((w) => w.id)).toEqual([
        "demo-x",
        "adb-y",
      ]);
      expect(Object.keys(result.current.groupByPrefix(wfs)).sort()).toEqual([
        "adb",
        "demo",
      ]);
    });

    it("默认 storageKey 仍为 action-usage(向后兼容)", () => {
      localStorage.setItem("action-usage", JSON.stringify({ legacy: 3 }));
      const { result } = renderHook(() => useActionUsage());
      expect(result.current.getScore("legacy")).toBe(3);
    });

    it("持久化层按 storageKey 隔离:一个 key 的记录在另一个 key 的新实例中读不到", () => {
      // 实例1 用 action-usage 记录后卸载(强制下次重读 storage)
      const { result: a, unmount: unmountA } = renderHook(() =>
        useActionUsage("action-usage"),
      );
      act(() => {
        a.current.recordUsage("shared-id");
      });
      unmountA();

      // 实例2 用 workflow-usage 重新 mount(从 storage 读)
      const { result: w } = renderHook(() =>
        useActionUsage("workflow-usage"),
      );
      expect(w.current.getScore("shared-id")).toBe(0);

      // 实例3 用 action-usage 重新 mount,应读到(验证持久化确实生效,非空跑)
      const { result: a2 } = renderHook(() =>
        useActionUsage("action-usage"),
      );
      expect(a2.current.getScore("shared-id")).toBeGreaterThan(0);
    });
  });
});
