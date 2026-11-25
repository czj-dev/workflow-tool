import type { TreeFrame } from "../lib/treeFrame";
import type { AiPanelState } from "../lib/reduceStream";
import type { Event as GeneratedRunEvent } from "../../bindings/workflow-tool/internal/runstore/models.js";
import type { ScheduleItem } from "../../bindings/workflow-tool/internal/api/models.js";

// 调度卡的「上次到点已跳过」：跳过不是失败，不进 lastRun，单独留档并注明原因。
export interface ScheduleLastSkip {
  at: string;
  reason: string;
  runId?: string;
}

// schedules:changed 下发完整的 ScheduleItem；Provider 收到后刷新列表以保持后端投影为唯一真相。
export type ScheduleStateEventData = ScheduleItem;

// 输出桶的行项：文本/进度行之外，stream="tree" 的协议行进桶后不是字符串而是解析好的
// 树帧（见 lib/treeFrame.ts），OutputLines 按项分派渲染（内联树块）。
export type OutputLineItem =
  | { kind: "text"; text: string }
  | { kind: "progress"; text: string }
  | { kind: "tree"; id: number; frame: TreeFrame };

// 后端 emit 的 output 事件 payload
// workflow 的 output 事件复用同一结构，但 stream 额外允许协议帧 step-start/step-done
export interface OutputEventData {
  stream:
    | "stdout"
    | "stderr"
    | "ai"
    | "ai-thinking"
    | "ai-tool"
    | "logcat"
    | "logcat-replace"
    | "step-start"
    | "step-done"
    | "step-skip"
    | "progress"
    | "tree";
  line: string;
  // workflow output 事件专有：该行归属的 step 索引（后端下发，见 api.executeWorkflow）。
  // 有它就按索引落桶，规避 Wails 事件乱序把 100% 折进下一个 step。action 事件无此字段。
  step?: string;
  // action / AI 任务 output 事件专有：后端 emit 时的自增序号（见 api.execute / api.runAi）。Wails Event.Emit
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
  // 命中高亮标注（与 Go rule.go CompiledRule.Marks / logcat.go logcatPayload.Marks
  // 镜像，json tag 即协议）：四元组 [t, f, s, l] ——
  //   t = token 在下发 Rule.Tokens 中的原下标（= 前端 logcatRule.tokens 序位，
  //       含草稿，据此取色 lib/logcatMarks.ts）；
  //   f = 域码 0=message 1=tag 2=pid（tid 无列不产出）；
  //   s/l = 命中子串在该域字符串内的起点/长度，单位 UTF-16 code unit（JS string 索引）。
  // 仅正向 token；按 (t,f,s) 升序，重叠区间按序后者覆盖；缺省（omitempty）= 无高亮。
  marks?: number[][];
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
  // 组间连接符："or" = 此 token 另起一个条件组（组间任一命中即通过）；"and"/缺省 = 并入
  // 当前组（组内：同 key OR、跨 key AND）。前端 UI 专有编辑态，随 FILTER JSON 落盘。
  link?: "and" | "or";
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

// AI 运行期间 runner 的 stdout/stderr 行（ai:<id>:output 事件里 stream 为 stdout/stderr 的
// 那些）。聊天页在运行失败或有 stderr 时展开作为诊断输出。
export interface AiDiagLine {
  stream: "stdout" | "stderr";
  text: string;
}

// AI 会话终点读数（done 事件附带，AI 任务专有；后端 api.aiReadout 构造）
export interface AiReadoutData {
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  // claude 会话 id（stream-json 的 session_id）：终点读数行展示，可用于 --resume
  sessionId?: string;
}

// 后端 emit 的 done 事件 payload
export interface DoneEventData {
  exitCode: number;
  err: string;
  duration: string;
  readout?: AiReadoutData;
  // action / AI 任务 done 事件专有：与 output 事件共享同一序号空间，但**独占**一个号
  // （后端 api.actionEvents.Done / aiEvents.Done），output 号段因此有一个永久空洞。
  // done 事件同样各起独立 goroutine 投递，可能抢跑在还没到达的 output 行前面；
  // 用它接入 outputFold 的重排队列，确保退出码行落在所有 output 行之后；
  // 同时必须把该号在帧门里登记为已消耗（见 ActionRunnerProvider 的 seqGate.consumed），
  // 否则 done 之后到达的迟到 emit 会永久卡在空洞后面。
  seq?: number;
}

// workflow 单个步骤的运行状态（前端根据协议帧维护）
export interface WorkflowStepState {
  index: number;
  status: "pending" | "running" | "done" | "error" | "skipped";
  exitCode?: number;
  lines: OutputLineItem[];
  // 上一行是否是 progress——决定下一条 progress 覆盖还是追加（同 action 的 lines 语义）
  lastWasProgress?: boolean;
  // 树帧 id 计数（同 action 桶的 FoldState.treeSeq；跨事件持续，防同桶两帧撞 id）
  treeSeq?: number;
  // 时刻（相对运行起点的毫秒）：实时由前端打点，回放取运行日志里的偏移；供耗时读数
  startedAt?: number;
  endedAt?: number;
  // AI 步骤专有：回复/思考/工具调用归约成的工序段（见 lib/workflowStream.ts）。
  // Pipeline Spine 里 AI 步骤以工序段面板渲染；非 AI 步骤没有这个字段。
  aiPanel?: AiPanelState;
}

/** 运行记录的状态词汇（与后端 internal/runstore 对齐）。 */
export const RUN_STATUSES = ["running", "succeeded", "failed", "cancelled", "interrupted", "skipped", "missed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** 运行记录的发起来源：调度到点 / 立即运行 / 手动运行。 */
export const RUN_ORIGINS = ["schedule", "run-now", "manual"] as const;
export type RunOrigin = (typeof RUN_ORIGINS)[number];

/** 目标种类：动作 / 工作流 / AI 任务。 */
export const RUN_TARGET_KINDS = ["action", "workflow", "ai"] as const;
export type RunTargetKind = (typeof RUN_TARGET_KINDS)[number];

// 运行记录的类型直接复用 Wails 生成的绑定（与 ActionItem / WorkflowItem 同理），不手写
// 第二份：改了后端的 api.Run* 之后重新生成 bindings，用到的地方编译期就会报出来。
//   - RunItem：一条运行记录的摘要。outputs 只含读数类的产出（session_id / cost_usd /
//     tokens / exit_code / success），正文类产出在 RunDetail 里。
//   - RunDetail：完整记录，另带正文类产出、守则全文与进程信息。
//   - RunFilter：列表的筛选条件（后端要求每个字段都在；空串 / 0 表示不限）。
export type { RunDetail, RunFilter, RunItem } from "../../bindings/workflow-tool/internal/api/models.js";
import type { RunFilter } from "../../bindings/workflow-tool/internal/api/models.js";

/** 列表筛选的输入形状：只写关心的条件，其余由 Provider 补成「不限」。 */
export type RunListFilter = Partial<RunFilter>;

// 运行日志的一行（后端 runstore.Event）。output / done 行的其余字段与前端实时收到的
// 事件同构（stream / line / step / seq / exitCode / err / duration / readout）。
// 字段集合来自生成的绑定（Partial：生成的类型把可选字段也标成必填的「T | undefined」）；
// stream 与 readout 在这里收窄——生成的类型只知道它们是「字符串」与「任意对象」，而
// 归约器要按输出流的种类分派、按终点读数结算。
export type RunEvent = Partial<Omit<GeneratedRunEvent, "t" | "event" | "stream" | "readout">> & {
  /** 相对启动时刻的毫秒偏移 */
  t: number;
  event: string;
  stream?: OutputEventData["stream"];
  readout?: AiReadoutData;
};

/** 调度编辑器的一份草稿值（与后端 ScheduleInput 同形）。 */
export interface ScheduleFormValue {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  targetKind: RunTargetKind;
  targetId: string;
  params: Record<string, unknown>;
  /** 补跑：应用恢复后为最近一个错过的时刻补跑一次；缺省为关。 */
  catchUp?: boolean;
}

/**
 * 调度编辑器的开合状态。key 变化即把草稿重置为 value（同一 key 期间隐藏 / 重显草稿不丢）；
 * lock 把目标锁定为某个目标（从 AI 卡的「定时」入口进来时类型与目标都不可改）。
 */
export interface ScheduleEditorState {
  key: string;
  value: ScheduleFormValue;
  creating: boolean;
  lock?: { kind: ScheduleFormValue["targetKind"]; id: string };
}
