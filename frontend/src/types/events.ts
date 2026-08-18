// 后端 emit 的 output 事件 payload
// workflow 的 output 事件复用同一结构，但 stream 额外允许协议帧 step-start/step-done
export interface OutputEventData {
  stream:
    | "stdout"
    | "stderr"
    | "llm"
    | "llm-thinking"
    | "llm-tool"
    | "logcat"
    | "logcat-replace"
    | "step-start"
    | "step-done"
    | "step-skip"
    | "progress";
  line: string;
  // workflow output 事件专有：该行归属的 step 索引（后端下发，见 api.executeWorkflow）。
  // 有它就按索引落桶，规避 Wails 事件乱序把 100% 折进下一个 step。action 事件无此字段。
  step?: string;
  // action output 事件专有：后端 emit 时的自增序号（见 api.execute）。Wails Event.Emit
  // 每次都各起一个 goroutine 投递，到达前端的顺序无保证；用 seq 在应用前重排还原真实产出顺序。
  seq?: number;
}

// stream="logcat" 的 line 是一段紧凑 JSON，对应后端 logcatPayload。
export interface LogcatEntry {
  date: string; // "08-08"；未解析行为 ""
  time: string; // "11:22:33.456"；未解析行为 ""
  pid: number;
  tid: number;
  level: string; // V/D/I/W/E/F
  tag: string;
  message: string;
}

// ——— 统一过滤规则（与 Go internal/adb/logcat/rule.go 逐字段对齐，json tag 即协议） ———
// 后端是唯一求值器：前端只编辑/下发规则，不再自带过滤逻辑（spec 2026-08-18）。

export type LogcatKey = "tag" | "message" | "pid" | "tid" | "any";
export type LogcatOp = "contains" | "exact" | "regex";

export interface LogcatToken {
  key: LogcatKey;
  op: LogcatOp;
  negated: boolean;
  value: string;
  // 前端 UI 专有：输入框未固化尾巴（草稿态）。下发后端时携带无害（后端不看此字段）。
  draft?: boolean;
}

export interface LogcatRule {
  tokens: LogcatToken[];
  minLevel: string; // V/D/I/W/E/F 阈值，下拉唯一入口；空 = V
  package: string; // 包名；空 = 全量进程（只读 chip，preset 带入 / × 移除）
}

export const EMPTY_LOGCAT_RULE: LogcatRule = { tokens: [], minLevel: "V", package: "" };

// stream="logcat-replace" 的 line 是一段 JSON（对应后端 replaceFrame）。
// 规则变更/清空后后端重筛 raw ring 整体重发：head=true 为首帧，收到即清空本地缓冲
// 整体替换，并读取 matched/total 与 tag 直方图；后续 chunk 只追加 entries。
export interface LogcatReplaceFrame {
  head: boolean;
  entries: LogcatEntry[];
  matched?: number;
  total?: number;
  tagHistogram?: Record<string, number>;
}

// LLM 会话终点读数（done 事件附带，LLM 动作专有；后端 api.llmReadout 构造）
export interface LlmReadoutData {
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  // claude 会话 id（stream-json 的 session_id）：历史查看态顶部展示，可用于 --resume
  sessionId?: string;
}

// 后端 emit 的 done 事件 payload
export interface DoneEventData {
  exitCode: number;
  err: string;
  duration: string;
  readout?: LlmReadoutData;
  // action done 事件专有：延续 output 事件的 seq 序号空间（见 api.emitDoneSeq）。
  // done 事件同样各起独立 goroutine 投递，可能抢跑在还没到达的 output 行前面；
  // 用它接入 outputFold 的重排队列，确保退出码行落在所有 output 行之后。
  seq?: number;
}

// workflow 单个步骤的运行状态（前端根据协议帧维护）
export interface WorkflowStepState {
  index: number;
  status: "pending" | "running" | "done" | "error" | "skipped";
  exitCode?: number;
  lines: string[];
  // 上一行是否是 progress——决定下一条 progress 覆盖还是追加（同 action 的 lines 语义）
  lastWasProgress?: boolean;
}
