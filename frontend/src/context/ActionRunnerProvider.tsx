import {
  createContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Events } from "@wailsio/runtime";
import { useTranslation } from "react-i18next";
import {
  findDropInput,
  valueForInput,
  writeToInput,
  type FileDropPayload,
} from "@/lib/filedrop";
import {
  ListActions,
  RunAction,
  CancelAction,
  GetGlobalConfig,
  SetGlobalConfig,
  GetVarReferenceCounts,
  GetFragments,
  SetFragments,
  PickDirectory,
  PickFile,
  OpenActionsDir,
  GetActionYaml,
  SetActionYaml,
  AddPreset,
  ListWorkflows,
  RunWorkflow,
  CancelWorkflow,
  ResumeRun,
  GetWorkflowYaml,
  SetWorkflowYaml,
  UpdateLogcatFilter,
  ListSchedules,
  SaveSchedule,
  DeleteSchedule,
  SetScheduleEnabled,
  RunScheduleNow,
  ListAiTasks,
  RunAi,
  CancelAi,
  GetAiYaml,
  SetAiYaml,
  ListRuns,
  GetRun,
  GetRunEvents,
} from "../../bindings/workflow-tool/internal/api/service.js";
import type {
  ActionItem,
  AiTaskItem,
  ScheduleInput,
  ScheduleItem,
  WorkflowItem,
} from "../../bindings/workflow-tool/internal/api/models.js";
import type { Fragment } from "../../bindings/workflow-tool/internal/registry/models.js";
import { finalizePanel, type AiPanelState } from "../lib/reduceStream";
import { EMPTY_AI_VIEW, reduceAiOutput, type AiViewState } from "../lib/aiStream";
import { reduceWorkflowOutput } from "../lib/workflowStream";
import { foldOutputLine } from "../lib/outputFold";
import { treeFrameToText } from "../lib/treeFrame";
import { expandVars } from "../lib/vars";
import { AI_RESUME, aiCanRun, aiDraftFor, aiRunParams, type AiDraft, type AiPatch } from "../lib/ai";
import { missingRequired, resolveActionParams } from "../lib/params";
import { invalidArrayParams, normalizeArrayParams } from "../lib/arrayParams";
import {
  BUCKETS,
  decayAndBump,
  readUsage,
  writeUsage,
  type Bucket,
  type UsageByBucket,
} from "../lib/usage";
import { hasValidLogcatFilter, ruleFromParams, sortHistogram } from "../lib/logcatRule";
import type {
  OutputEventData,
  OutputLineItem,
  DoneEventData,
  WorkflowStepState,
  LogcatEntry,
  LogcatReplaceFrame,
  LogcatRule,
  AiDiagLine,
  RunDetail,
  RunEvent,
  RunItem,
  RunListFilter,
  ScheduleEditorState,
  ScheduleFormValue,
} from "../types/events";
import { EMPTY_LOGCAT_RULE } from "../types/events";

// logcat 性能参数：state 缓冲上限 / 入站 ref 缓冲上限。
// logcat 启动常一次性倾倒整个 ring buffer（万级行），逐行 setState 会冻结 UI，
// 故 onOutput 仅压入 ref，由定时器按 MAX_LOGCAT 节流并入 state。
// 缓冲对齐后端 raw ring 容量（10k，spec 决策 6）：重放帧可整体落地不被截断。
const MAX_LOGCAT = 10000;
const MAX_LOGCAT_FLUSH = 12000;

interface ScheduleListResponse {
  schedules: ScheduleItem[];
  errors: string[];
}

function normalizeScheduleList(value: unknown): ScheduleListResponse {
  if (!value || typeof value !== "object") return { schedules: [], errors: [] };
  const record = value as Record<string, unknown>;
  const schedules = Array.isArray(record.schedules)
    ? record.schedules.filter((item): item is ScheduleItem => !!item && typeof item === "object")
    : [];
  const errors = Array.isArray(record.errors)
    ? record.errors.filter((error): error is string => typeof error === "string")
    : [];
  return { schedules: [...schedules], errors: [...errors] };
}

function scheduleErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Status = "idle" | "running" | "done" | "error";
interface ExitInfo {
  exitCode: number;
  err: string;
  duration: string;
}

// ——— AI 任务的运行态（AI 是与 action 并列的独立对象，见 docs/ai.md） ———

// 单个 AI 任务的会话视图态见 lib/aiStream.ts 的 AiViewState（实时与运行详情回放共用的
// 归约结果）。这里由 Provider 持有：聊天页切走再切回（组件卸载重挂载）不丢。

// 一次 AI 运行的捕获（按任务 id 一份，前台/后台运行都建）。回放与收尾都读它，不依赖
// currentId——后台运行时 currentId 是别的项。
interface AiCapture {
  // 运行起点：面板工序段时间轴 = Date.now() - startAt
  startAt: number;
  // 本次运行的 seq 帧门（结构同 action 的 seqGate，号段独立：每次运行后端从 1 重新取号）
  gate: { nextSeq: number; pending: Map<number, OutputEventData>; consumed: Set<number> };
  view: AiViewState;
  // 实际发送的参数（再跑用）
  sent: AiDraft;
  // done 事件与到达时刻
  done: DoneEventData | null;
  doneAt: number | null;
  settleTimer: ReturnType<typeof setTimeout> | null;
}

// done 已到但帧门里还有空洞（output 与 done 各起 goroutine 投递，done 可能抢跑）时，
// 给迟到增量一段有界宽限再收尾：不给会随机丢回复尾巴，不设上限则丢包时永远收不了尾。
const AI_SETTLE_GRACE_MS = 400;
const AI_SETTLE_RETRY_MS = 50;

// 右栏视图枚举：OutputPanel 按此分派。原先在接口/useState/setView 三处重复，抽成单一来源。
// 表单不再是视图：action / workflow 参数表单走左侧非模态抽屉 ParamSheet（formSheetOpen）。
export type RunnerView =
  | "output"
  | "global"
  | "logcat"
  | "fragments"
  | "edit"
  | "workflow"
  | "workflow-edit"
  | "settings"
  | "actions-grid"
  | "workflows-grid"
  | "schedules"
  | "ai-grid"
  | "ai-chat"
  | "ai-edit"
  // 运行记录：全部目标的运行列表与单条运行详情（全应用只有这一处回放运行过程）
  | "runs"
  | "run-detail";

export interface RunnerContextValue {
  actions: ActionItem[];
  errors: string[];
  currentId: string | null;
  selectedPreset: string | null;
  // 输出桶行项：文本/进度/树帧（stream=tree 的协议行），见 types/events.ts
  lines: OutputLineItem[];
  status: Status;
  // 是否有任何后台正在运行的 id（供 sidebar 各 item 判断徽标）
  isRunning: (id: string) => boolean;
  exitInfo: ExitInfo | null;
  // Phase 3 新增
  globalConfig: Record<string, string>;
  varRefCounts: Record<string, number | undefined>;
  formValues: Record<string, string>;
  view: RunnerView;
  // AI 会话视图态（聊天页当前展示的那一轮）：回复/思考全文、发送快照、面板归约态、诊断行。
  // 放在 Provider 而非 AiChatView 本地 state，才能在切走/切回（组件卸载重挂载）后保留。
  aiText: string;
  thinkingText: string;
  // 本轮发送的 prompt 快照（已展开 ${VAR}）与发送时刻：聊天页气泡回显用。
  sentPrompt: string;
  sentAt: number | null;
  // AI 输出面板归约态（思考/工具/回答工序段 + 终点读数）；aiText/thinkingText 保留供轻量判断
  aiPanel: AiPanelState;
  // 本轮运行期间 runner 的 stdout/stderr 行（聊天页失败时展示）
  aiDiag: AiDiagLine[];
  // 运行记录（M3）。runsRevision 在任何一条运行记录被创建或写终态时递增（后端
  // runs:changed），列表 / 详情 / 运行记录抽屉据它重新拉取——运行记录是后端的唯一真相，
  // 前端不在本地另存一份。
  runsRevision: number;
  listRuns: (filter: RunListFilter) => Promise<RunItem[]>;
  getRun: (id: string) => Promise<RunDetail>;
  getRunEvents: (id: string) => Promise<RunEvent[]>;
  // 续跑：以一条 AI 运行记录的同一份输入加 resume: <session_id> 发起新的手动运行，
  // 并进入新运行的详情。返回新运行的 id。
  resumeRun: (runId: string) => Promise<string>;
  // 停止某个目标上正在进行的运行，不论它跑在应用进程内还是由执行器承担（调度发起的
  // 运行在后端，取消经停止标记传达）。
  stopRun: (run: Pick<RunItem, "targetKind" | "targetId">) => void;
  // 进入运行记录列表（可带初始筛选）与单条运行详情；closeRun 回到进入详情前的视图
  openRuns: (filter?: RunListFilter) => void;
  openRun: (id: string) => void;
  closeRun: () => void;
  currentRunId: string | null;
  runsFilter: RunListFilter;
  setRunsFilter: (filter: RunListFilter) => void;
  // 调度编辑器（拨盘抽屉）。调度页与 AI 卡的「定时」入口共用：lock 把目标锁定为
  // 某个目标（从 AI 卡进来时类型与任务都不可改）。state 为 null = 关闭。
  openScheduleForm: (value: ScheduleFormValue, creating: boolean, lock?: ScheduleEditorState["lock"]) => void;
  closeScheduleForm: () => void;
  scheduleEditor: ScheduleEditorState | null;
  // logcat 视图：结构化条目缓冲（环形 ~10000，对齐后端 raw ring）
  logcatEntries: LogcatEntry[];
  // 统一过滤规则（后端唯一求值器，前端只编辑+下发；启动/切回时由 params 重建）
  logcatRule: LogcatRule;
  setLogcatRule: (r: LogcatRule) => void;
  // 重放帧携带的读数：matched=当前规则命中数，total=后端 ring 留存行数
  logcatStats: { matched: number; total: number };
  // 重放帧 tag 直方图（频次降序，补全层/快捷条数据源）
  logcatTagHist: Array<[string, number]>;
  // 重放首帧序号（递增）：视图用它的变化触发 240ms 读数脉冲
  logcatReplaceSeq: number;
  // 后端最近一次拒绝过滤规则的原因（空串 = 无错误）。非法正则由前端固化闸门拦，
  // 但 pid 非整数 / Go RE2 不支持的正则 / 手写 FILTER 的未知 key 只有后端能判，
  // 拒绝原因必须回到甲板，否则用户看到 chip 在、过滤不变、毫无线索。
  logcatFilterError: string;
  clearLogcat: () => void;
  fragments: Fragment[];
  // 片段抽屉（非模态）：开合态与开关。会话内有效不落盘；⌘/Ctrl+K 热键在 Provider 内接，
  // 侧栏按钮/抽屉内关闭钮共用同一份状态，切视图不影响开合。
  fragmentsOpen: boolean;
  setFragmentsOpen: (v: boolean) => void;
  toggleFragments: () => void;
  // 参数表单抽屉（非模态，左侧，action / workflow 共用单实例）：开合态会话内有效不落盘。
  // selectPreset / selectWorkflow / editRerun 打开（主区视图原地不动，抽屉只是叠加）；
  // 前台点火（runAction / runWorkflow / runAi 非 background）与切走 currentId 的导航
  // （focusRunning / focusWorkflow / focusAi / openAiChat）关闭。内容按 currentId 从
  // actions / workflows 解析，故单实例重定向：开着时点其他项即替换内容。
  formSheetOpen: boolean;
  setFormSheetOpen: (v: boolean) => void;
  // workflow 状态
  workflows: WorkflowItem[];
  workflowErrors: string[];
  schedules: ScheduleItem[];
  scheduleErrors: string[];
  refreshSchedules: () => Promise<void>;
  saveSchedule: (input: ScheduleInput) => Promise<void>;
  deleteSchedule: (id: string) => Promise<void>;
  setScheduleEnabled: (id: string, enabled: boolean) => Promise<void>;
  runScheduleNow: (id: string) => Promise<void>;
  workflowSteps: WorkflowStepState[];
  // 本次前台运行起点（无运行后保留到下次点火，供仪表带读数）
  wfStartedAt: number | null;
  workflowFormValues: Record<string, string>;
  runningWorkflowId: string | null;
  // 使用频次（三桶：action-usage / workflow-usage / ai-usage）。写入只在 runAction /
  // runWorkflow / runAi 单点发生，读取经 useActionUsage(bucket)——各视图与侧栏共用这一份，
  // 跑一次即所有排序同步刷新。
  usage: UsageByBucket;
  runAction: (id: string, params?: Record<string, any>, background?: boolean, literalKeys?: string[]) => Promise<void>;
  // 上次运行时实际使用的 params（按 id 索引，action / workflow / ai 共用）。空对象表示无参运行过。
  // 存在即代表"跑过至少一次"，OutputToolbar / WorkflowView 据此显示再跑入口。
  lastRunParams: Record<string, Record<string, string>>;
  // 用 lastRunParams[id] 原样再跑（自动分派 action / workflow / ai）
  rerun: (id: string) => void;
  // 用 lastRunParams[id] 预填表单并切到 form / workflow-form 视图，供用户改后再跑
  editRerun: (id: string) => void;
  // AI 任务：列表 / 加载错误 / 当前任务的完整草稿（已声明参数 + prompt/system/resume）
  aiTasks: AiTaskItem[];
  aiErrors: string[];
  aiDraft: AiDraft;
  // 改当前任务草稿的一个键；传 undefined 撤回对该键的修改（回到定义默认值）
  setAiDraftValue: (key: string, value: string | undefined) => void;
  // 运行 AI 任务。overrides（预设值等）并入草稿；background=true（网格卡 run）只登记运行态不切视图。
  runAi: (id: string, overrides?: AiPatch, background?: boolean) => Promise<void>;
  // 该 AI 任务是否在跑（含正被 workflow 的 AI 步骤执行）
  isAiRunning: (id: string) => boolean;
  // 回到某 AI 任务的会话页（运行中则回放；被 workflow 占用则去那个 workflow）
  focusAi: (id: string) => void;
  // 打开某 AI 任务的会话页空态；patch（预设值等）并入草稿。该任务正在运行则改为回到其会话。
  openAiChat: (id: string, patch?: AiPatch) => void;
  // 把 id 切回 currentId 并切视图（用于点侧栏"运行中的动作"回到其输出；AI 任务走 focusAi）
  focusRunning: (id: string, targetView: "output" | "logcat") => void;
  // 把仍在运行的 workflow 切回 workflow 视图（点侧栏运行中 workflow 用）
  focusWorkflow: (id: string) => void;
  // 从卡面直达 YAML 编辑页（action → edit / workflow → workflow-edit / ai → ai-edit），
  // 编辑器以 currentId 初始化
  openYamlEditor: (id: string, kind: "action" | "workflow" | "ai") => void;
  cancel: () => void;
  clearOutput: () => void;
  copyOutput: () => Promise<void>;
  selectPreset: (actionId: string, presetName: string) => void;
  saveGlobalConfig: (kv: Record<string, string>) => Promise<void>;
  saveFragments: (list: Fragment[]) => Promise<void>;
  setView: (v: RunnerView) => void;
  setFormValue: (id: string, value: string) => void;
  setWorkflowFormValue: (id: string, value: string) => void;
  pickDirectory: () => Promise<string>;
  pickFile: () => Promise<string>;
  openActionsDir: () => Promise<void>;
  getActionYaml: (id: string) => Promise<string>;
  saveActionYaml: (id: string, text: string) => Promise<void>;
  // valuesOverride：非表单路径（如 logcat 甲板）携带的完整参数集，缺省用当前 formValues
  addPreset: (
    name: string,
    description: string,
    valuesOverride?: Record<string, string>,
  ) => Promise<void>;
  runWorkflow: (id: string, params?: Record<string, any>, background?: boolean) => Promise<void>;
  cancelWorkflow: () => void;
  selectWorkflow: (id: string) => void;
  getWorkflowYaml: (id: string) => Promise<string>;
  saveWorkflowYaml: (id: string, text: string) => Promise<void>;
  getAiYaml: (id: string) => Promise<string>;
  saveAiYaml: (id: string, text: string) => Promise<void>;
}

// 事件分发表：测试用 _emitForTest 触发；运行时由 Events.On 回调写入。
// 同一事件可能有两个订阅者（视图态订阅 + 按 id 的持久订阅，后者键带 :persistent 后缀）。
const handlers: Record<string, (e: unknown) => void> = {};
// 测试辅助：模拟后端 emit 一个事件，同名的视图订阅与持久订阅都会收到
export function _emitForTest(name: string, e: unknown) {
  handlers[name]?.(e);
  handlers[`${name}:persistent`]?.(e);
}

export const RunnerContext = createContext<RunnerContextValue | null>(null);

export function ActionRunnerProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  // 当前选中的预设名（属于 currentId 动作）；为 null 时父动作高亮，非空时对应 preset 子项高亮
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [lines, setLines] = useState<OutputLineItem[]>([]);
  // 使用频次三桶：初始从各自 localStorage key 读入（key 不变，已有数据零迁移）。
  const [usage, setUsage] = useState<UsageByBucket>(
    () =>
      Object.fromEntries(BUCKETS.map((b) => [b, readUsage(b)])) as UsageByBucket,
  );

  // 计数唯一写入口。桶由运行对象形态决定，调用点只有 runAction / runWorkflow / runAi 三处——
  // 挂在 UI 事件上时漏一个入口就静默失真（ai 桶曾有零写者、表单跑 action 曾不计数）。
  const recordUsage = (bucket: Bucket, id: string) => {
    setUsage((prev) => {
      const next = decayAndBump(prev[bucket], id);
      writeUsage(bucket, next);
      return { ...prev, [bucket]: next };
    });
  };
  const [status, setStatus] = useState<Status>("idle");
  const [exitInfo, setExitInfo] = useState<ExitInfo | null>(null);
  const [globalConfig, setGlobalConfig] = useState<Record<string, string>>({});
  const [varRefCounts, setVarRefCounts] = useState<Record<string, number | undefined>>({});
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [view, setViewState] = useState<RunnerView>("output");
  // 调度编辑器是附着在当前页上的抽屉：切换视图即关闭（它的状态提升在 Provider 里，
  // 不再随页面组件卸载而消失）。
  const setView = (next: RunnerView) => {
    setScheduleEditor(null);
    setViewState(next);
  };
  // AI 会话视图态：聊天页当前展示的那一轮（见 AiViewState）。真身在每次运行的捕获里
  // （AiCapture.view），这里是它面向渲染的投影，由 syncAiView / showAi 写入。
  const [aiView, setAiView] = useState<AiViewState>(EMPTY_AI_VIEW);
  const { text: aiText, thinking: thinkingText, panel: aiPanel, sentPrompt, sentAt, diag: aiDiag } =
    aiView;
  // AI 任务列表 / 加载错误
  const [aiTasks, setAiTasks] = useState<AiTaskItem[]>([]);
  const aiTasksRef = useRef<AiTaskItem[]>([]);
  aiTasksRef.current = aiTasks;
  const [aiErrors, setAiErrors] = useState<string[]>([]);
  // AI 草稿补丁（按任务 id）：只存用户改过的键，其余键现算（定义默认值 > 全局配置），
  // 这样改了定义或全局配置后未动过的键自动跟随。值为 undefined = 撤回对该键的修改。
  const [aiDrafts, setAiDrafts] = useState<Record<string, AiDraft>>({});
  // ref 镜像：同步路径（runAi）要读最新补丁，setState 不保证在同一次调用栈里立即可见
  const aiDraftsRef = useRef<Record<string, AiDraft>>({});
  const patchAiDraft = (id: string, patch: AiPatch) => {
    const next = { ...aiDraftsRef.current[id] };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    const all = { ...aiDraftsRef.current, [id]: next };
    aiDraftsRef.current = all;
    setAiDrafts(all);
  };
  // 聊天页当前展示的 AI 任务 id（ref：事件回调据此判断是否要同步可见态）
  const displayedAiRef = useRef<string | null>(null);
  // 每个任务的运行捕获 / 订阅清理（见 AiCapture；后台运行也占位，收尾时拆除）
  const aiCapturesRef = useRef<Record<string, AiCapture>>({});
  const aiUnsubsRef = useRef<Record<string, () => void>>({});
  // 正在运行的 AI 任务 id 集合（驱动侧栏/网格卡徽标）
  const [aiRunningIds, setAiRunningIds] = useState<Set<string>>(new Set());
  const aiRunningIdsRef = useRef<Set<string>>(new Set());
  const setAiRunning = (id: string, running: boolean) => {
    if (aiRunningIdsRef.current.has(id) === running) return;
    const next = new Set(aiRunningIdsRef.current);
    if (running) next.add(id);
    else next.delete(id);
    aiRunningIdsRef.current = next;
    setAiRunningIds(next);
  };
  // 正被某个运行中 workflow 的 AI 步骤执行的任务：aiHolders[aiId] = workflowId。
  // 后端对 AI 任务按 id 加锁，被占着时直接 runAi 会被拒，故占用也算「运行中」。
  const [aiHolders, setAiHolders] = useState<Record<string, string>>({});
  const aiHoldersRef = useRef<Record<string, string>>({});
  // 当前任务是 AI 任务时的完整草稿（聊天页读写它）；不是 AI 任务时为空对象
  const currentAiTask =
    currentId !== null ? aiTasks.find((task) => task.id === currentId) : undefined;
  const aiDraft = currentAiTask
    ? aiDraftFor(currentAiTask, aiDrafts[currentAiTask.id], globalConfig)
    : {};
  // 运行记录的失效信号与当前查看的运行（见 RunnerContextValue 的 runsRevision）
  const [runsRevision, setRunsRevision] = useState(0);
  const runsBumpRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  // 进入运行详情前的视图：closeRun 回到那里（从调度页进来的回调度页，从会话页进来的回会话页）
  const runReturnViewRef = useRef<RunnerView | null>(null);
  const [runsFilter, setRunsFilter] = useState<RunListFilter>({});
  // 调度编辑器：调度页与 AI 卡共用一份（见 openScheduleForm）
  const [scheduleEditor, setScheduleEditor] = useState<ScheduleEditorState | null>(null);
  // done 闭包由 currentId useEffect 捕获，读 actions/formValues 时闭包可能陈旧，用 ref
  const actionsRef = useRef<ActionItem[]>([]);
  actionsRef.current = actions;
  // logcat 条目缓冲与统一规则（按 currentId 单缓冲，runAction 时清空/重建）
  const [logcatEntries, setLogcatEntries] = useState<LogcatEntry[]>([]);
  const [logcatRule, setLogcatRuleState] = useState<LogcatRule>(EMPTY_LOGCAT_RULE);
  const [logcatStats, setLogcatStats] = useState({ matched: 0, total: 0 });
  const [logcatTagHist, setLogcatTagHist] = useState<Array<[string, number]>>([]);
  const [logcatReplaceSeq, setLogcatReplaceSeq] = useState(0);
  const [logcatFilterError, setLogcatFilterError] = useState("");
  const setLogcatRule = (r: LogcatRule) => setLogcatRuleState(r);
  // logcat 入站缓冲：onOutput 高频回调只往 ref 压，不触发渲染；由下面的定时器批量并入 state。
  const logcatBufferRef = useRef<LogcatEntry[]>([]);
  // progress 原地刷新标记：上一条是 progress → 覆盖该行而非追加，模拟终端 \r 效果
  const lastWasProgressRef = useRef(false);
  // 树帧 id 计数（同 seqStateRef 理由：跨事件持续、不进 state，见 outputFold 的 treeSeq）
  const treeSeqRef = useRef(0);
  // action 输出的 seq 重排态（见 outputFold 备注：Wails Event.Emit 到达顺序无保证，
  // 需要 nextSeq/pending 跨事件持续，故用 ref 而非随 lines 一起进 state）。
  // 每次开跑新 action 必须重置，否则残留的 nextSeq 会把新一轮输出全部误判为「还没轮到」。
  const seqStateRef = useRef({ nextSeq: 1, pending: new Map<number, OutputEventData>() });
  // 统一 seq 排序门（logcat/logcat-replace/stdout 共享同一序号空间）：乱序到达先挂
  // pending，轮到 nextSeq 再按序应用。replace 帧的正确性依赖它——head 帧清空必须
  // 晚于所有旧增量帧、早于自己的 chunk，而 Wails 事件到达顺序无保证。
  // consumed：后端 done 事件独占一个号（events.go 的 Done 用 nextSeq 取号），output
  // 号段因此必然有洞；onDone 把该号登记进 consumed，drain 遇到即跨过，否则 done 之后
  // 到达的任何迟到 emit（logcat 控制协程/pidRefresher 未被 join）会永久卡在洞后面。
  // 与 seqStateRef 同步重置（见 resetSeqState）。
  const seqGateRef = useRef({
    nextSeq: 1,
    pending: new Map<number, OutputEventData>(),
    consumed: new Set<number>(),
  });
  // 重置两套 seq 队列。nextSeq 语义：
  //   1 —— 新一轮运行，后端序号必从 1 起（乱序到达的首帧仍正确挂 pending，不丢行）。
  //   0 —— 哨兵「以首个到达的 seq 为基线」：切回/清屏发生在 run 中途，后端 actionEvents
  //        实例的序号已到几千，打回 1 会让此后所有事件永久挂 pending 且无自愈路径
  //        （面板彻底停止渲染）。代价是「基线之前的号全部丢失」，不是固定一条：首帧
  //        seq=52 对齐后，随后补到的 50/51 都低于 nextSeq，挂上 pending 再也不会出队。
  //        丢几条取决于 Wails 的乱序投递窗口有多宽。可见后果的天花板：被丢的若是一次
  //        logcat 重放的 head 帧而 chunk 仍被应用，日志列表照常出行，只是 matched/total
  //        与 tag 直方图停在旧值；下一次改规则或清空触发新重放即自愈——不破坏事件协议。
  const resetSeqState = (nextSeq = 0) => {
    seqStateRef.current = { nextSeq, pending: new Map() };
    seqGateRef.current = { nextSeq, pending: new Map(), consumed: new Set() };
    // 行桶已清/将清，树帧 id 从头计（与 lines 状态同步重置，避免 key 冲突隐患）
    treeSeqRef.current = 0;
  };
  // 每 ~120ms 把缓冲批量并入 logcatEntries（截断到 MAX_LOGCAT），空缓冲跳过。
  // logcat 启动常先倾倒整个 ring buffer（万级行），逐行 setState 会冻结 UI。
  useEffect(() => {
    const timer = setInterval(() => {
      const buf = logcatBufferRef.current;
      if (buf.length === 0) return;
      logcatBufferRef.current = [];
      const batch =
        buf.length > MAX_LOGCAT_FLUSH
          ? buf.slice(buf.length - MAX_LOGCAT_FLUSH)
          : buf;
      setLogcatEntries((prev) => {
        const total = prev.length + batch.length;
        if (total <= MAX_LOGCAT) return [...prev, ...batch];
        return [...prev, ...batch].slice(total - MAX_LOGCAT);
      });
      // 读数随增量自愈：matched/total 同加本批命中数。否则规则收窄后 matched 停在
      // 重放帧的 0，面板明明在滚动、读数却是 0/N（自相矛盾且看着像没生效）。
      // 两次重放之间 total 低估（未命中的新行后端不下发），下一帧重放整体校准。
      // total>0 才加：尚无重放帧时读数走 logcatEntries.length 分支，不能被抬起来。
      setLogcatStats((s) =>
        s.total > 0
          ? { matched: s.matched + batch.length, total: s.total + batch.length }
          : s,
      );
    }, 120);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ——— logcat 事件落地 ———

  // 增量帧：line 是后端批量下发的 JSON 数组（偶发单对象兼容）；解析失败退化为单条原文。
  // 只压 ref 不触发渲染，由上面的定时器批量并入 state。
  const pushLogcatBatch = (line: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = [{ date: "", time: "", pid: 0, tid: 0, level: "V", tag: "", message: line }];
    }
    const arr = Array.isArray(parsed) ? (parsed as LogcatEntry[]) : [parsed as LogcatEntry];
    const buf = logcatBufferRef.current;
    for (const ent of arr) {
      if (buf.length < MAX_LOGCAT_FLUSH) buf.push(ent);
    }
  };

  // 重放帧（规则变更/清空后，后端重筛 raw ring 整体重发，见 LogcatReplaceFrame）。
  // head=读数+直方图+清空整体替换；后续 chunk 仅追加。经 seqGate 保证与增量帧的相对顺序。
  const applyLogcatReplace = (line: string) => {
    let frame: LogcatReplaceFrame;
    try {
      frame = JSON.parse(line) as LogcatReplaceFrame;
    } catch {
      return;
    }
    if (frame.head) {
      setLogcatStats({ matched: frame.matched ?? 0, total: frame.total ?? 0 });
      setLogcatTagHist(sortHistogram(frame.tagHistogram ?? {}));
      setLogcatReplaceSeq((s) => s + 1);
      // 先丢入站缓冲：其中是旧规则下尚未并业的增量，重放已含其命中部分（ring 全量重筛）。
      logcatBufferRef.current = [];
      setLogcatEntries((frame.entries ?? []).slice(-MAX_LOGCAT));
      return;
    }
    setLogcatEntries((prev) => {
      const next = [...prev, ...(frame.entries ?? [])];
      return next.length > MAX_LOGCAT ? next.slice(next.length - MAX_LOGCAT) : next;
    });
  };

  // 下发用规则映射：draft 剥离（后端不读此字段，保持协议干净）+ link 归一为 string
  // （bindings Token.link 必填，"" = and/缺省；取反 token 的 link 后端忽略）。
  const toApiRule = (r: LogcatRule) => ({
    tokens: r.tokens.map((tk) => ({
      key: tk.key,
      op: tk.op,
      negated: tk.negated,
      value: tk.value,
      link: tk.link ?? "",
    })),
    minLevel: r.minLevel,
    package: r.package,
  });

  // 规则编辑 300ms 防抖下发（spec 决策 3）。params 映射（runAction/focusRunning）
  // 与 resetLogcatState 重置在写入 state 的同时登记 synced 引用：effect 发现规则与 synced
  // 同引用即不下发——初始规则后端已从同一 params 编译，重发只会多一次整体重放
  // （闪烁+滚动复位）；currentId 切到其他运行中动作时同理不误发。
  const logcatRuleSyncedRef = useRef<LogcatRule | null>(null);
  // logcat 面板态整体归零（去 AI 会话页时调用：入站缓冲/条目/规则/读数/拒绝原因）
  const resetLogcatState = () => {
    logcatBufferRef.current = [];
    setLogcatEntries([]);
    logcatRuleSyncedRef.current = EMPTY_LOGCAT_RULE;
    setLogcatRuleState(EMPTY_LOGCAT_RULE);
    setLogcatStats({ matched: 0, total: 0 });
    setLogcatTagHist([]);
    setLogcatReplaceSeq(0);
    setLogcatFilterError("");
  };
  useEffect(() => {
    const id = currentId;
    if (!id || !runningIdsRef.current.has(id)) return;
    if (logcatRuleSyncedRef.current === logcatRule) return;
    const timer = setTimeout(() => {
      logcatRuleSyncedRef.current = logcatRule;
      UpdateLogcatFilter(id, toApiRule(logcatRule), false)
        .then(() => setLogcatFilterError(""))
        .catch((e: unknown) => {
          // 下发失败（非法规则被后端拒 / 控制通道积压）：撤回 synced 登记，否则该规则
          // 被永久当作「已同步」，用户必须改成另一个规则才会再下发（表现为改了不生效）。
          if (logcatRuleSyncedRef.current === logcatRule)
            logcatRuleSyncedRef.current = null;
          setLogcatFilterError(e instanceof Error ? e.message : String(e));
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [logcatRule, currentId]);

  const [fragments, setFragments] = useState<Fragment[]>([]);
  // 片段抽屉开合（会话内，重启默认关，见 RunnerContextValue 注释）
  const [fragmentsOpen, setFragmentsOpen] = useState(false);
  const toggleFragments = () => setFragmentsOpen((v) => !v);
  // 参数表单抽屉开合（会话内，重启默认关）
  const [formSheetOpen, setFormSheetOpen] = useState(false);
  // ⌘/Ctrl+K 全局开关片段抽屉：window 级监听，任何视图/任意焦点位置（含
  // CodeMirror、textarea）都生效。项目内无其它全局快捷键，无冲突。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setFragmentsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // workflow 状态：列表、加载错误、步骤运行状态
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  const [workflowErrors, setWorkflowErrors] = useState<string[]>([]);
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [scheduleErrors, setScheduleErrors] = useState<string[]>([]);
  const scheduleRequestRef = useRef(0);
  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStepState[]>([]);
  // 本次前台运行起点（runWorkflow 点火时打点）：仪表带总 elapsed 读数用
  const [wfStartedAt, setWfStartedAt] = useState<number | null>(null);
  const [workflowFormValues, setWorkflowFormValues] = useState<
    Record<string, string>
  >({});
  // ref 镜像：workflow 常驻跟踪的事件回调要按 id 查步骤定义（是否 AI 步骤）
  const workflowsRef = useRef<WorkflowItem[]>([]);
  workflowsRef.current = workflows;
  const linesRef = useRef<OutputLineItem[]>([]);
  linesRef.current = lines;
  // 当前查看的 id（供持久 done 回调判断是否该更新可见 UI，不触发重渲染）
  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = currentId;
  const viewRef = useRef(view);
  viewRef.current = view;
  // 后台仍在运行的 action id 集合。后端按 id 并发（不同 id 可同时跑），
  // 故运行态必须按 id 记录，不能只靠单一 status——否则切走再回来会丢失「运行中」。
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  // ref 镜像：规则防抖 effect 需读最新运行集合判断是否下发（进 deps 会在无关运行态变化时重复重放）
  const runningIdsRef = useRef<Set<string>>(new Set());
  runningIdsRef.current = runningIds;
  // 每个 action 的 done 订阅清理函数（持久，不随 currentId 切换销毁）
  const actionDoneUnsubs = useRef<Record<string, () => void>>({});
  // 当前 workflow 订阅的清理函数（同步订阅，见 subscribeWorkflow 注释）
  const wfUnsubRef = useRef<(() => void) | null>(null);
  // 各运行中 workflow 的常驻跟踪清理函数（见 registerWorkflowTracker）
  const wfTrackerUnsubs = useRef<Record<string, () => void>>({});
  // 当前正在运行的 workflow id（供 cancelWorkflow 使用，无需触发重渲染）
  const workflowIdRef = useRef<string | null>(null);
  // 正在运行中的 workflow id（持久标记，点其他 action 再点回来时仍能识别）
  const [runningWorkflowId, setRunningWorkflowId] = useState<string | null>(null);
  // 上次运行时实际使用的 params（action / workflow / ai 共用一份，按 id 索引）
  const [lastRunParams, setLastRunParams] = useState<Record<string, Record<string, string>>>({});
  // ref 镜像：done 闭包按 [currentId] 捕获，读 state 会陈旧
  const lastRunParamsRef = useRef<Record<string, Record<string, string>>>({});
  lastRunParamsRef.current = lastRunParams;
  const lastLiteralKeysRef = useRef<Record<string, string[]>>({});

  // 整窗口文件拖拽（Wails EnableFileDrop，见 main.go）：按松手坐标定位目标输入框写入，
  // 不再依赖当前焦点。多路径空格拼接（path/file 字段只取首个），整体覆盖原值。落点不是可写
  // 输入框时静默忽略。覆盖 action 参数表单、全局配置、片段编辑等所有文本输入，不需要每个组件
  // 单独接 HTML5 drop（那套读不到真实路径，且 macOS 上原生 overlay 会吞掉整个拖拽会话）。
  // 片段变量 pill 是 <button> 不在 Field 内，这里必然落空，由 FragmentsList 自己订阅处理。
  useEffect(() => {
    return Events.On("file:dropped", (e: { data: FileDropPayload }) => {
      const { paths, x, y } = e.data ?? {};
      if (!paths?.length || x === undefined || y === undefined) return;
      const el = findDropInput(x, y);
      if (!el) return;
      writeToInput(el, valueForInput(el, paths));
    });
  }, []);

  const applyScheduleList = (value: unknown) => {
    const result = normalizeScheduleList(value);
    setSchedules(result.schedules);
    setScheduleErrors(result.errors);
  };

  const refreshSchedules = async (): Promise<void> => {
    const requestId = ++scheduleRequestRef.current;
    try {
      const result = await ListSchedules();
      if (requestId === scheduleRequestRef.current) applyScheduleList(result);
    } catch (error: unknown) {
      if (requestId === scheduleRequestRef.current) {
        setScheduleErrors([t("error.loadFailed") + ": " + scheduleErrorMessage(error)]);
      }
    }
  };

  // 挂载时拉取动作列表
  useEffect(() => {
    ListActions()
      .then((res) => {
        setActions((res && res.actions) || []);
        setErrors((res && res.errors) || []);
      })
      .catch((e) => setErrors([t("error.loadFailed") + ": " + e]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 挂载时拉取 AI 任务列表
  useEffect(() => {
    ListAiTasks()
      .then((res) => {
        setAiTasks((res && res.tasks) || []);
        setAiErrors((res && res.errors) || []);
      })
      .catch((e) => setAiErrors([t("error.loadFailed") + ": " + e]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 重新拉取 AI 任务列表：每个任务带着它的最近一次运行（AI 卡摘要的来源）。
  const refreshAiTasks = async (): Promise<void> => {
    const res = await ListAiTasks();
    setAiTasks((res && res.tasks) || []);
    setAiErrors((res && res.errors) || []);
  };
  // 运行记录变化后延迟刷新 AI 任务：一次运行「开始 + 结束」连发两条通知，合并成一次重拉。
  const aiRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleAiRefresh = () => {
    if (aiRefreshRef.current) return;
    aiRefreshRef.current = setTimeout(() => {
      aiRefreshRef.current = null;
      refreshAiTasks().catch(() => undefined);
    }, 150);
  };

  // 运行记录失效通知。后端在任何一条运行记录被创建或写终态时发 runs:changed（含调度
  // 发起的、前端没有订阅其输出事件的运行）；这里只递增 runsRevision，由列表 / 详情 /
  // 运行记录抽屉各自重拉，不在 Provider 里另存一份运行记录。
  useEffect(() => {
    const unsubscribe = Events.On("runs:changed", (e: unknown) => {
      const d = (((e as { data?: unknown })?.data) || {}) as {
        status?: string;
        target_kind?: string;
        target_id?: string;
      };
      if (runsBumpRef.current) clearTimeout(runsBumpRef.current);
      runsBumpRef.current = setTimeout(() => {
        runsBumpRef.current = null;
        setRunsRevision((n) => n + 1);
      }, 80);
      // 后端发起的运行（调度到点 / 立即运行）不经前端 runAi/runAction，前端内存运行态只能
      // 从 runs:changed 对齐：running 点亮侧栏/网格卡呼吸灯与徽标，终态熄灭。
      // setAiRunning/setRunningIds 幂等，手动路径已置位时不受影响（目标锁保证同目标单运行）。
      const { status, target_kind: kind, target_id: id } = d;
      if (id && kind === "ai") {
        setAiRunning(id, status === "running");
      } else if (id && kind === "action") {
        setRunningIds((prev) => {
          const next = new Set(prev);
          if (status === "running") next.add(id);
          else next.delete(id);
          return next;
        });
      }
      // 运行结束才有新的「最近一次运行」
      if (status && status !== "running") scheduleAiRefresh();
    });
    return () => {
      unsubscribe();
      if (runsBumpRef.current) clearTimeout(runsBumpRef.current);
      if (aiRefreshRef.current) clearTimeout(aiRefreshRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 挂载时拉取全局配置
  useEffect(() => {
    GetGlobalConfig()
      .then((g) => setGlobalConfig((g ?? {}) as Record<string, string>))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 挂载时拉取指令片段
  useEffect(() => {
    GetFragments()
      .then((list) => setFragments(list ?? []))
      .catch(() => {});
  }, []);

  // 挂载时拉取变量引用计数（actions + fragments 综合，供全局配置展示）
  useEffect(() => {
    GetVarReferenceCounts()
      .then((m) => setVarRefCounts(m ?? {}))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 挂载时拉取 workflow 列表
  useEffect(() => {
    ListWorkflows()
      .then((res) => {
        setWorkflows((res && res.workflows) || []);
        setWorkflowErrors((res && res.errors) || []);
      })
      .catch(() => {});
  }, []);

  // Scheduler 列表与状态事件订阅。事件只作为失效通知，列表由后端重新投影，避免维护第二套 DTO 状态。
  useEffect(() => {
    void refreshSchedules();
    const unsubscribe = Events.On("schedules:changed", () => {
      void refreshSchedules();
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // workflow 事件订阅：必须在 RunWorkflow 之前**同步**建立。
  // 放 useEffect 里会晚一个提交周期，后端 goroutine 已把首帧 step-start 发出，
  // 该帧丢失会让第一个 step 永远停在 pending（stdout 与 step-done 也随之失配）。
  const unsubscribeWorkflow = () => {
    wfUnsubRef.current?.();
    wfUnsubRef.current = null;
  };

  const subscribeWorkflow = (wfid: string) => {
    unsubscribeWorkflow();
    const unsubs: Array<() => void> = [];

    const onOutput = (e: unknown) => {
      const d = (((e as { data?: unknown })?.data) || {}) as OutputEventData;
      // 归约抽在 lib/workflowStream：与运行详情回放共用同一份（回放只是把时刻换成日志偏移）。
      // stdout/stderr/progress 按后端下发的 step 索引落桶；AI 步骤的回复 / 思考 / 工具调用
      // 归约成工序段（aiPanel），spine 里以工序段面板渲染。
      setWorkflowSteps((prev) =>
        reduceWorkflowOutput(prev, d, Date.now(), {
          stderrPrefix: t("output.stderrPrefix"), treeErrLabel: t("tree.parseError"),
          isTreeEnabled: (actionId) => !!actionsRef.current.find((a) => a.id === actionId)?.hmi?.tree,
        }),
      );
    };

    const onDone = (e: unknown) => {
      const d = (((e as { data?: unknown })?.data) || {}) as DoneEventData;
      // 只刷可见态；runningWorkflowId 与 AI 任务占用的释放归常驻跟踪（registerWorkflowTracker）
      if (viewRef.current === "workflow" && currentIdRef.current === wfid) {
        setStatus(d.exitCode === 0 ? "done" : "error");
        setExitInfo(d);
      }
    };

    handlers[`workflow:${wfid}:output`] = onOutput;
    handlers[`workflow:${wfid}:done`] = onDone;
    unsubs.push(Events.On(`workflow:${wfid}:output`, onOutput));
    unsubs.push(Events.On(`workflow:${wfid}:done`, onDone));

    wfUnsubRef.current = () => {
      delete handlers[`workflow:${wfid}:output`];
      delete handlers[`workflow:${wfid}:done`];
      unsubs.forEach((fn) => fn && fn());
    };
  };

  // 卸载：拆掉全部 workflow / AI 订阅并清结算定时器（不再收尾：窗口正在销毁）
  useEffect(() => {
    return () => {
      wfUnsubRef.current?.();
      wfUnsubRef.current = null;
      Object.values(wfTrackerUnsubs.current).forEach((fn) => fn());
      wfTrackerUnsubs.current = {};
      Object.entries(aiCapturesRef.current).forEach(([id, c]) => {
        if (c.settleTimer) clearTimeout(c.settleTimer);
        aiUnsubsRef.current[id]?.();
      });
      aiUnsubsRef.current = {};
      aiCapturesRef.current = {};
    };
  }, []);

  // 按 currentId 订阅事件
  useEffect(() => {
    // AI 任务的事件走 ai:<id>:*，由每次运行的订阅处理（见 subscribeAi），不在这里订阅
    if (!currentId || aiTasksRef.current.some((task) => task.id === currentId)) return;
    const unsubs: Array<() => void> = [];

    // 统一 seq 排序门后再分派：replace 帧的正确性依赖严格的到达顺序（见 seqGateRef
    // 注释）。无 seq（异常场景）直接应用，与旧行为一致。
    const apply = (d: OutputEventData) => {
      if (d.stream === "logcat") {
        pushLogcatBatch(d.line || "");
        return;
      }
      if (d.stream === "logcat-replace") {
        applyLogcatReplace(d.line || "");
        return;
      }
      // stdout/stderr/progress：走共享的 foldOutputLine（progress 原地刷新语义与 workflow step 一致）。
      // seq 重排态存在 ref 里跨事件持续，lines/lastWasProgress 才进 state 驱动渲染。
      setLines((prev) => {
        const folded = foldOutputLine(
          {
            lines: prev,
            lastWasProgress: lastWasProgressRef.current,
            nextSeq: seqStateRef.current.nextSeq,
            pending: seqStateRef.current.pending,
            treeSeq: treeSeqRef.current,
          },
          d,
          {
            stderrPrefix: t("output.stderrPrefix"), treeErrLabel: t("tree.parseError"),
            isTreeEnabled: (actionId) => !!actionsRef.current.find((a) => a.id === actionId)?.hmi?.tree,
          },
        );
        treeSeqRef.current = folded.treeSeq ?? 0;
        lastWasProgressRef.current = folded.lastWasProgress;
        seqStateRef.current = {
          nextSeq: folded.nextSeq ?? 1,
          pending: folded.pending ?? new Map(),
        };
        return folded.lines;
      });
    };

    // 帧门 drain：从 nextSeq 起逐号出队应用；consumed 里的号（done 独占号）直接跨过。
    // 严格逐号是 replace 帧正确性的前提，跳号会让 head 帧的清空与 chunk 错位。
    const drainGate = () => {
      const gate = seqGateRef.current;
      for (;;) {
        if (gate.consumed.delete(gate.nextSeq)) {
          gate.nextSeq++;
          continue;
        }
        const ev = gate.pending.get(gate.nextSeq);
        if (!ev) return;
        gate.pending.delete(gate.nextSeq);
        gate.nextSeq++;
        apply(ev);
      }
    };

    // 哨兵 0（resetSeqState 中途重置留下的）：以首个到达的 seq 为基线重新对齐，
    // 否则 run 已跑到几千号的事件会全部挂 pending 永不出队。
    const syncGateBaseline = (seq: number) => {
      const gate = seqGateRef.current;
      if (gate.nextSeq === 0) gate.nextSeq = seq;
    };

    const onOutput = (e: unknown) => {
      const d = (((e as { data?: unknown })?.data) || {}) as OutputEventData;
      if (d.seq == null) {
        apply(d);
        return;
      }
      syncGateBaseline(d.seq);
      seqGateRef.current.pending.set(d.seq, d);
      drainGate();
    };
    const onDone = (e: unknown) => {
      const d = (((e as { data?: unknown })?.data) || {}) as DoneEventData;
      const errSuffix = d.err ? t("output.errSuffix", { err: d.err }) : "";
      const exitLine = t("output.exitLine", { exitCode: d.exitCode, err: errSuffix });
      // 退出码行必须接入与 output 行同一条 seq 重排队列——done 事件同样各起独立
      // goroutine 投递，可能抢跑在还没到达的 output 行前面（见 events.ts 的 seq 备注）。
      // 无 seq（早退场景）时退化为直接 append，与旧行为一致。
      if (d.seq != null) {
        setLines((prev) => {
          const folded = foldOutputLine(
            {
              lines: prev,
              lastWasProgress: lastWasProgressRef.current,
              nextSeq: seqStateRef.current.nextSeq,
              pending: seqStateRef.current.pending,
            },
            { stream: "stdout", line: exitLine, seq: d.seq },
            { stderrPrefix: t("output.stderrPrefix"), treeErrLabel: t("tree.parseError") },
          );
          lastWasProgressRef.current = folded.lastWasProgress;
          seqStateRef.current = {
            nextSeq: folded.nextSeq ?? 1,
            pending: folded.pending ?? new Map(),
          };
          return folded.lines;
        });
      } else {
        setLines((prev) => [...prev, { kind: "text", text: exitLine }]);
      }
      // done 独占一个 seq（后端 events.go 的 Done 用 nextSeq 取号），帧门那侧没有对应
      // 事件可出队——必须把该号登记为已消耗并 drain 一次，否则 done 之后到达的任何
      // 迟到 emit（logcat 控制协程 / pidRefresher 未被 join）永久卡在这个洞后面。
      if (d.seq != null) {
        syncGateBaseline(d.seq);
        seqGateRef.current.consumed.add(d.seq);
        drainGate();
      }
      setStatus(d.exitCode === 0 ? "done" : "error");
      setExitInfo(d);
    };

    handlers[`action:${currentId}:output`] = onOutput;
    handlers[`action:${currentId}:done`] = onDone;
    unsubs.push(Events.On(`action:${currentId}:output`, onOutput));
    unsubs.push(Events.On(`action:${currentId}:done`, onDone));

    return () => {
      delete handlers[`action:${currentId}:output`];
      delete handlers[`action:${currentId}:done`];
      unsubs.forEach((fn) => fn && fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  const runAction = async (id: string, params: Record<string, any> = {}, background = false, literalKeys: string[] = []) => {
    const action = actions.find((a) => a.id === id);
    const resolved = resolveActionParams(action?.params, globalConfig, params);
    const ignored = action?.stream === "logcat" && hasValidLogcatFilter(resolved.FILTER) ? ["TAG"] : [];
    if (invalidArrayParams(action?.params ?? [], resolved, ignored).length ||
      missingRequired(action?.params ?? [], resolved).some((p) => p.type === "list" || p.type === "arguments")) {
      setFormValues(resolved);
      setCurrentId(id);
      setFormSheetOpen(true);
      return;
    }
    // 只补缺失的默认值；本轮输入作为快照保存，不修改调用者的参数对象。
    const effectiveParams = normalizeArrayParams(action?.params ?? [], {
      ...Object.fromEntries((action?.params ?? [])
        .filter((p) => params[p.id] === undefined && p.default)
        .map((p) => [p.id, p.default])),
      ...params,
    }, globalConfig);
    const mappedKeys = literalKeys.filter((key) => typeof effectiveParams[key] === "string");
    lastLiteralKeysRef.current = { ...lastLiteralKeysRef.current, [id]: mappedKeys };
    setLastRunParams((prev) => ({ ...prev, [id]: { ...effectiveParams } }));
    setRunningIds((prev) => new Set(prev).add(id));
    recordUsage("action-usage", id);
    // background=true（grid 卡片 run 按钮）：只登记 runningIds 驱动徽标，不切视图/不清输出，
    // 用户留在 grid 继续操作；要看输出就点卡片本体走前台路径（单缓冲不恢复是已知限制）。
    if (!background) {
      setLines([]);
      resetSeqState(1); // 新一轮运行：后端序号从 1 起，不用哨兵（乱序首帧仍正确挂 pending）
      setCurrentId(id);
      setStatus("running");
      setExitInfo(null);
      setSelectedPreset(null);
      // 点火即关表单抽屉：输出属于主区视图（output / logcat），不再有「发射态」。
      setFormSheetOpen(false);
      if (action?.stream === "logcat") {
        logcatBufferRef.current = [];
        setLogcatEntries([]);
        // 把本次运行的服务端预过滤参数带入面板规则（映射见 ruleFromParams）。
        // 初始规则后端已从同一 params 编译，登记 synced 后防抖不再重复下发。
        const rule = ruleFromParams(effectiveParams);
        logcatRuleSyncedRef.current = rule;
        setLogcatRuleState(rule);
        setLogcatStats({ matched: 0, total: 0 });
        setLogcatTagHist([]);
        setLogcatReplaceSeq(0);
        setLogcatFilterError("");
        setView("logcat");
      } else {
        setView("output");
      }
    }
    // 注册持久 done 订阅：无论用户是否切走，done 回调都能正确标记该 id 结束（清 runningIds）
    registerActionDone(id);
    try {
      const rpcParams = { ...effectiveParams, ...Object.fromEntries(mappedKeys.map((key) => [key, { $literal: effectiveParams[key] }])) };
      await RunAction(id, rpcParams);
    } catch (e) {
      // 后端判定该 action 已在运行（前端 runningIds 偶发与之不同步，
      // 或用户双击了运行中动作/预设）：此时上方的乐观状态
      // （currentId=id / status=running / 已入 runningIds / view 已切到 output|logcat）
      // 恰好就是「回到运行视图」的目标态，直接保留——这样点运行中的动作会回到其输出界面
      // 且停止按钮可用，而不是把 UI 打成 error 并写一行「启动失败」。
      if (String(e).includes("正在运行")) {
        return;
      }
      if (!background) {
        setLines((prev) => [
          ...prev,
          { kind: "text", text: t("error.startFailed") + ": " + e },
        ]);
        setStatus("error");
      }
      setRunningIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }
  };

  // 为指定 action 注册持久 done 监听（不随 currentId 切换销毁）——
  // 只负责清理 runningIds，UI 层的 lines/status/exitInfo 由 currentId 的 useEffect 处理，
  // 两者都订阅同一事件，各管一件事，不重复。
  const registerActionDone = (id: string) => {
    actionDoneUnsubs.current[id]?.();
    const onDone = () => {
      setRunningIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
      actionDoneUnsubs.current[id]?.();
      delete actionDoneUnsubs.current[id];
    };
    handlers[`action:${id}:done:persistent`] = onDone;
    const unsub = Events.On(`action:${id}:done`, onDone);
    actionDoneUnsubs.current[id] = () => {
      delete handlers[`action:${id}:done:persistent`];
      unsub();
    };
  };

  // 清掉某 workflow 占用的全部 AI 任务标记
  const dropAiHoldersOf = (wfid: string) => {
    if (!Object.values(aiHoldersRef.current).includes(wfid)) return;
    const next = { ...aiHoldersRef.current };
    for (const [aiId, wf] of Object.entries(next)) {
      if (wf === wfid) delete next[aiId];
    }
    aiHoldersRef.current = next;
    setAiHolders(next);
  };
  const setAiHolder = (aiId: string, wfid: string) => {
    aiHoldersRef.current = { ...aiHoldersRef.current, [aiId]: wfid };
    setAiHolders(aiHoldersRef.current);
  };
  const clearAiHolder = (aiId: string) => {
    if (!(aiId in aiHoldersRef.current)) return;
    const next = { ...aiHoldersRef.current };
    delete next[aiId];
    aiHoldersRef.current = next;
    setAiHolders(next);
  };
  // 拆掉某 workflow 的常驻跟踪（订阅 + AI 任务占用）
  const releaseWorkflowTracker = (id: string) => {
    dropAiHoldersOf(id);
    wfTrackerUnsubs.current[id]?.();
    delete wfTrackerUnsubs.current[id];
  };

  // 为指定 workflow 注册常驻跟踪（不随 currentId 切换销毁；前台/后台运行都注册）：
  //  - done：清 runningWorkflowId、放掉它占用的 AI 任务、自清理；
  //  - step-start/step-done/step-skip：该步骤是 AI 任务时登记/释放占用（aiHolders）。
  // 与 subscribeWorkflow（视图态）订阅同一事件，各管一件事，键带 :persistent 不冲突。
  const registerWorkflowTracker = (id: string) => {
    releaseWorkflowTracker(id);
    const onStep = (e: unknown) => {
      const d = (((e as { data?: unknown })?.data) || {}) as OutputEventData;
      if (d.stream !== "step-start" && d.stream !== "step-done" && d.stream !== "step-skip") return;
      // step-done 的 line 是 "<索引>:<退出码>"，parseInt 同样取到索引
      const info = workflowsRef.current.find((w) => w.id === id)?.steps?.[parseInt(d.line, 10)];
      if (info?.kind !== "ai" || !info.label) return;
      if (d.stream === "step-start") setAiHolder(info.label, id);
      else clearAiHolder(info.label);
    };
    const onDone = () => {
      setRunningWorkflowId(null);
      releaseWorkflowTracker(id);
    };
    handlers[`workflow:${id}:output:persistent`] = onStep;
    handlers[`workflow:${id}:done:persistent`] = onDone;
    const unsubs = [
      Events.On(`workflow:${id}:output`, onStep),
      Events.On(`workflow:${id}:done`, onDone),
    ];
    wfTrackerUnsubs.current[id] = () => {
      delete handlers[`workflow:${id}:output:persistent`];
      delete handlers[`workflow:${id}:done:persistent`];
      unsubs.forEach((fn) => fn && fn());
    };
  };

  // focusRunning：把仍在运行的 action 切回当前视图（点击侧栏运行中动作用）。
  // 重置 status=running 与 exitInfo=null，让 UI 显示「运行中」而不是上次运行的完成态。
  // AI 任务走 focusAi（每次运行的输出都进捕获，可回放，没有单缓冲丢失问题）。
  const focusRunning = (id: string, targetView: "output" | "logcat") => {
    // 导航去运行视图：表单抽屉随之关闭（内容按 currentId 取，不跟随切换）
    setFormSheetOpen(false);
    setCurrentId(id);
    setStatus("running");
    setExitInfo(null);
    setSelectedPreset(null);
    if (targetView === "logcat") {
      setLines([]); // 单缓冲已被覆盖，保留会误导
      resetSeqState();
      logcatBufferRef.current = [];
      setLogcatEntries([]);
      // 恢复该次运行实际使用的规则（全局单份，期间可能被其他 logcat 动作覆盖）。
      // 登记 synced 防止防抖重复下发本次直发。
      const rule = ruleFromParams(lastRunParamsRef.current[id]);
      logcatRuleSyncedRef.current = rule;
      setLogcatRuleState(rule);
      // 切到另一个 logcat 动作时立刻清掉上一个动作的拒绝原因，否则它会挂在新动作
      // 的过滤条上直到下面那次 UpdateLogcatFilter 往返完成（不落地则长期错误归属）。
      setLogcatFilterError("");
      // 用恢复的规则触发一次后端整体重放：把切走期间丢失的单缓冲条目从 raw ring 找回。
      UpdateLogcatFilter(id, toApiRule(rule), false)
        .then(() => setLogcatFilterError(""))
        .catch((e: unknown) =>
          setLogcatFilterError(e instanceof Error ? e.message : String(e)),
        );
    } else {
      setLines([]); // output 视图：单缓冲已被覆盖，保留会误导
      resetSeqState();
    }
    setView(targetView);
  };

  // ——— AI 任务：运行、回放、导航 ———

  // 可见态同步：只有「会话页正展示这个任务」时才把捕获写进 aiView。两个条件都要：
  // 只看 displayedAiRef 的话，切到别的项后残留的值会让别的项的状态被这个任务的事件改写。
  const isDisplayedAi = (id: string) =>
    displayedAiRef.current === id && currentIdRef.current === id;
  const syncAiView = (id: string) => {
    const c = aiCapturesRef.current[id];
    if (c && isDisplayedAi(id)) setAiView(c.view);
  };

  // 把一条已过帧门的 AI output 事件并入捕获。归约抽在 lib/aiStream：与运行详情回放
  // 共用同一份；工序段的时间轴用到达时刻相对运行起点。
  const applyAiEvent = (c: AiCapture, d: OutputEventData) => {
    c.view = reduceAiOutput(c.view, d, Math.max(0, Date.now() - c.startAt));
  };

  // 帧门 drain：从 nextSeq 起逐号出队应用；consumed 里的号（done 独占号）直接跨过。
  const drainAi = (c: AiCapture) => {
    const gate = c.gate;
    for (;;) {
      if (gate.consumed.delete(gate.nextSeq)) {
        gate.nextSeq++;
        continue;
      }
      const ev = gate.pending.get(gate.nextSeq);
      if (!ev) return;
      gate.pending.delete(gate.nextSeq);
      gate.nextSeq++;
      applyAiEvent(c, ev);
    }
  };

  // 同步订阅某次 AI 运行的 output/done：必须在 RunAi 之前建立（理由同 subscribeWorkflow）。
  // 订阅跟着这一轮运行走（不跟 currentId），收尾时拆除。
  const subscribeAi = (id: string) => {
    aiUnsubsRef.current[id]?.();

    const onOutput = (e: unknown) => {
      const c = aiCapturesRef.current[id];
      if (!c) return;
      const d = (((e as { data?: unknown })?.data) || {}) as OutputEventData;
      if (d.seq == null) {
        // 无 seq（异常场景）直接应用，与 action 侧行为一致
        applyAiEvent(c, d);
      } else {
        c.gate.pending.set(d.seq, d);
        drainAi(c);
      }
      syncAiView(id);
      // done 已到、这一帧正好补齐空洞：立即收尾，不等下一次宽限复查
      if (c.done) settleAi(id, c);
    };

    const onDone = (e: unknown) => {
      const c = aiCapturesRef.current[id];
      if (!c || c.done) return;
      const d = (((e as { data?: unknown })?.data) || {}) as DoneEventData;
      // done 独占一个 seq（后端 events.go 的 Done 用 nextSeq 取号）：登记为已消耗并跨过
      if (d.seq != null) {
        c.gate.consumed.add(d.seq);
        drainAi(c);
      }
      c.done = d;
      c.doneAt = Date.now();
      syncAiView(id);
      settleAi(id, c);
    };

    handlers[`ai:${id}:output`] = onOutput;
    handlers[`ai:${id}:done`] = onDone;
    const unsubs = [
      Events.On(`ai:${id}:output`, onOutput),
      Events.On(`ai:${id}:done`, onDone),
    ];
    aiUnsubsRef.current[id] = () => {
      delete handlers[`ai:${id}:output`];
      delete handlers[`ai:${id}:done`];
      unsubs.forEach((fn) => fn && fn());
    };
  };

  // 收尾：结算面板、刷可见态、拆订阅、清运行标记。运行记录由后端落盘（写完会发
  // runs:changed），前端不在本地另存运行记录。
  // quiet：调用方已经把用户带到别处（正在占用该目标的运行详情），只收尾、不动可见态。
  const finalizeAi = (id: string, c: AiCapture, quiet = false) => {
    if (c.settleTimer) {
      clearTimeout(c.settleTimer);
      c.settleTimer = null;
    }
    aiUnsubsRef.current[id]?.();
    delete aiUnsubsRef.current[id];
    if (aiCapturesRef.current[id] === c) delete aiCapturesRef.current[id];
    const d = c.done ?? { exitCode: 1, err: "", duration: "" };
    // 面板收尾：结算末段 + 写终点读数（后端 readout 优先，缺失字段不显示）
    const view: AiViewState = {
      ...c.view,
      panel: finalizePanel(c.view.panel, {
        durationMs: d.readout?.durationMs,
        inputTokens: d.readout?.inputTokens,
        outputTokens: d.readout?.outputTokens,
        costUsd: d.readout?.costUsd,
        isError: d.exitCode !== 0,
      }),
    };
    c.view = view;
    if (isDisplayedAi(id) && !quiet) {
      setAiView(view);
      setStatus(d.exitCode === 0 ? "done" : "error");
      setExitInfo(d);
    }
    setAiRunning(id, false);
  };

  // done 到达后判断能否收尾：帧门已无空洞，或宽限（AI_SETTLE_GRACE_MS）用尽；否则稍后再看。
  const settleAi = (id: string, c: AiCapture) => {
    if (aiCapturesRef.current[id] !== c || !c.done) return;
    const doneSeq = c.done.seq;
    if (
      doneSeq == null ||
      c.gate.nextSeq >= doneSeq ||
      Date.now() - (c.doneAt ?? 0) >= AI_SETTLE_GRACE_MS
    ) {
      finalizeAi(id, c); // 同时清掉待触发的复查定时器
      return;
    }
    if (c.settleTimer) return;
    c.settleTimer = setTimeout(() => {
      c.settleTimer = null;
      settleAi(id, c);
    }, AI_SETTLE_RETRY_MS);
  };

  // 点火失败（RPC 被拒：后端判「正在运行」而前端没有这次运行的跟踪、参数不合法等）。
  // 前台运行时失败原因显示在会话页；后台运行不打断用户当前所在视图，静默收场。
  // goneToLive：调用方已把用户带到正在占用该目标的运行详情，这一轮只需收尾。
  const failAi = (id: string, message: string, goneToLive = false) => {
    const c = aiCapturesRef.current[id];
    if (!c) return;
    c.done = { exitCode: 1, err: message, duration: "" };
    finalizeAi(id, c, goneToLive);
  };

  // 该 AI 任务此刻若有正在进行的运行，去它的运行详情实时跟踪。
  // 目标被调度发起的运行占着时，前端没有那一轮的输出捕获（它不经前端发起）——
  // 从卡面点「运行」会被拒，若只是静默收场，用户看到的就是「点了没反应」。
  const goToLiveRun = async (id: string): Promise<boolean> => {
    try {
      const live = await listRuns({ targetKind: "ai", targetId: id, status: "running" });
      if (!live[0]) return false;
      openRun(live[0].id);
      return true;
    } catch {
      return false; // 查不到就按原来的方式收场
    }
  };

  // startAi：用一份草稿补丁起一轮运行（不写回草稿；rerun 用，免得一次性的 resume 留在
  // 会话里）。同步建捕获 + 订阅后再发 RPC，确保不漏首帧。background=true（网格卡 run
  // 按钮）只登记运行态不切视图，要看会话就点卡片本体（focusAi 回放捕获）。
  const startAi = async (task: AiTaskItem, overlay: AiPatch | undefined, background: boolean) => {
    const id = task.id;
    if (aiHoldersRef.current[id]) {
      // 正被某个 workflow 的 AI 步骤执行（后端同一把锁，RunAi 会被拒）：去那个 workflow
      focusAi(id);
      return;
    }
    const existing = aiCapturesRef.current[id];
    if (existing) {
      if (!existing.done) {
        // 已在运行：前台点运行 = 回到会话，后台保持不动
        if (!background) focusAi(id);
        return;
      }
      // 上一轮 done 已到、还在等迟到增量：立即收尾再起新一轮
      finalizeAi(id, existing);
    }
    const draft = aiDraftFor(task, overlay, globalConfig);
    if (!aiCanRun(task, draft)) {
      // 缺必填输入（提示词为空 / 必填参数未填）：进会话页补全
      openAiChat(id);
      return;
    }
    const sent = aiRunParams(task, overlay, draft);
    setLastRunParams((prev) => ({ ...prev, [id]: sent }));
    setAiRunning(id, true);
    recordUsage("ai-usage", id);
    const now = Date.now();
    const c: AiCapture = {
      startAt: now,
      gate: { nextSeq: 1, pending: new Map(), consumed: new Set() },
      view: {
        ...EMPTY_AI_VIEW,
        // 冻结本轮 prompt 快照（展开 ${VAR} 后的文本）+ 发送时刻，供聊天页气泡回显
        sentPrompt: expandVars(draft.prompt, { ...globalConfig, ...draft }),
        sentAt: now,
      },
      sent,
      done: null,
      doneAt: null,
      settleTimer: null,
    };
    aiCapturesRef.current[id] = c;
    subscribeAi(id);
    if (!background) {
      setLines([]); // action 输出单缓冲：让位给会话页，保留会误导
      resetSeqState();
      setCurrentId(id);
      setSelectedPreset(null);
      setStatus("running");
      setExitInfo(null);
      setFormSheetOpen(false);
      resetLogcatState();
      // currentIdRef 随渲染同步，这里要提前镜像：RunAi 紧接着被拒时收尾路径（failAi）
      // 读的还是旧值，会把这一轮当成「没在展示」，失败原因落不到会话页
      currentIdRef.current = id;
      displayedAiRef.current = id;
      setAiView(c.view);
      setView("ai-chat");
    } else if (isDisplayedAi(id)) {
      // 该任务的会话页正开着：新一轮输出只进捕获，页面回到空态
      displayedAiRef.current = null;
      setAiView(EMPTY_AI_VIEW);
      setStatus("idle");
      setExitInfo(null);
    }
    try {
      await RunAi(id, sent);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 后台起撞上运行中的目标：去那条运行的详情，而不是让这一下点击毫无反应
      const goneToLive = background && message.includes("正在运行") ? await goToLiveRun(id) : false;
      failAi(id, message, goneToLive);
    }
  };

  // runAi：运行 AI 任务。overrides（预设值等）并入该任务的草稿。
  const runAi = async (id: string, overrides?: AiPatch, background = false) => {
    const task = aiTasksRef.current.find((t) => t.id === id);
    if (!task) return;
    if (overrides) patchAiDraft(id, overrides);
    await startAi(task, aiDraftsRef.current[id], background);
  };

  // openAiChat：打开某 AI 任务的会话页空态——设为当前、清输出缓冲、切 ai-chat。
  // patch（网格卡预设 chips 的「带预设进对话」等）并入草稿：只覆写给出的 key，稀疏预设
  // 保留回退（定义默认值 > 全局配置）。该任务正在运行则改为回到其会话（focusAi）。
  const openAiChat = (id: string, patch?: AiPatch) => {
    if (!aiTasksRef.current.some((task) => task.id === id)) return;
    if (patch) patchAiDraft(id, patch);
    if (aiCapturesRef.current[id]) {
      focusAi(id);
      return;
    }
    setFormSheetOpen(false); // 进会话页：表单抽屉关闭
    setCurrentId(id);
    setSelectedPreset(null);
    setLines([]);
    resetSeqState();
    resetLogcatState();
    setStatus("idle");
    setExitInfo(null);
    currentIdRef.current = id;
    displayedAiRef.current = id;
    setAiView(EMPTY_AI_VIEW);
    setView("ai-chat");
  };

  // 把 id 的会话态摆到可见位（有运行捕获则回放——含 done 已到但尚未收尾的一轮；否则空态），
  // 不动 view。focusAi 与 openYamlEditor("ai") 共用：编辑页退出回到 ai-chat 时看到的
  // 必须与直接进会话页一致。
  const showAi = (id: string) => {
    setFormSheetOpen(false);
    setCurrentId(id);
    setSelectedPreset(null);
    const c = aiCapturesRef.current[id];
    // 会话页正展示着这个任务且它没有运行捕获（上一轮已收尾）：可见态原样保留——
    // 从编辑页退回来时，刚结束的那一轮还在页面上。
    if (!c && isDisplayedAi(id)) return;
    currentIdRef.current = id;
    displayedAiRef.current = id;
    setAiView(c ? c.view : EMPTY_AI_VIEW);
    if (c?.done) {
      setStatus(c.done.exitCode === 0 ? "done" : "error");
      setExitInfo(c.done);
    } else {
      setStatus(c ? "running" : "idle");
      setExitInfo(null);
    }
  };

  // focusAi：回到某 AI 任务的会话页（点侧栏 / 网格卡片本体）。
  // 正被 workflow 的 AI 步骤执行 → 去那个 workflow；有运行捕获 → 回放；否则开空态。
  const focusAi = (id: string) => {
    const holder = aiHoldersRef.current[id];
    if (holder) {
      focusWorkflow(holder);
      return;
    }
    if (!aiCapturesRef.current[id]) {
      openAiChat(id);
      return;
    }
    if (!isDisplayedAi(id)) {
      setLines([]); // action 输出单缓冲已被覆盖，保留会误导
      resetSeqState();
      resetLogcatState();
    }
    showAi(id);
    setView("ai-chat");
  };

  // focusWorkflow：切回仍在运行的 workflow，不清 steps（保留已跑到的进度）。
  // 与 focusRunning（action）语义类似；已完成时不动 status/exitInfo（保留 done/error 徽标）。
  // 仍在运行（含 grid 静默后台跑）：后台路径只有常驻跟踪（registerWorkflowTracker），
  // 不维护步骤桶——必须补建 subscribeWorkflow 否则 spine 看不到任何步骤推进；
  // 同时登记 workflowIdRef（停止按钮可用）并置 running 态/起点（spine 仪表带依赖）。
  // 起点后端不提供，用回跳时刻近似（总耗时低估，但不至于拿上一轮的起点倒挂）。
  const focusWorkflow = (id: string) => {
    setFormSheetOpen(false); // 导航去 workflow 视图：表单抽屉随之关闭
    setCurrentId(id);
    setSelectedPreset(null);
    if (runningWorkflowId === id) {
      workflowIdRef.current = id;
      subscribeWorkflow(id);
      setStatus("running");
      setExitInfo(null);
      setWfStartedAt(Date.now());
    }
    setView("workflow");
  };

  // openYamlEditor：从卡面直达该对象的 YAML 编辑页（网格卡展开态「编辑配置」）。
  // 只做导航 + 设 currentId（编辑器以 currentId 初始化 editingId），不动 status/output 缓冲。
  // ai：编辑页退出回到 ai-chat，故先把该任务的会话态摆好（见 showAi）。
  const openYamlEditor = (id: string, kind: "action" | "workflow" | "ai") => {
    if (kind === "ai") {
      showAi(id);
    } else {
      setFormSheetOpen(false); // 导航离开：表单抽屉关闭
      setCurrentId(id);
      setSelectedPreset(null);
    }
    setView(kind === "workflow" ? "workflow-edit" : kind === "ai" ? "ai-edit" : "edit");
  };

  // runWorkflow：先同步订阅事件再启动执行，确保不漏首帧。
  // background=true（grid 卡片 run 按钮）则不切视图/不订阅，仅登记徽标由 done 清理。
  const runWorkflow = async (id: string, params: Record<string, any> = {}, background = false) => {
    const specs = workflows.find((w) => w.id === id)?.params ?? [];
    const defaults = Object.fromEntries(specs.filter((p) => p.default).map((p) => [p.id, p.default]));
    const effectiveParams = normalizeArrayParams(specs, { ...defaults, ...params }, globalConfig);
    if (invalidArrayParams(specs, effectiveParams).length ||
      missingRequired(specs, effectiveParams).some((p) => p.type === "list" || p.type === "arguments")) {
      setWorkflowFormValues(effectiveParams);
      setCurrentId(id);
      setFormSheetOpen(true);
      return;
    }
    setLastRunParams((prev) => ({ ...prev, [id]: effectiveParams as Record<string, string> }));
    setRunningWorkflowId(id);
    recordUsage("workflow-usage", id);
    if (!background) {
      setWorkflowSteps([]);
      setWfStartedAt(Date.now());
      setCurrentId(id);
      setSelectedPreset(null);
      setStatus("running");
      setExitInfo(null);
      setFormSheetOpen(false); // 点火即关表单抽屉，主区切 workflow spine
      setView("workflow");
      workflowIdRef.current = id;
      // 同步订阅 output/done：前台运行要展示 pipeline spine 与状态。
      subscribeWorkflow(id);
    }
    // grid 静默运行（background）不订阅 output、不切视图。前台/后台都注册常驻跟踪：
    // done 清 runningWorkflowId（驱动徽标），并跟踪 AI 步骤占用的任务。
    registerWorkflowTracker(id);
    try {
      await RunWorkflow(id, effectiveParams);
    } catch {
      if (!background) setStatus("error");
      setRunningWorkflowId(null);
      releaseWorkflowTracker(id);
    }
  };

  // selectWorkflow：有 params → 预填表单并打开表单抽屉（主区视图原地不动）；无 params → 直接跑
  const selectWorkflow = (id: string) => {
    const w = workflows.find((x) => x.id === id);
    if (!w) return;
    const hasParams = (w.params?.length ?? 0) > 0;
    if (!hasParams) {
      runWorkflow(id, {});
      return;
    }
    // 用 default 预填
    const vals: Record<string, string> = {};
    w.params?.forEach((p) => {
      vals[p.id] = p.default || "";
    });
    setWorkflowFormValues(vals);
    setCurrentId(id);
    setSelectedPreset(null);
    setStatus("idle");
    setExitInfo(null);
    setFormSheetOpen(true);
  };

  const cancelWorkflow = () => {
    if (workflowIdRef.current) CancelWorkflow(workflowIdRef.current);
  };

  // selectPreset：把预设值（+ 各 param 的 default 预填）填入 formValues，打开表单抽屉。
  // presetName 找不到时（如 ""）仅用 default 预填，仍进表单。
  // 优先级：preset值 > param default > 全局配置同名 key
  const selectPreset = (actionId: string, presetName: string) => {
    const a = actions.find((x) => x.id === actionId);
    if (!a) return;
    const p = a.presets?.find((x) => x.name === presetName);
    setFormValues(resolveActionParams(a.params, globalConfig, p?.values));
    setCurrentId(actionId);
    setSelectedPreset(presetName || null); // 记住选中的 preset，子项据此高亮、父项取消高亮
    // 进表单=准备新配置，清除上次运行的 status/exitInfo，避免选中动作残留 error/done 徽标
    setStatus("idle");
    setExitInfo(null);
    setFormSheetOpen(true);
  };

  const saveSchedule = async (input: ScheduleInput): Promise<void> => {
    const requestId = ++scheduleRequestRef.current;
    try {
      const result = await SaveSchedule(input);
      if (requestId === scheduleRequestRef.current) applyScheduleList(result);
    } catch (error: unknown) {
      if (requestId === scheduleRequestRef.current) {
        setScheduleErrors([scheduleErrorMessage(error)]);
      }
      throw error;
    }
  };

  const deleteSchedule = async (id: string): Promise<void> => {
    const requestId = ++scheduleRequestRef.current;
    try {
      const result = await DeleteSchedule(id);
      if (requestId === scheduleRequestRef.current) applyScheduleList(result);
    } catch (error: unknown) {
      if (requestId === scheduleRequestRef.current) {
        setScheduleErrors([scheduleErrorMessage(error)]);
      }
      throw error;
    }
  };

  const setScheduleEnabled = async (id: string, enabled: boolean): Promise<void> => {
    const requestId = ++scheduleRequestRef.current;
    try {
      const result = await SetScheduleEnabled(id, enabled);
      if (requestId === scheduleRequestRef.current) applyScheduleList(result);
    } catch (error: unknown) {
      if (requestId === scheduleRequestRef.current) {
        setScheduleErrors([scheduleErrorMessage(error)]);
      }
      throw error;
    }
  };

  const runScheduleNow = async (id: string): Promise<void> => {
    const requestId = ++scheduleRequestRef.current;
    try {
      await RunScheduleNow(id);
      if (requestId === scheduleRequestRef.current) await refreshSchedules();
    } catch (error: unknown) {
      if (requestId === scheduleRequestRef.current) {
        setScheduleErrors([scheduleErrorMessage(error)]);
      }
      throw error;
    }
  };

  // ——— 运行记录：列表与运行详情 ———
  // 运行记录只在被看到时才向后端取（列表 / 详情 / 会话页的运行记录抽屉），不在 Provider
  // 里常驻一份：它是后端的唯一真相，runsRevision 变了由订阅方重拉。

  const listRuns = async (filter: RunListFilter): Promise<RunItem[]> => {
    // 生成的 RunFilter 要求每个字段都在：没写的补成「不限」
    const res = await ListRuns({
      targetKind: filter.targetKind ?? "", targetId: filter.targetId ?? "",
      status: filter.status ?? "", origin: filter.origin ?? "", limit: filter.limit ?? 0,
    });
    return (res && res.runs) || [];
  };
  const getRun = async (id: string): Promise<RunDetail> => GetRun(id);
  // 运行日志行：后端的 stream / readout 在生成的类型里只是 string / 任意对象，
  // 收窄成归约器要的形状（见 types/events.ts 的 RunEvent）
  const getRunEvents = async (id: string): Promise<RunEvent[]> => ((await GetRunEvents(id)) || []) as unknown as RunEvent[];

  const resumeRun = async (runId: string): Promise<string> => {
    const newId = await ResumeRun(runId);
    openRun(newId);
    return newId;
  };
  const stopRun = (run: Pick<RunItem, "targetKind" | "targetId">) => {
    if (run.targetKind === "ai") CancelAi(run.targetId);
    else if (run.targetKind === "workflow") CancelWorkflow(run.targetId);
    else CancelAction(run.targetId);
  };

  const openRuns = (filter: RunListFilter = {}) => {
    setFormSheetOpen(false);
    setRunsFilter(filter);
    setView("runs");
  };
  // 打开一条运行详情。记住来处：运行详情是全应用唯一查看运行过程的地方，调度页、
  // 会话页的运行记录抽屉、运行记录列表都进得来，退出时各回各处。
  const openRun = (id: string) => {
    if (viewRef.current !== "run-detail") runReturnViewRef.current = viewRef.current;
    setFormSheetOpen(false);
    setCurrentRunId(id);
    setView("run-detail");
  };
  const closeRun = () => {
    setCurrentRunId(null);
    setView(runReturnViewRef.current ?? "runs");
    runReturnViewRef.current = null;
  };

  // ——— 调度编辑器 ———
  // 每次打开换一个 key：抽屉据它把草稿重置为本次的值。
  const scheduleEditorSeqRef = useRef(0);
  const openScheduleForm = (value: ScheduleFormValue, creating: boolean, lock?: ScheduleEditorState["lock"]) => {
    setFormSheetOpen(false);
    scheduleEditorSeqRef.current += 1;
    setScheduleEditor({ key: `${value.id}:${scheduleEditorSeqRef.current}`, value, creating, lock });
  };
  const closeScheduleForm = () => setScheduleEditor(null);

  const saveGlobalConfig = async (kv: Record<string, string>) => {
    await SetGlobalConfig(kv);
    setGlobalConfig(kv);
  };

  const saveFragments = async (list: Fragment[]) => {
    await SetFragments(list);
    setFragments(list);
    // 片段改动影响引用计数，刷新
    GetVarReferenceCounts()
      .then((m) => setVarRefCounts(m ?? {}))
      .catch(() => {});
  };

  const getActionYaml = async (id: string): Promise<string> => {
    return await GetActionYaml(id);
  };

  const getWorkflowYaml = async (id: string): Promise<string> => {
    return await GetWorkflowYaml(id);
  };

  const saveWorkflowYaml = async (id: string, text: string): Promise<void> => {
    const res = await SetWorkflowYaml(id, text);
    setWorkflows((res && res.workflows) || []);
    setWorkflowErrors((res && res.errors) || []);
    // workflow 改动可能改变 ${VAR} 引用（step.shell/params/env），刷新计数
    GetVarReferenceCounts()
      .then((m) => setVarRefCounts(m ?? {}))
      .catch(() => {});
  };

  const getAiYaml = async (id: string): Promise<string> => {
    return await GetAiYaml(id);
  };

  // saveAiYaml：写回 yaml（后端校验+重载），成功后用返回的列表刷新 aiTasks/aiErrors。
  const saveAiYaml = async (id: string, text: string): Promise<void> => {
    const res = await SetAiYaml(id, text);
    setAiTasks((res && res.tasks) || []);
    setAiErrors((res && res.errors) || []);
    // AI 任务改动可能改变 ${VAR} 引用（prompt/system/参数默认值），刷新计数
    GetVarReferenceCounts()
      .then((m) => setVarRefCounts(m ?? {}))
      .catch(() => {});
  };

  // saveActionYaml：写回 yaml（后端校验+重载），成功后用返回的列表刷新 actions/errors。
  const saveActionYaml = async (id: string, text: string): Promise<void> => {
    const res = await SetActionYaml(id, text);
    setActions((res && res.actions) || []);
    setErrors((res && res.errors) || []);
    // action 改动可能改变 ${VAR} 引用，刷新计数
    GetVarReferenceCounts()
      .then((m) => setVarRefCounts(m ?? {}))
      .catch(() => {});
  };

  // addPreset：把当前 formValues 存为 currentId 动作的 preset（同名覆盖）。
  // valuesOverride：非表单路径（logcat 甲板）传完整参数集，优先生于 formValues——
  // 甲板不在 form 视图，formValues 可能是别的动作或陈旧值。
  const addPreset = async (
    name: string,
    description: string,
    valuesOverride?: Record<string, string>,
  ) => {
    if (!currentId) return;
    const res = await AddPreset(
      currentId,
      name,
      description,
      normalizeArrayParams(actions.find((action) => action.id === currentId)?.params ?? [], valuesOverride ?? formValues),
    );
    setActions((res && res.actions) || []);
    setErrors((res && res.errors) || []);
  };

  const setFormValue = (id: string, value: string) =>
    setFormValues((prev) => ({ ...prev, [id]: value }));

  const setWorkflowFormValue = (id: string, value: string) =>
    setWorkflowFormValues((prev) => ({ ...prev, [id]: value }));

  // 改当前 AI 任务草稿的一个键（聊天页 composer / chips / 运行记录回填共用）
  const setAiDraftValue = (key: string, value: string | undefined) => {
    if (currentId) patchAiDraft(currentId, { [key]: value });
  };

  const pickDirectory = async () => {
    const p = await PickDirectory();
    return p || "";
  };

  const pickFile = async () => {
    const p = await PickFile();
    return p || "";
  };

  const openActionsDir = async () => {
    await OpenActionsDir();
  };

  const cancel = () => {
    if (!currentId) return;
    // 会话页停的是 AI 任务；output / logcat 视图停的是 action
    if (displayedAiRef.current === currentId) CancelAi(currentId);
    else CancelAction(currentId);
  };

  // rerun：用上次 params 原样重跑，自动判断 action / workflow / ai
  const rerun = (id: string) => {
    const aiTask = aiTasks.find((t) => t.id === id);
    if (aiTask) {
      // 上次实际发送的参数原样重放，不写回草稿（其中的 resume 只属于那一次运行）
      const sent = lastRunParams[id] ?? {};
      const overlay: AiDraft = { ...aiDraftsRef.current[id], ...sent };
      if (!(AI_RESUME in sent)) delete overlay[AI_RESUME];
      void startAi(aiTask, overlay, false);
      return;
    }
    const params = lastRunParams[id] ?? {};
    if (workflows.find((w) => w.id === id)) {
      runWorkflow(id, params);
    } else {
      runAction(id, params, false, lastLiteralKeysRef.current[id] ?? []);
    }
  };

  // editRerun：用上次 params 预填表单，让用户改后再跑
  const editRerun = (id: string) => {
    // ai：草稿就是表单（上次发送用的值还在草稿里），回会话页改了再发
    if (aiTasks.some((t) => t.id === id)) {
      openAiChat(id);
      return;
    }
    const params = lastRunParams[id] ?? {};
    const wf = workflows.find((w) => w.id === id);
    if (wf) {
      // workflow → 表单抽屉（lastRunParams 预填）
      const vals: Record<string, string> = {};
      wf.params?.forEach((p) => { vals[p.id] = params[p.id] ?? p.default ?? ""; });
      setWorkflowFormValues(vals);
      setCurrentId(id);
      setSelectedPreset(null);
      setStatus("idle");
      setExitInfo(null);
      setFormSheetOpen(true);
    } else {
      // action → 表单抽屉（走 selectPreset 逻辑，但用 lastRunParams 覆盖 defaults）
      const a = actions.find((x) => x.id === id);
      if (!a) return;
      const vals: Record<string, string> = {};
      a.params?.forEach((spec) => { vals[spec.id] = params[spec.id] ?? spec.default ?? ""; });
      setFormValues(vals);
      setCurrentId(id);
      setSelectedPreset(null);
      setStatus("idle");
      setExitInfo(null);
      setFormSheetOpen(true);
    }
  };

  const clearOutput = () => {
    setLines([]);
    resetSeqState();
  };

  // 清空：本地缓冲/读数即刻归零；运行中则 reset=true 下发——后端同步清 raw ring
  //（此后只见增量），并回一帧 head 空重放（读数归零的服务端确认）。
  const clearLogcat = () => {
    logcatBufferRef.current = [];
    setLogcatEntries([]);
    setLogcatStats({ matched: 0, total: 0 });
    setLogcatTagHist([]);
    setLogcatReplaceSeq(0);
    setLogcatFilterError("");
    if (currentId && runningIdsRef.current.has(currentId)) {
      UpdateLogcatFilter(currentId, toApiRule(logcatRule), true).catch((e: unknown) =>
        setLogcatFilterError(e instanceof Error ? e.message : String(e)),
      );
    }
  };

  // 整段复制：文本/进度行照旧，树块展开为缩进文本形态（title + │├└ 连接线行）
  const copyOutput = async () => {
    const text = linesRef.current
      .map((item) => (item.kind === "tree" ? treeFrameToText(item.frame) : item.text))
      .join("\n");
    await navigator.clipboard.writeText(text);
  };

  const value: RunnerContextValue = {
    actions,
    errors,
    currentId,
    selectedPreset,
    lines,
    status,
    isRunning: (id: string) => runningIds.has(id) || aiRunningIds.has(id) || !!aiHolders[id],
    exitInfo,
    globalConfig,
    varRefCounts,
    formValues,
    view,
    aiText,
    thinkingText,
    sentPrompt,
    sentAt,
    aiPanel,
    aiDiag,
    runsRevision,
    listRuns,
    getRun,
    getRunEvents,
    resumeRun,
    stopRun,
    openRuns,
    openRun,
    closeRun,
    currentRunId,
    runsFilter,
    setRunsFilter,
    openScheduleForm,
    closeScheduleForm,
    scheduleEditor,
    logcatEntries,
    logcatRule,
    setLogcatRule,
    logcatStats,
    logcatTagHist,
    logcatReplaceSeq,
    logcatFilterError,
    clearLogcat,
    fragments,
    fragmentsOpen,
    setFragmentsOpen,
    toggleFragments,
    formSheetOpen,
    setFormSheetOpen,
    workflows,
    workflowErrors,
    schedules,
    scheduleErrors,
    refreshSchedules,
    saveSchedule,
    deleteSchedule,
    setScheduleEnabled,
    runScheduleNow,
    workflowSteps,
    wfStartedAt,
    workflowFormValues,
    runningWorkflowId,
    usage,
    runAction,
    lastRunParams,
    rerun,
    editRerun,
    aiTasks,
    aiErrors,
    aiDraft,
    setAiDraftValue,
    runAi,
    isAiRunning: (id: string) => aiRunningIds.has(id) || !!aiHolders[id],
    focusAi,
    openAiChat,
    focusRunning,
    focusWorkflow,
    openYamlEditor,
    cancel,
    clearOutput,
    copyOutput,
    selectPreset,
    saveGlobalConfig,
    saveFragments,
    setView,
    setFormValue,
    setWorkflowFormValue,
    pickDirectory,
    pickFile,
    openActionsDir,
    getActionYaml,
    saveActionYaml,
    addPreset,
    runWorkflow,
    cancelWorkflow,
    selectWorkflow,
    getWorkflowYaml,
    saveWorkflowYaml,
    getAiYaml,
    saveAiYaml,
  };

  return (
    <RunnerContext.Provider value={value}>{children}</RunnerContext.Provider>
  );
}
