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
    | "step-start"
    | "step-done"
    | "step-skip"
    | "progress";
  line: string;
  // workflow output 事件专有：该行归属的 step 索引（后端下发，见 api.executeWorkflow）。
  // 有它就按索引落桶，规避 Wails 事件乱序把 100% 折进下一个 step。action 事件无此字段。
  step?: string;
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

// 前端 logcat 视图运行时过滤（对已缓冲条目再过滤，不影响服务端预过滤）。
export interface LogcatFilter {
  minLevel: string; // V/D/I/W/E/F，默认 V（=不过滤等级）
  search: string; // message 子串
  tag: string; // tag 子串
}

// LLM 会话终点读数（done 事件附带，LLM 动作专有；后端 api.llmReadout 构造）
export interface LlmReadoutData {
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

// 后端 emit 的 done 事件 payload
export interface DoneEventData {
  exitCode: number;
  err: string;
  duration: string;
  readout?: LlmReadoutData;
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
