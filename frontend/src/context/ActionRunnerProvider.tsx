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
} from "../types/events";

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
  | "llm"
  | "fragments"
  | "edit"
  | "workflow"
  | "workflow-form"
  | "workflow-edit"
  | "settings"
  | "actions-grid";

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
  fragments: Fragment[];
  // workflow 状态
  workflows: WorkflowItem[];
  workflowErrors: string[];
  workflowSteps: WorkflowStepState[];
  workflowFormValues: Record<string, string>;
  runAction: (id: string, params?: Record<string, any>) => Promise<void>;
  // 把 id 切回 currentId 并切视图（用于点侧栏"运行中的动作"回到其输出）
  focusRunning: (id: string, targetView: "output" | "llm") => void;
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
  openActionsDir: () => Promise<void>;
  getActionYaml: (id: string) => Promise<string>;
  saveActionYaml: (id: string, text: string) => Promise<void>;
  addPreset: (name: string, description: string) => Promise<void>;
  runWorkflow: (id: string, params?: Record<string, any>) => Promise<void>;
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

  const runAction = async (id: string, params: Record<string, any> = {}) => {
    setLines([]);
    setCurrentId(id);
    setStatus("running");
    setExitInfo(null);
    setSelectedPreset(null);
    setRunningIds((prev) => new Set(prev).add(id));
    const action = actions.find((a) => a.id === id);
    if (action?.stream === "llm") {
      setLlmText("");
      setThinkingText("");
      setView("llm");
    } else {
      setView("output");
    }
    // 注册持久 done 订阅：无论用户是否切走，done 回调都能正确标记该 id 结束
    registerActionDone(id);
    try {
      await RunAction(id, params);
    } catch (e) {
      setLines((prev) => [...prev, t("error.startFailed") + ": " + e]);
      setStatus("error");
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

  // focusRunning：把仍在运行的 id 切回当前视图（点击侧栏运行中动作用）。
  // 重置 status=running 与 exitInfo=null，让 UI 显示「运行中」而不是上次运行的完成态。
  const focusRunning = (id: string, targetView: "output" | "llm") => {
    setCurrentId(id);
    setStatus("running");
    setExitInfo(null);
    setSelectedPreset(null);
    setLines([]); // 单缓冲已被覆盖，保留会误导
    if (targetView === "llm") {
      setLlmText("");
      setThinkingText("");
    }
    setView(targetView);
  };

  // runWorkflow：先同步订阅事件再启动执行，确保不漏首帧
  const runWorkflow = async (id: string, params: Record<string, any> = {}) => {
    setWorkflowSteps([]);
    setCurrentId(id);
    setSelectedPreset(null);
    setStatus("running");
    setExitInfo(null);
    setView("workflow");
    workflowIdRef.current = id;
    subscribeWorkflow(id);
    try {
      await RunWorkflow(id, params);
    } catch {
      setStatus("error");
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

  const openActionsDir = async () => {
    await OpenActionsDir();
  };

  const cancel = () => {
    if (currentId) CancelAction(currentId);
  };

  const clearOutput = () => setLines([]);

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
    fragments,
    workflows,
    workflowErrors,
    workflowSteps,
    workflowFormValues,
    runAction,
    focusRunning,
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
