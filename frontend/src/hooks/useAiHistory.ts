// frontend/src/hooks/useAiHistory.ts
import { useCallback, useSyncExternalStore } from "react";

// 工具调用段快照（聊天页工序轨道回放用；字段对应 reduceStream.ToolSegment）
export interface AiHistoryTool {
  id: string;
  name: string;
  summary: string;
  result?: string;
  isError?: boolean;
  durationMs?: number;
}

export interface AiHistoryEntry {
  id: string;
  timestamp: number;
  prompt: string;
  params: Record<string, string>;
  response: string;
  thinking: string;
  // 旧条目无此字段（undefined 兜底）
  tools?: AiHistoryTool[];
  // claude 会话 id（done 事件 readout 附带）；旧条目无此字段
  sessionId?: string;
  exitCode: number;
  duration: string;
}

export type AiHistoryInput = Omit<AiHistoryEntry, "id" | "timestamp">;

export const AI_HISTORY_MAX = 50;
export const RESPONSE_CAP = 10_000;
export const THINKING_CAP = 5_000;
export const TOOL_RESULT_CAP = 2_000;
const TRUNC_SUFFIX = "…（已截断）";

const keyFor = (taskId: string) => `ai-history:${taskId}`;

function cap(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + TRUNC_SUFFIX;
}

// 按任务分桶的运行历史：模块级单例，同一个任务的全部订阅者（Provider 的 aiHistory、网格
// 卡片的摘要）共享同一份 entries，倒序（最新在前），封顶 AI_HISTORY_MAX 条。
// 写入方是 Provider 的运行收尾——那时任务未必是 currentId（后台运行），所以 append/clear
// 做成不绑 currentId 的模块函数，hook 只负责订阅。
interface Bucket {
  entries: AiHistoryEntry[];
}

const buckets = new Map<string, Bucket>();
const listeners = new Map<string, Set<() => void>>();
const NO_ENTRIES: AiHistoryEntry[] = [];

function read(taskId: string): AiHistoryEntry[] {
  try {
    const raw = localStorage.getItem(keyFor(taskId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 外部数据不可信：只保留形状正确的项
    return parsed.filter(
      (e): e is AiHistoryEntry =>
        !!e && typeof e === "object" && typeof (e as AiHistoryEntry).id === "string",
    );
  } catch {
    return [];
  }
}

function write(taskId: string, entries: AiHistoryEntry[]): void {
  try {
    localStorage.setItem(keyFor(taskId), JSON.stringify(entries));
  } catch {
    // 隐私模式/配额写失败：静默降级，历史仅存于内存本次会话
  }
}

// 惰性建桶：首次访问时从 localStorage 读入，之后以内存为准
function bucketFor(taskId: string): Bucket {
  let bucket = buckets.get(taskId);
  if (!bucket) {
    bucket = { entries: read(taskId) };
    buckets.set(taskId, bucket);
  }
  return bucket;
}

function store(taskId: string, entries: AiHistoryEntry[]): void {
  bucketFor(taskId).entries = entries;
  write(taskId, entries);
  listeners.get(taskId)?.forEach((notify) => notify());
}

/** 追加一条历史（最新在前）并通知该任务的全部订阅者 */
export function appendAiHistory(taskId: string, entry: AiHistoryInput): void {
  const full: AiHistoryEntry = {
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    response: cap(entry.response, RESPONSE_CAP),
    thinking: cap(entry.thinking, THINKING_CAP),
    tools: entry.tools?.map((t) => ({ ...t, result: t.result ? cap(t.result, TOOL_RESULT_CAP) : undefined })),
  };
  store(taskId, [full, ...bucketFor(taskId).entries].slice(0, AI_HISTORY_MAX));
}

/** 清空某任务的历史 */
export function clearAiHistory(taskId: string): void {
  store(taskId, []);
}

// 某个 AI 任务的运行历史。taskId 为 null（当前项不是 AI 任务）时恒为空且写入无操作。
export function useAiHistory(taskId: string | null) {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!taskId) return () => {};
      let set = listeners.get(taskId);
      if (!set) {
        set = new Set();
        listeners.set(taskId, set);
      }
      set.add(notify);
      const mine = set;
      return () => {
        mine.delete(notify);
        if (mine.size === 0) listeners.delete(taskId);
      };
    },
    [taskId],
  );
  const getSnapshot = useCallback(
    () => (taskId ? bucketFor(taskId).entries : NO_ENTRIES),
    [taskId],
  );
  const entries = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const append = useCallback(
    (entry: AiHistoryInput) => {
      if (taskId) appendAiHistory(taskId, entry);
    },
    [taskId],
  );

  const clear = useCallback(() => {
    if (taskId) clearAiHistory(taskId);
  }, [taskId]);

  return { entries, append, clear };
}
