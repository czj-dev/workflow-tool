// 后端 emit 的 output 事件 payload
export interface OutputEventData {
  stream: "stdout" | "stderr" | "llm" | "llm-thinking";
  line: string;
}

// 后端 emit 的 done 事件 payload
export interface DoneEventData {
  exitCode: number;
  err: string;
  duration: string;
}
