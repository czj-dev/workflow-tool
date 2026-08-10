// 后端 emit 的 output 事件 payload
// workflow 的 output 事件复用同一结构，但 stream 额外允许协议帧 step-start/step-done
export interface OutputEventData {
  stream:
    | "stdout"
    | "stderr"
    | "llm"
    | "llm-thinking"
    | "logcat"
    | "step-start"
    | "step-done"
    | "step-skip"
    | "progress";
  line: string;
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

// 后端 emit 的 done 事件 payload
export interface DoneEventData {
  exitCode: number;
  err: string;
  duration: string;
}

// workflow 单个步骤的运行状态（前端根据协议帧维护）
export interface WorkflowStepState {
  index: number;
  status: "pending" | "running" | "done" | "error" | "skipped";
  exitCode?: number;
  lines: string[];
}
