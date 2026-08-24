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
  GetWorkflowYaml,
  SetWorkflowYaml,
  UpdateLogcatFilter,
} from "../../bindings/workflow-tool/internal/api/service.js";
import type {
  ActionItem,
  WorkflowItem,
} from "../../bindings/workflow-tool/internal/api/models.js";
import type { Fragment } from "../../bindings/workflow-tool/internal/registry/models.js";
import { useLlmHistory, type LlmHistoryEntry } from "../hooks/useLlmHistory";
import {
  applyEvent,
  finalizePanel,
  parseToolEvent,
  EMPTY_PANEL_STATE,
  type LlmPanelState,
} from "../components/llm/reduceStream";
import { foldOutputLine } from "../lib/outputFold";
import { expandVars } from "../lib/vars";
import { ruleFromParams, sortHistogram } from "../lib/logcatRule";
import type {
  OutputEventData,
  DoneEventData,
  WorkflowStepState,
  LogcatEntry,
  LogcatReplaceFrame,
  LogcatRule,
} from "../types/events";
import { EMPTY_LOGCAT_RULE } from "../types/events";

// logcat 性能参数：state 缓冲上限 / 入站 ref 缓冲上限。
// logcat 启动常一次性倾倒整个 ring buffer（万级行），逐行 setState 会冻结 UI，
// 故 onOutput 仅压入 ref，由定时器按 MAX_LOGCAT 节流并入 state。
// 缓冲对齐后端 raw ring 容量（10k，spec 决策 6）：重放帧可整体落地不被截断。
const MAX_LOGCAT = 10000;
const MAX_LOGCAT_FLUSH = 12000;

type Status = "idle" | "running" | "done" | "error";
interface ExitInfo {
  exitCode: number;
  err: string;
  duration: string;
}

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
  | "llm-grid"
  | "llm-chat";

export interface RunnerContextValue {
  actions: ActionItem[];
  errors: string[];
  currentId: string | null;
  selectedPreset: string | null;
  lines: string[];
  status: Status;
  // 是否有任何后台正在运行的 id（供 sidebar 各 item 判断徽标）
  isRunning: (id: string) => boolean;
  exitInfo: ExitInfo | null;
  // Phase 3 新增
  globalConfig: Record<string, string>;
  varRefCounts: Record<string, number | undefined>;
  formValues: Record<string, string>;
  view: RunnerView;
  llmText: string;
  thinkingText: string;
  // 本轮发送的 prompt 快照（已展开 ${VAR}）与发送时刻：聊天页气泡回显用。
  // 放在 Provider 而非 LlmChatView 本地 state，才能在切走/切回（组件卸载重挂载）后保留。
  sentPrompt: string;
  sentAt: number | null;
  // LLM 输出面板归约态（思考/工具/回答工序段 + 终点读数）；llmText/thinkingText 保留供历史与轻量判断
  llmPanel: LlmPanelState;
  // LLM 运行历史（按 currentId 分桶，最新在前）+ 清空
  llmHistory: LlmHistoryEntry[];
  clearLlmHistory: () => void;
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
  clearLogcat: () => void;
  fragments: Fragment[];
  // 片段抽屉（非模态）：开合态与开关。会话内有效不落盘；⌘/Ctrl+K 热键在 Provider 内接，
  // 侧栏按钮/抽屉内关闭钮共用同一份状态，切视图不影响开合。
  fragmentsOpen: boolean;
  setFragmentsOpen: (v: boolean) => void;
  toggleFragments: () => void;
  // 参数表单抽屉（非模态，左侧，action / workflow 共用单实例）：开合态会话内有效不落盘。
  // selectPreset / selectWorkflow / editRerun 打开（主区视图原地不动，抽屉只是叠加）；
  // 前台点火（runAction / runWorkflow 非 background）与切走 currentId 的导航
  // （focusRunning / focusWorkflow / openLlmChat）关闭。内容按 currentId 从
  // actions / workflows 解析，故单实例重定向：开着时点其他项即替换内容。
  formSheetOpen: boolean;
  setFormSheetOpen: (v: boolean) => void;
  // workflow 状态
  workflows: WorkflowItem[];
  workflowErrors: string[];
  workflowSteps: WorkflowStepState[];
  // 本次前台运行起点（无运行后保留到下次点火，供仪表带读数）
  wfStartedAt: number | null;
  workflowFormValues: Record<string, string>;
  runningWorkflowId: string | null;
  runAction: (id: string, params?: Record<string, any>, background?: boolean) => Promise<void>;
  // 上次运行时实际使用的 params（按 id 索引，action / workflow 共用）。空对象表示无参运行过。
  // 存在即代表"跑过至少一次"，OutputToolbar / WorkflowView 据此显示再跑入口。
  lastRunParams: Record<string, Record<string, string>>;
  // 用 lastRunParams[id] 原样再跑（自动分派 action / workflow）
  rerun: (id: string) => void;
  // 用 lastRunParams[id] 预填表单并切到 form / workflow-form 视图，供用户改后再跑
  editRerun: (id: string) => void;
  // 打开某 LLM 卡片的聊天页空态
  openLlmChat: (id: string) => void;
  // 把 id 切回 currentId 并切视图（用于点侧栏"运行中的动作"回到其输出）
  focusRunning: (id: string, targetView: "output" | "llm-chat" | "logcat") => void;
  // 把仍在运行的 workflow 切回 workflow 视图（点侧栏运行中 workflow 用）
  focusWorkflow: (id: string) => void;
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
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [exitInfo, setExitInfo] = useState<ExitInfo | null>(null);
  const [globalConfig, setGlobalConfig] = useState<Record<string, string>>({});
  const [varRefCounts, setVarRefCounts] = useState<Record<string, number | undefined>>({});
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [view, setView] = useState<RunnerView>("output");
  const [llmText, setLlmText] = useState<string>("");
  const [thinkingText, setThinkingText] = useState<string>("");
  // 本轮发送快照（prompt 展开后文本 + 发送时刻）：随 runAction 写入，
  // focusRunning 切回运行中动作时随 llmText/llmPanel 一并保留，不再随组件卸载丢失
  // （原先是 LlmChatView 本地 state，外部点进运行中卡片时组件重挂载即丢失气泡回显）。
  const [sentPrompt, setSentPrompt] = useState<string>("");
  const [sentAt, setSentAt] = useState<number | null>(null);
  // ref 镜像：done 回调闭包捕获旧 state，改用 ref 拿最新 llm 文本用于历史写入
  const llmTextRef = useRef("");
  llmTextRef.current = llmText;
  const thinkingTextRef = useRef("");
  thinkingTextRef.current = thinkingText;
  // LLM 输出面板归约态 + 运行起点（事件时间轴 = Date.now() - 起点；done 时机段结算改用后端精确时长）
  const [llmPanel, setLlmPanel] = useState<LlmPanelState>(EMPTY_PANEL_STATE);
  const llmPanelRef = useRef(llmPanel);
  llmPanelRef.current = llmPanel;
  const llmRunStartRef = useRef(0);
  // LLM 历史（按 currentId 分桶）
  const { entries: llmHistory, append: appendLlmHistory, clear: clearLlmHistory } =
    useLlmHistory(currentId);
  // done 闭包由 currentId useEffect 捕获，读 actions/formValues 时闭包可能陈旧，用 ref
  const actionsRef = useRef<ActionItem[]>([]);
  actionsRef.current = actions;
  // logcat 条目缓冲与统一规则（按 currentId 单缓冲，runAction 时清空/重建）
  const [logcatEntries, setLogcatEntries] = useState<LogcatEntry[]>([]);
  const [logcatRule, setLogcatRuleState] = useState<LogcatRule>(EMPTY_LOGCAT_RULE);
  const [logcatStats, setLogcatStats] = useState({ matched: 0, total: 0 });
  const [logcatTagHist, setLogcatTagHist] = useState<Array<[string, number]>>([]);
  const [logcatReplaceSeq, setLogcatReplaceSeq] = useState(0);
  const setLogcatRule = (r: LogcatRule) => setLogcatRuleState(r);
  // logcat 入站缓冲：onOutput 高频回调只往 ref 压，不触发渲染；由下面的定时器批量并入 state。
  const logcatBufferRef = useRef<LogcatEntry[]>([]);
  // progress 原地刷新标记：上一条是 progress → 覆盖该行而非追加，模拟终端 \r 效果
  const lastWasProgressRef = useRef(false);
  // action 输出的 seq 重排态（见 outputFold 备注：Wails Event.Emit 到达顺序无保证，
  // 需要 nextSeq/pending 跨事件持续，故用 ref 而非随 lines 一起进 state）。
  // 每次开跑新 action 必须重置，否则残留的 nextSeq 会把新一轮输出全部误判为「还没轮到」。
  const seqStateRef = useRef({ nextSeq: 1, pending: new Map<number, OutputEventData>() });
  // 统一 seq 排序门（logcat/logcat-replace/stdout 共享同一序号空间）：乱序到达先挂
  // pending，轮到 nextSeq 再按序应用。replace 帧的正确性依赖它——head 帧清空必须
  // 晚于所有旧增量帧、早于自己的 chunk，而 Wails 事件到达顺序无保证。
  // 与 seqStateRef 同步重置（见 resetSeqState）。
  const seqGateRef = useRef({ nextSeq: 1, pending: new Map<number, OutputEventData>() });
  const resetSeqState = () => {
    seqStateRef.current = { nextSeq: 1, pending: new Map() };
    seqGateRef.current = { nextSeq: 1, pending: new Map() };
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
  // 与 openLlmChat 重置在写入 state 的同时登记 synced 引用：effect 发现规则与 synced
  // 同引用即不下发——初始规则后端已从同一 params 编译，重发只会多一次整体重放
  // （闪烁+滚动复位）；currentId 切到其他运行中动作时同理不误发。
  const logcatRuleSyncedRef = useRef<LogcatRule | null>(null);
  useEffect(() => {
    const id = currentId;
    if (!id || !runningIdsRef.current.has(id)) return;
    if (logcatRuleSyncedRef.current === logcatRule) return;
    const timer = setTimeout(() => {
      logcatRuleSyncedRef.current = logcatRule;
      UpdateLogcatFilter(id, toApiRule(logcatRule), false).catch(() => {
        // 下发失败（非法规则被后端拒 / 控制通道积压）：撤回 synced 登记，否则该规则
        // 被永久当作「已同步」，用户必须改成另一个规则才会再下发（表现为改了不生效）。
        if (logcatRuleSyncedRef.current === logcatRule)
          logcatRuleSyncedRef.current = null;
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
  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStepState[]>([]);
  // 本次前台运行起点（runWorkflow 点火时打点）：仪表带总 elapsed 读数用
  const [wfStartedAt, setWfStartedAt] = useState<number | null>(null);
  const [workflowFormValues, setWorkflowFormValues] = useState<
    Record<string, string>
  >({});
  const linesRef = useRef<string[]>([]);
  linesRef.current = lines;
  // 当前查看的 id（供持久 done 回调判断是否该更新可见 UI，不触发重渲染）
  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = currentId;
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
  // 当前正在运行的 workflow id（供 cancelWorkflow 使用，无需触发重渲染）
  const workflowIdRef = useRef<string | null>(null);
  // 正在运行中的 workflow id（持久标记，点其他 action 再点回来时仍能识别）
  const [runningWorkflowId, setRunningWorkflowId] = useState<string | null>(null);
  // 上次运行时实际使用的 params（action / workflow 共用一份，按 id 索引）
  const [lastRunParams, setLastRunParams] = useState<Record<string, Record<string, string>>>({});
  // ref 镜像：done 闭包按 [currentId] 捕获，读 state 会陈旧
  const lastRunParamsRef = useRef<Record<string, Record<string, string>>>({});
  lastRunParamsRef.current = lastRunParams;

  // 整窗口文件拖拽（Wails EnableFileDrop，见 main.go）：拖入文件/文件夹只取第一个路径，
  // 写入当前聚焦的 input/textarea；未聚焦任何输入框时静默忽略。覆盖 action 参数表单、
  // 全局配置、指令片段等所有文本输入，不需要每个组件单独接 HTML5 drop（那套读不到真实路径）。
  useEffect(() => {
    return Events.On("file:dropped", (e: { data: { paths?: string[] } }) => {
      const path = e.data?.paths?.[0];
      if (!path) return;
      const el = document.activeElement;
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;
      // React 受控组件：直接赋值不会触发 onChange，需用原生 setter + dispatchEvent
      const proto =
        el instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter?.call(el, path);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }, []);

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
      if (d.stream === "step-start") {
        const idx = parseInt(d.line, 10);
        const now = Date.now();
        setWorkflowSteps((prev) => {
          const exists = prev.find((s) => s.index === idx);
          if (exists) {
            return prev.map((s) =>
              s.index === idx ? { ...s, status: "running" as const, startedAt: now } : s,
            );
          }
          return [...prev, { index: idx, status: "running" as const, lines: [], startedAt: now }];
        });
        return;
      }
      if (d.stream === "step-done") {
        const parts = (d.line || "").split(":");
        const idx = parseInt(parts[0], 10);
        const code = parseInt(parts[1], 10);
        const now = Date.now();
        setWorkflowSteps((prev) =>
          prev.map((s) =>
            s.index === idx
              ? { ...s, status: code === 0 ? ("done" as const) : ("error" as const), exitCode: code, endedAt: now }
              : s,
          ),
        );
        return;
      }
      if (d.stream === "step-skip") {
        const idx = parseInt(d.line, 10);
        setWorkflowSteps((prev) => {
          const exists = prev.find((s) => s.index === idx);
          if (exists) {
            return prev.map((s) =>
              s.index === idx ? { ...s, status: "skipped" as const } : s,
            );
          }
          return [...prev, { index: idx, status: "skipped" as const, lines: [] }];
        });
        return;
      }
      // stdout/stderr/progress：优先按后端下发的 step 索引落桶（规避 Wails 事件乱序，
      // 见 events.ts 的 step 字段注释）；无 step 字段时退回「最后一个 running」。
      setWorkflowSteps((prev) => {
        const idx = d.step ? parseInt(d.step, 10) : NaN;
        let list = prev;
        let target = Number.isNaN(idx)
          ? [...prev].reverse().find((s) => s.status === "running")
          : prev.find((s) => s.index === idx);
        // 输出先于 step-start 到达时补建桶（step-start 后续会把 status 覆写为 running）
        if (!target && !Number.isNaN(idx)) {
          target = { index: idx, status: "running" as const, lines: [] };
          list = [...prev, target];
        }
        if (!target) return prev;
        const folded = foldOutputLine(
          { lines: target.lines, lastWasProgress: target.lastWasProgress ?? false },
          d,
          { stderrPrefix: t("output.stderrPrefix") },
        );
        return list.map((s) =>
          s.index === target!.index
            ? { ...s, lines: folded.lines, lastWasProgress: folded.lastWasProgress }
            : s,
        );
      });
    };

    const onDone = (e: unknown) => {
      const d = (((e as { data?: unknown })?.data) || {}) as DoneEventData;
      setStatus(d.exitCode === 0 ? "done" : "error");
      setExitInfo(d);
      setRunningWorkflowId(null);
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

  useEffect(() => unsubscribeWorkflow, []);

  // 按 currentId 订阅事件
  useEffect(() => {
    if (!currentId) return;
    const unsubs: Array<() => void> = [];

    const onOutput = (e: unknown) => {
      const d = (((e as { data?: unknown })?.data) || {}) as OutputEventData;
      // 统一 seq 排序门后再分派：replace 帧的正确性依赖严格的到达顺序（见 seqGateRef
      // 注释）。无 seq（异常场景）直接应用，与旧行为一致。
      const apply = (d: OutputEventData) => {
        // LLM 三通道共用归约器维护面板工序段；atMs 用到达时刻相对运行起点
        const llmApply = (ev: ReturnType<typeof parseToolEvent>) => {
          if (ev)
            setLlmPanel((prev) =>
              applyEvent(prev, ev, Math.max(0, Date.now() - llmRunStartRef.current)),
            );
        };
        if (d.stream === "llm") {
          setLlmText((prev) => prev + (d.line || ""));
          llmApply({ kind: "text", delta: d.line || "" });
          return;
        }
        if (d.stream === "llm-thinking") {
          setThinkingText((prev) => prev + (d.line || ""));
          llmApply({ kind: "thinking", delta: d.line || "" });
          return;
        }
        if (d.stream === "llm-tool") {
          llmApply(parseToolEvent(d.line || ""));
          return;
        }
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
            },
            d,
            { stderrPrefix: t("output.stderrPrefix") },
          );
          lastWasProgressRef.current = folded.lastWasProgress;
          seqStateRef.current = {
            nextSeq: folded.nextSeq ?? 1,
            pending: folded.pending ?? new Map(),
          };
          return folded.lines;
        });
      };
      if (d.seq == null) {
        apply(d);
        return;
      }
      const gate = seqGateRef.current;
      gate.pending.set(d.seq, d);
      while (gate.pending.has(gate.nextSeq)) {
        const ev = gate.pending.get(gate.nextSeq)!;
        gate.pending.delete(gate.nextSeq);
        gate.nextSeq++;
        apply(ev);
      }
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
            { stderrPrefix: t("output.stderrPrefix") },
          );
          lastWasProgressRef.current = folded.lastWasProgress;
          seqStateRef.current = {
            nextSeq: folded.nextSeq ?? 1,
            pending: folded.pending ?? new Map(),
          };
          return folded.lines;
        });
      } else {
        setLines((prev) => [...prev, exitLine]);
      }
      setStatus(d.exitCode === 0 ? "done" : "error");
      setExitInfo(d);
      // LLM 历史写入：done 时把本轮 prompt/response/thinking 持久化到 localStorage
      const cur = actionsRef.current.find((a) => a.id === currentId);
      if (cur?.llm) {
        // 面板收尾：结算末段 + 写终点读数（后端 readout 优先，缺失字段不显示）
        const finalized = finalizePanel(llmPanelRef.current, {
          durationMs: d.readout?.durationMs,
          inputTokens: d.readout?.inputTokens,
          outputTokens: d.readout?.outputTokens,
          costUsd: d.readout?.costUsd,
          isError: d.exitCode !== 0,
        });
        setLlmPanel(finalized);
        const tools = finalized.segments
          .filter((s) => s.kind === "tool")
          .map((s) =>
            s.kind === "tool"
              ? {
                  id: s.id,
                  name: s.name,
                  summary: s.summary,
                  result: s.result,
                  isError: s.isError,
                  durationMs: s.durationMs ?? undefined,
                }
              : undefined,
          )
          .filter((t): t is NonNullable<typeof t> => t != null);
        const promptId = cur.llm.promptParam;
        // 用发送时快照而非当前表单值：防止流式期间编辑 textarea 导致历史记录漂移
        const sentParams = lastRunParamsRef.current[currentId] ?? {};
        appendLlmHistory({
          prompt: sentParams[promptId] ?? "",
          params: { ...sentParams },
          response: llmTextRef.current,
          thinking: thinkingTextRef.current,
          tools,
          // 会话 id 随历史持久化（历史查看态顶部展示，供 --resume 用）
          sessionId: d.readout?.sessionId,
          exitCode: d.exitCode,
          duration: d.duration,
        });
      }
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

  const runAction = async (id: string, params: Record<string, any> = {}, background = false) => {
    setLastRunParams((prev) => ({ ...prev, [id]: params as Record<string, string> }));
    setRunningIds((prev) => new Set(prev).add(id));
    const action = actions.find((a) => a.id === id);
    // 用 spec.default 回填未提供的参数：双击 / rerun / grid 静默运行等绕过表单的路径也带上默认值，
    // 避免命令里的 ${VAR} 被后端展开成空（后端不读 ParamSpec.Default，回填责任在前端）。
    // 仅补 undefined 的 key——表单路径已逐项写入值（含空串），不覆盖用户清空的意图。
    action?.params?.forEach((p) => {
      if (params[p.id] === undefined && p.default) params[p.id] = p.default;
    });
    // background=true（grid 卡片 run 按钮）：只登记 runningIds 驱动徽标，不切视图/不清输出，
    // 用户留在 grid 继续操作；要看输出就点卡片本体走前台路径（单缓冲不恢复是已知限制）。
    if (!background) {
      setLines([]);
      resetSeqState();
      setCurrentId(id);
      setStatus("running");
      setExitInfo(null);
      setSelectedPreset(null);
      // 点火即关表单抽屉：输出属于主区视图（output / logcat / llm-chat），不再有「发射态」。
      setFormSheetOpen(false);
      if (action?.llm) {
        setLlmText("");
        setThinkingText("");
        setLlmPanel(EMPTY_PANEL_STATE);
        llmRunStartRef.current = Date.now();
        // 冻结本轮 prompt 快照（展开 ${VAR} 后与后端 ExpandParams 一致）+ 发送时刻，
        // 供聊天页气泡回显；切走再切回（focusRunning）时随面板状态一并保留。
        const promptParam = action.llm.promptParam;
        setSentPrompt(expandVars((params[promptParam] as string) ?? "", params as Record<string, string>));
        setSentAt(Date.now());
        setView("llm-chat");
      } else if (action?.stream === "logcat") {
        logcatBufferRef.current = [];
        setLogcatEntries([]);
        // 把本次运行的服务端预过滤参数带入面板规则（映射见 ruleFromParams）。
        // 初始规则后端已从同一 params 编译，登记 synced 后防抖不再重复下发。
        const rule = ruleFromParams(params);
        logcatRuleSyncedRef.current = rule;
        setLogcatRuleState(rule);
        setLogcatStats({ matched: 0, total: 0 });
        setLogcatTagHist([]);
        setLogcatReplaceSeq(0);
        setView("logcat");
      } else {
        setView("output");
      }
    }
    // 注册持久 done 订阅：无论用户是否切走，done 回调都能正确标记该 id 结束（清 runningIds）
    registerActionDone(id);
    try {
      await RunAction(id, params);
    } catch (e) {
      // 后端判定该 action 已在运行（前端 runningIds 偶发与之不同步，
      // 或用户双击了运行中动作/预设）：此时上方的乐观状态
      // （currentId=id / status=running / 已入 runningIds / view 已切到 output|llm|logcat）
      // 恰好就是「回到运行视图」的目标态，直接保留——这样点运行中的动作会回到其输出界面
      // 且停止按钮可用，而不是把 UI 打成 error 并写一行「启动失败」。
      if (String(e).includes("正在运行")) {
        return;
      }
      if (!background) {
        setLines((prev) => [...prev, t("error.startFailed") + ": " + e]);
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

  // 为指定 workflow 注册持久 done 监听（grid 静默运行路径用）：只清 runningWorkflowId，
  // 不订阅 output、不切视图（与 subscribeWorkflow 的 done 各管一件事，键带 :persistent 不冲突）。
  const wfDoneUnsubs = useRef<Record<string, () => void>>({});
  const registerWorkflowDone = (id: string) => {
    wfDoneUnsubs.current[id]?.();
    const onDone = () => {
      setRunningWorkflowId(null);
      wfDoneUnsubs.current[id]?.();
      delete wfDoneUnsubs.current[id];
    };
    handlers[`workflow:${id}:done:persistent`] = onDone;
    const unsub = Events.On(`workflow:${id}:done`, onDone);
    wfDoneUnsubs.current[id] = () => {
      delete handlers[`workflow:${id}:done:persistent`];
      unsub();
    };
  };

  // focusRunning：把仍在运行的 id 切回当前视图（点击侧栏运行中动作用）。
  // 重置 status=running 与 exitInfo=null，让 UI 显示「运行中」而不是上次运行的完成态。
  const focusRunning = (
    id: string,
    targetView: "output" | "llm-chat" | "logcat",
  ) => {
    // 切回的是否就是当前 id：是则单缓冲仍是本动作的活数据（llm 面板/文本、行缓冲），
    // 从 grid/sidebar 点进来只是换视图，事件一直在往里写，必须原样保留；
    // 否则（切自另一个后台运行动作）单缓冲已被覆盖，本就无法恢复（已知单缓冲限制），才清空。
    const sameId = currentIdRef.current === id;
    // 导航去运行视图：表单抽屉随之关闭（内容按 currentId 取，不跟随切换）
    setFormSheetOpen(false);
    setCurrentId(id);
    setStatus("running");
    setExitInfo(null);
    setSelectedPreset(null);
    if (targetView === "llm-chat") {
      // LLM 面板/文本/prompt 快照：同 id 保留（会话信息回填），跨 id 才重置。
      if (!sameId) {
        setLines([]);
        resetSeqState();
        setLlmText("");
        setThinkingText("");
        setLlmPanel(EMPTY_PANEL_STATE);
        setSentPrompt("");
        setSentAt(null);
        llmRunStartRef.current = Date.now();
      }
    } else if (targetView === "logcat") {
      setLines([]); // 单缓冲已被覆盖，保留会误导
      resetSeqState();
      logcatBufferRef.current = [];
      setLogcatEntries([]);
      // 恢复该次运行实际使用的规则（全局单份，期间可能被其他 logcat 动作覆盖）。
      // 登记 synced 防止防抖重复下发本次直发。
      const rule = ruleFromParams(lastRunParamsRef.current[id]);
      logcatRuleSyncedRef.current = rule;
      setLogcatRuleState(rule);
      // 用恢复的规则触发一次后端整体重放：把切走期间丢失的单缓冲条目从 raw ring 找回。
      UpdateLogcatFilter(id, toApiRule(rule), false).catch(() => {});
    } else {
      setLines([]); // output 视图：单缓冲已被覆盖，保留会误导
      resetSeqState();
    }
    setView(targetView);
  };

  // openLlmChat：打开某 LLM 卡片的聊天页（空态）——设为当前、清上次输出缓冲、切 llm-chat。
  // 与 focusRunning("llm-chat") 的区别：那个是切回仍在跑的动作（status=running），这个是全新空态。
  const openLlmChat = (id: string) => {
    // 按 selectPreset 的同一优先级预填 formValues（default > 全局配置），否则上个动作的
    // 同名 param 值会残留到这张卡片（聊天页的 chip / composer 直接读 formValues）。
    const a = actions.find((x) => x.id === id);
    const vals: Record<string, string> = {};
    a?.params?.forEach((spec) => {
      vals[spec.id] = spec.default || globalConfig[spec.id] || "";
    });
    setFormValues(vals);
    setCurrentId(id);
    setSelectedPreset(null);
    setLines([]);
    resetSeqState();
    setLlmText("");
    setThinkingText("");
    setLlmPanel(EMPTY_PANEL_STATE);
    setSentPrompt("");
    setSentAt(null);
    logcatBufferRef.current = [];
    setLogcatEntries([]);
    logcatRuleSyncedRef.current = EMPTY_LOGCAT_RULE;
    setLogcatRuleState(EMPTY_LOGCAT_RULE);
    setLogcatStats({ matched: 0, total: 0 });
    setLogcatTagHist([]);
    setLogcatReplaceSeq(0);
    setStatus("idle");
    setExitInfo(null);
    setFormSheetOpen(false); // 进聊天页：表单抽屉关闭
    setView("llm-chat");
  };

  // focusWorkflow：切回仍在运行的 workflow，不清 steps（保留已跑到的进度）。
  // 与 focusRunning（action）语义类似，但不重置 status：workflow 的 status 由 done 事件更新，
  // 切回时若仍在跑，status 已是 "running"；若已完成，保留 done/error 徽标。
  const focusWorkflow = (id: string) => {
    setFormSheetOpen(false); // 导航去 workflow 视图：表单抽屉随之关闭
    setCurrentId(id);
    setSelectedPreset(null);
    setView("workflow");
  };

  // runWorkflow：先同步订阅事件再启动执行，确保不漏首帧。
  // background=true（grid 卡片 run 按钮）则不切视图/不订阅，仅登记徽标由 done 清理。
  const runWorkflow = async (id: string, params: Record<string, any> = {}, background = false) => {
    // 用 spec.default 回填未提供的参数（双击 / rerun / grid 静默运行），语义同 runAction。
    workflows.find((w) => w.id === id)?.params?.forEach((p) => {
      if (params[p.id] === undefined && p.default) params[p.id] = p.default;
    });
    setLastRunParams((prev) => ({ ...prev, [id]: params as Record<string, string> }));
    setRunningWorkflowId(id);
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
    } else {
      // grid 静默运行：不订阅 output、不切视图，仅注册持久 done 清 runningWorkflowId（驱动徽标）。
      registerWorkflowDone(id);
    }
    try {
      await RunWorkflow(id, params);
    } catch {
      if (!background) setStatus("error");
      setRunningWorkflowId(null);
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
    const vals: Record<string, string> = {};
    a.params?.forEach((spec) => {
      vals[spec.id] = spec.default || globalConfig[spec.id] || "";
    });
    if (p) Object.assign(vals, p.values);
    setFormValues(vals);
    setCurrentId(actionId);
    setSelectedPreset(presetName || null); // 记住选中的 preset，子项据此高亮、父项取消高亮
    // 进表单=准备新配置，清除上次运行的 status/exitInfo，避免选中动作残留 error/done 徽标
    setStatus("idle");
    setExitInfo(null);
    setFormSheetOpen(true);
  };

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
      valuesOverride ?? formValues,
    );
    setActions((res && res.actions) || []);
    setErrors((res && res.errors) || []);
  };

  const setFormValue = (id: string, value: string) =>
    setFormValues((prev) => ({ ...prev, [id]: value }));

  const setWorkflowFormValue = (id: string, value: string) =>
    setWorkflowFormValues((prev) => ({ ...prev, [id]: value }));

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
    if (currentId) CancelAction(currentId);
  };

  // rerun：用上次 params 原样重跑，自动判断 action / workflow
  const rerun = (id: string) => {
    const params = lastRunParams[id] ?? {};
    if (workflows.find((w) => w.id === id)) {
      runWorkflow(id, params);
    } else {
      runAction(id, params);
    }
  };

  // editRerun：用上次 params 预填表单，让用户改后再跑
  const editRerun = (id: string) => {
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
    if (currentId && runningIdsRef.current.has(currentId)) {
      UpdateLogcatFilter(currentId, toApiRule(logcatRule), true).catch(() => {});
    }
  };

  const copyOutput = async () => {
    await navigator.clipboard.writeText(linesRef.current.join("\n"));
  };

  const value: RunnerContextValue = {
    actions,
    errors,
    currentId,
    selectedPreset,
    lines,
    status,
    isRunning: (id: string) => runningIds.has(id),
    exitInfo,
    globalConfig,
    varRefCounts,
    formValues,
    view,
    llmText,
    thinkingText,
    sentPrompt,
    sentAt,
    llmPanel,
    llmHistory,
    clearLlmHistory,
    logcatEntries,
    logcatRule,
    setLogcatRule,
    logcatStats,
    logcatTagHist,
    logcatReplaceSeq,
    clearLogcat,
    fragments,
    fragmentsOpen,
    setFragmentsOpen,
    toggleFragments,
    formSheetOpen,
    setFormSheetOpen,
    workflows,
    workflowErrors,
    workflowSteps,
    wfStartedAt,
    workflowFormValues,
    runningWorkflowId,
    runAction,
    lastRunParams,
    rerun,
    editRerun,
    openLlmChat,
    focusRunning,
    focusWorkflow,
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
  };

  return (
    <RunnerContext.Provider value={value}>{children}</RunnerContext.Provider>
  );
}
