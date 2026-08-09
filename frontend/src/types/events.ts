// 后端 emit 的 output 事件 payload
// workflow 的 output 事件复用同一结构，但 stream 额外允许协议帧 step-start/step-done
export interface OutputEventData {
  stream:
    | "stdout"
    | "stderr"
    | "llm"
    | "llm-thinking"
    | "step-start"
    | "step-done"
    | "step-skip"
    | "progress";
  line: string;
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
