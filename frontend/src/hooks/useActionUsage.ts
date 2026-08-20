import { useCallback, useState } from "react";
// topActions/groupByPrefix 泛型化后不再依赖 ActionItem 形状，只要求 { id: string }

// 每次记录时对全体历史分数衰减：最近用的自然领先，长期不用的自然沉底。
// 无时间戳——排序效果对 UI 足够，省掉状态迁移成本。
const DECAY_FACTOR = 0.95;
// 分数低于此值视为噪声，直接从存储剔除，避免无限累积长尾键
const PRUNE_THRESHOLD = 0.01;
const DEFAULT_TOP_N = 3;
// 足迹条段数（ActionsGridView 卡片右上）
export const FOOTPRINT_SEGMENTS = 5;

// id 前缀 → 分组显示名。未命中前缀走 capitalize，无分隔符归 MISC_KEY。
const PREFIX_LABELS: Record<string, string> = {
  adb: "ADB",
  claude: "Claude",
  log: "LOG",
};
export const MISC_KEY = "__misc__";

type UsageMap = Record<string, number>;

function readUsage(key: string): UsageMap {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // 只保留数值项：外部数据不可信，非法值静默丢弃而非污染排序
    const clean: UsageMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) clean[k] = v;
    }
    return clean;
  } catch {
    return {};
  }
}

function writeUsage(key: string, map: UsageMap): void {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    // localStorage 写失败（隐私模式/配额）不该打断运行，退化为纯内存计数
  }
}

// 衰减全体 + 目标 +1，返回新 map（不可变）
function decayAndBump(prev: UsageMap, id: string): UsageMap {
  const next: UsageMap = {};
  for (const [k, v] of Object.entries(prev)) {
    const decayed = v * DECAY_FACTOR;
    if (decayed >= PRUNE_THRESHOLD) next[k] = decayed;
  }
  next[id] = (next[id] ?? 0) + 1;
  return next;
}

// 分组 key → 显示名。导出供视图渲染分组标题（MISC_KEY 由调用方走 i18n）。
export function groupLabel(key: string): string {
  if (key === MISC_KEY) return key;
  return PREFIX_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

// 使用频次：默认 action-usage；workflow 复用本 hook 时传 "workflow-usage" 实现数据隔离。
// 算法（衰减/分组/足迹）完全共享，仅 storageKey 不同。
export function useActionUsage(storageKey = "action-usage") {
  const [usage, setUsage] = useState<UsageMap>(() => readUsage(storageKey));

  const recordUsage = useCallback((id: string) => {
    setUsage((prev) => {
      const next = decayAndBump(prev, id);
      writeUsage(storageKey, next);
      return next;
    });
  }, [storageKey]);

  const getScore = useCallback((id: string) => usage[id] ?? 0, [usage]);

  // 按分数降序取前 n；分数相同（含全为 0 的首次启动）保持原顺序。
  // 泛型 <T extends { id: string }>：action 与 workflow 复用同一排序。
  const topActions = useCallback(
    <T extends { id: string }>(items: T[], n: number = DEFAULT_TOP_N) =>
      items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
          const diff = (usage[b.item.id] ?? 0) - (usage[a.item.id] ?? 0);
          return diff !== 0 ? diff : a.index - b.index;
        })
        .slice(0, n)
        .map(({ item }) => item),
    [usage],
  );

  // 按 id 第一段前缀分组；无 "-" 分隔符的归 MISC_KEY。组内保持原顺序。
  const groupByPrefix = useCallback(<T extends { id: string }>(items: T[]) => {
    const groups: Record<string, T[]> = {};
    for (const item of items) {
      const dash = item.id.indexOf("-");
      const key = dash > 0 ? item.id.slice(0, dash) : MISC_KEY;
      (groups[key] ??= []).push(item);
    }
    return groups;
  }, []);

  // 足迹条亮段数：log2 缩放——次数从 1 涨到 31 才铺满 5 段，避免高频项瞬间打满
  const footprintLevel = useCallback(
    (id: string) =>
      Math.min(
        FOOTPRINT_SEGMENTS,
        Math.ceil(Math.log2((usage[id] ?? 0) + 1)),
      ),
    [usage],
  );

  return { recordUsage, getScore, topActions, groupByPrefix, footprintLevel };
}
