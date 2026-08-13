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
} from "../../bindings/workflow-tool/internal/api/service.js";
import type {
  ActionItem,
  WorkflowItem,
} from "../../bindings/workflow-tool/internal/api/models.js";
import type { Fragment } from "../../bindings/workflow-tool/internal/registry/models.js";
import type {
  OutputEventData,
  DoneEventData,
  WorkflowStepState,
  LogcatEntry,
  LogcatFilter,
} from "../types/events";

// logcat 性能参数：state 缓冲上限 / 入站 ref 缓冲上限。
// logcat 启动常一次性倾倒整个 ring buffer（万级行），逐行 setState 会冻结 UI，
// 故 onOutput 仅压入 ref，由定时器按 MAX_LOGCAT 节流并入 state。
const MAX_LOGCAT = 4000;
const MAX_LOGCAT_FLUSH = 8000;

type Status = "idle" | "running" | "done" | "error";
interface ExitInfo {
  exitCode: number;
  err: string;
  duration: string;
}

// 右栏视图枚举：OutputPanel 按此分派。原先在接口/useState/setView 三处重复，抽成单一来源。
export type RunnerView =
  | "output"
  | "form"
  | "global"
  | "logcat"
  | "fragments"
  | "edit"
  | "workflow"
  | "workflow-form"
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
  // logcat 视图：结构化条目缓冲（环形 ~5000）+ 运行时过滤
  logcatEntries: LogcatEntry[];
  logFilter: LogcatFilter;
  setLogFilter: (f: Partial<LogcatFilter>) => void;
  clearLogcat: () => void;
  fragments: Fragment[];
  // workflow 状态
  workflows: WorkflowItem[];
  workflowErrors: string[];
  workflowSteps: WorkflowStepState[];
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
  addPreset: (name: string, description: string) => Promise<void>;
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
  // logcat 条目缓冲与过滤（按 currentId 单缓冲，runAction 时清空）
  const [logcatEntries, setLogcatEntries] = useState<LogcatEntry[]>([]);
  const [logFilter, setLogFilterState] = useState<LogcatFilter>({
    minLevel: "V",
    search: "",
    tag: "",
  });
  // logcat 入站缓冲：onOutput 高频回调只往 ref 压，不触发渲染；由下面的定时器批量并入 state。
  const logcatBufferRef = useRef<LogcatEntry[]>([]);
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
    }, 120);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [fragments, setFragments] = useState<Fragment[]>([]);
  // workflow 状态：列表、加载错误、步骤运行状态
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  const [workflowErrors, setWorkflowErrors] = useState<string[]>([]);
  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStepState[]>([]);
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
        setWorkflowSteps((prev) => {
          const exists = prev.find((s) => s.index === idx);
          if (exists) {
            return prev.map((s) =>
              s.index === idx ? { ...s, status: "running" as const } : s,
            );
          }
          return [...prev, { index: idx, status: "running" as const, lines: [] }];
        });
        return;
      }
      if (d.stream === "step-done") {
        const parts = (d.line || "").split(":");
        const idx = parseInt(parts[0], 10);
        const code = parseInt(parts[1], 10);
        setWorkflowSteps((prev) =>
          prev.map((s) =>
            s.index === idx
              ? { ...s, status: code === 0 ? ("done" as const) : ("error" as const), exitCode: code }
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
      // stdout/stderr：追加到最后一个 running step
      const prefix = d.stream === "stderr" ? t("output.stderrPrefix") : "";
      const line = prefix + (d.line || "");
      setWorkflowSteps((prev) => {
        const lastRunning = [...prev].reverse().find((s) => s.status === "running");
        if (!lastRunning) return prev;
        return prev.map((s) =>
          s.index === lastRunning.index
            ? { ...s, lines: [...s.lines, line] }
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
      if (d.stream === "llm") {
        setLlmText((prev) => prev + (d.line || ""));
        return;
      }
      if (d.stream === "llm-thinking") {
        setThinkingText((prev) => prev + (d.line || ""));
        return;
      }
      if (d.stream === "logcat") {
        // line 是后端批量下发的 JSON 数组（偶发单对象兼容）；解析失败退化为单条原文。
        let parsed: unknown;
        try {
          parsed = JSON.parse(d.line || "");
        } catch {
          parsed = [{ date: "", time: "", pid: 0, tid: 0, level: "V", tag: "", message: d.line || "" }];
        }
        const arr = Array.isArray(parsed)
          ? (parsed as LogcatEntry[])
          : [parsed as LogcatEntry];
        // 仅压入 ref，由上面的 setInterval 批量并入 state，避免逐行渲染风暴。
        const buf = logcatBufferRef.current;
        for (const e of arr) {
          if (buf.length < MAX_LOGCAT_FLUSH) buf.push(e);
        }
        return;
      }
      const prefix = d.stream === "stderr" ? t("output.stderrPrefix") : "";
      setLines((prev) => [...prev, prefix + (d.line || "")]);
    };
    const onDone = (e: unknown) => {
      const d = (((e as { data?: unknown })?.data) || {}) as DoneEventData;
      const errSuffix = d.err ? t("output.errSuffix", { err: d.err }) : "";
      setLines((prev) => [
        ...prev,
        t("output.exitLine", { exitCode: d.exitCode, err: errSuffix }),
      ]);
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
      setCurrentId(id);
      setStatus("running");
      setExitInfo(null);
      setSelectedPreset(null);
      if (action?.llm) {
        setLlmText("");
        setThinkingText("");
        setView("llm-chat");
      } else if (action?.stream === "logcat") {
        logcatBufferRef.current = [];
        setLogcatEntries([]);
        // 把表单的服务端预过滤参数带到运行时面板：LEVEL→minLevel、TAG→tag、INCLUDE→search。
        // 服务端已按这些值过滤（减少 IPC），面板反映当前状态并可在其上进一步收窄；
        // TAG 按空白拆分任一命中（与后端 allow 一致），故多 tag 不会误隐藏。
        const lvlRaw = String(params.LEVEL ?? "").trim().toUpperCase();
        setLogFilterState({
          minLevel: lvlRaw && "VDIWEF".includes(lvlRaw[0]) ? lvlRaw[0] : "V",
          tag: String(params.TAG ?? ""),
          search: String(params.INCLUDE ?? ""),
        });
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
    setCurrentId(id);
    setStatus("running");
    setExitInfo(null);
    setSelectedPreset(null);
    setLines([]); // 单缓冲已被覆盖，保留会误导
    if (targetView === "llm-chat") {
      setLlmText("");
      setThinkingText("");
    } else if (targetView === "logcat") {
      logcatBufferRef.current = [];
      setLogcatEntries([]);
    }
    setView(targetView);
  };

  // openLlmChat：打开某 LLM 卡片的聊天页（空态）——设为当前、清上次输出缓冲、切 llm-chat。
  // 与 focusRunning("llm-chat") 的区别：那个是切回仍在跑的动作（status=running），这个是全新空态。
  const openLlmChat = (id: string) => {
    setCurrentId(id);
    setSelectedPreset(null);
    setLlmText("");
    setThinkingText("");
    setStatus("idle");
    setExitInfo(null);
    setView("llm-chat");
  };

  // focusWorkflow：切回仍在运行的 workflow，不清 steps（保留已跑到的进度）。
  // 与 focusRunning（action）语义类似，但不重置 status：workflow 的 status 由 done 事件更新，
  // 切回时若仍在跑，status 已是 "running"；若已完成，保留 done/error 徽标。
  const focusWorkflow = (id: string) => {
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
      setCurrentId(id);
      setSelectedPreset(null);
      setStatus("running");
      setExitInfo(null);
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

  // selectWorkflow：有 params → 预填表单切 workflow-form；无 params → 直接跑
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
    setView("workflow-form");
  };

  const cancelWorkflow = () => {
    if (workflowIdRef.current) CancelWorkflow(workflowIdRef.current);
  };

  // selectPreset：把预设值（+ 各 param 的 default 预填）填入 formValues，切到 form 视图。
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
    setView("form");
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
  const addPreset = async (name: string, description: string) => {
    if (!currentId) return;
    const res = await AddPreset(currentId, name, description, formValues);
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
      // workflow → workflow-form
      const vals: Record<string, string> = {};
      wf.params?.forEach((p) => { vals[p.id] = params[p.id] ?? p.default ?? ""; });
      setWorkflowFormValues(vals);
      setCurrentId(id);
      setSelectedPreset(null);
      setStatus("idle");
      setExitInfo(null);
      setView("workflow-form");
    } else {
      // action → form（走 selectPreset 逻辑，但用 lastRunParams 覆盖 defaults）
      const a = actions.find((x) => x.id === id);
      if (!a) return;
      const vals: Record<string, string> = {};
      a.params?.forEach((spec) => { vals[spec.id] = params[spec.id] ?? spec.default ?? ""; });
      setFormValues(vals);
      setCurrentId(id);
      setSelectedPreset(null);
      setStatus("idle");
      setExitInfo(null);
      setView("form");
    }
  };

  const clearOutput = () => setLines([]);

  const clearLogcat = () => {
    logcatBufferRef.current = [];
    setLogcatEntries([]);
  };

  const setLogFilter = (f: Partial<LogcatFilter>) =>
    setLogFilterState((prev) => ({ ...prev, ...f }));

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
    logcatEntries,
    logFilter,
    setLogFilter,
    clearLogcat,
    fragments,
    workflows,
    workflowErrors,
    workflowSteps,
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
