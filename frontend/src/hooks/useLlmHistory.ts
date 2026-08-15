// frontend/src/hooks/useLlmHistory.ts
import { useCallback, useEffect, useState } from "react";

// 工具调用段快照（聊天页工序轨道回放用；字段对应 reduceStream.ToolSegment）
export interface LlmHistoryTool {
  id: string;
  name: string;
  summary: string;
  result?: string;
  isError?: boolean;
  durationMs?: number;
}

export interface LlmHistoryEntry {
  id: string;
  timestamp: number;
  prompt: string;
  params: Record<string, string>;
  response: string;
  thinking: string;
  // 旧条目无此字段（undefined 兜底）
  tools?: LlmHistoryTool[];
  exitCode: number;
  duration: string;
}

export const LLM_HISTORY_MAX = 50;
export const RESPONSE_CAP = 10_000;
export const THINKING_CAP = 5_000;
export const TOOL_RESULT_CAP = 2_000;
const TRUNC_SUFFIX = "…（已截断）";

const keyFor = (actionId: string) => `llm-history:${actionId}`;

function cap(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + TRUNC_SUFFIX;
}

function read(actionId: string): LlmHistoryEntry[] {
  try {
    const raw = localStorage.getItem(keyFor(actionId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 外部数据不可信：只保留形状正确的项
    return parsed.filter(
      (e): e is LlmHistoryEntry =>
        !!e && typeof e === "object" && typeof (e as LlmHistoryEntry).id === "string",
    );
  } catch {
    return [];
  }
}

function write(actionId: string, entries: LlmHistoryEntry[]): void {
  try {
    localStorage.setItem(keyFor(actionId), JSON.stringify(entries));
  } catch {
    // 隐私模式/配额写失败：静默降级，历史仅存于内存本次会话
  }
}

// 按 actionId 分桶的 LLM 运行历史。倒序（最新在前），封顶 LLM_HISTORY_MAX 条。
export function useLlmHistory(actionId: string | null) {
  const [entries, setEntries] = useState<LlmHistoryEntry[]>([]);

  useEffect(() => {
    setEntries(actionId ? read(actionId) : []);
  }, [actionId]);

  const append = useCallback(
    (entry: Omit<LlmHistoryEntry, "id" | "timestamp">) => {
      if (!actionId) return;
      const full: LlmHistoryEntry = {
        ...entry,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        response: cap(entry.response, RESPONSE_CAP),
        thinking: cap(entry.thinking, THINKING_CAP),
        tools: entry.tools?.map((t) => ({ ...t, result: t.result ? cap(t.result, TOOL_RESULT_CAP) : undefined })),
      };
      setEntries((prev) => {
        const next = [full, ...prev].slice(0, LLM_HISTORY_MAX);
        write(actionId, next);
        return next;
      });
    },
    [actionId],
  );

  const clear = useCallback(() => {
    if (!actionId) return;
    setEntries([]);
    write(actionId, []);
  }, [actionId]);

  return { entries, append, clear };
}
