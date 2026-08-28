// 使用频次算法与持久化（纯函数，无 React）。state 归 ActionRunnerProvider 唯一持有，
// 本模块只负责「怎么算」与「怎么落盘」——故可被 Provider 与 hook 同时依赖而不成环。

// 每次记录时对全体历史分数衰减：最近用的自然领先，长期不用的自然沉底。
// 无时间戳——排序效果对 UI 足够，省掉状态迁移成本。
const DECAY_FACTOR = 0.95;
// 分数低于此值视为噪声，直接从存储剔除，避免无限累积长尾键
const PRUNE_THRESHOLD = 0.01;
const DEFAULT_TOP_N = 3;
// 足迹条段数（Grid 卡片右上）
export const FOOTPRINT_SEGMENTS = 5;

// 三个桶共享算法、数据隔离：localStorage key 即桶名。
export const BUCKETS = ["action-usage", "workflow-usage", "llm-usage"] as const;
export type Bucket = (typeof BUCKETS)[number];

export type UsageMap = Record<string, number>;
export type UsageByBucket = Record<Bucket, UsageMap>;

// id 前缀 → 分组显示名。未命中前缀走 capitalize，无分隔符归 MISC_KEY。
const PREFIX_LABELS: Record<string, string> = {
  adb: "ADB",
  claude: "Claude",
  log: "LOG",
};
export const MISC_KEY = "__misc__";

export function readUsage(key: string): UsageMap {
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

export function writeUsage(key: string, map: UsageMap): void {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    // localStorage 写失败（隐私模式/配额）不该打断运行，退化为纯内存计数
  }
}

// 衰减全体 + 目标 +1，返回新 map（不可变）
export function decayAndBump(prev: UsageMap, id: string): UsageMap {
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

// 按分数降序取前 n；分数相同（含全为 0 的首次启动）保持原顺序。
// 泛型 <T extends { id: string }>：action / workflow / llm 三类复用同一排序。
export function topItems<T extends { id: string }>(
  items: T[],
  usage: UsageMap,
  n: number = DEFAULT_TOP_N,
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const diff = (usage[b.item.id] ?? 0) - (usage[a.item.id] ?? 0);
      return diff !== 0 ? diff : a.index - b.index;
    })
    .slice(0, n)
    .map(({ item }) => item);
}

// 按 id 第一段前缀分组；无 "-" 分隔符的归 MISC_KEY。组内保持原顺序。
export function groupByPrefix<T extends { id: string }>(
  items: T[],
): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const dash = item.id.indexOf("-");
    const key = dash > 0 ? item.id.slice(0, dash) : MISC_KEY;
    (groups[key] ??= []).push(item);
  }
  return groups;
}

// 足迹条亮段数：log2 缩放——次数从 1 涨到 31 才铺满 5 段，避免高频项瞬间打满
export function footprintOf(usage: UsageMap, id: string): number {
  return Math.min(
    FOOTPRINT_SEGMENTS,
    Math.ceil(Math.log2((usage[id] ?? 0) + 1)),
  );
}
