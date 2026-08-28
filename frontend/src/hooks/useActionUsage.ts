import { useContext } from "react";
import { RunnerContext } from "../context/ActionRunnerProvider";
import { footprintOf, groupByPrefix, topItems, type Bucket } from "../lib/usage";

// 算法与常量都在 lib/usage：此处转出，调用点无需知道拆分。
export { FOOTPRINT_SEGMENTS, MISC_KEY, groupLabel } from "../lib/usage";

// 使用频次读取层：分数由 ActionRunnerProvider 单点持有（写入在 runAction / runWorkflow），
// 本 hook 只按桶取那一份 state 并绑定纯算法——多个组件同时读到的必然是同一份，
// 不再是各自一份 localStorage 缓存副本（旧实现里侧栏排序要重挂载才刷新）。
export function useActionUsage(bucket: Bucket = "action-usage") {
  const usage = useContext(RunnerContext)?.usage[bucket] ?? {};

  return {
    getScore: (id: string) => usage[id] ?? 0,
    topActions: <T extends { id: string }>(items: T[], n?: number) =>
      topItems(items, usage, n),
    footprintLevel: (id: string) => footprintOf(usage, id),
    groupByPrefix,
  };
}
