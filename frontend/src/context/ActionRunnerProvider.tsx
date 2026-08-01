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
  GetFragments,
  SetFragments,
  PickDirectory,
} from "../../bindings/workflow-tool/internal/api/service.js";
import type { ActionItem } from "../../bindings/workflow-tool/internal/api/models.js";
import type { Fragment } from "../../bindings/workflow-tool/internal/registry/models.js";
import type { OutputEventData, DoneEventData } from "../types/events";

type Status = "idle" | "running" | "done" | "error";
interface ExitInfo {
  exitCode: number;
  err: string;
  duration: string;
}

export interface RunnerContextValue {
  actions: ActionItem[];
  errors: string[];
  currentId: string | null;
  lines: string[];
  status: Status;
  exitInfo: ExitInfo | null;
  // Phase 3 新增
  globalConfig: Record<string, string>;
  formValues: Record<string, string>;
  view: "output" | "form" | "global" | "llm" | "fragments";
  llmText: string;
  thinkingText: string;
  fragments: Fragment[];
  runAction: (id: string, params?: Record<string, any>) => Promise<void>;
  cancel: () => void;
  clearOutput: () => void;
  copyOutput: () => Promise<void>;
  selectPreset: (actionId: string, presetName: string) => void;
  saveGlobalConfig: (kv: Record<string, string>) => Promise<void>;
  saveFragments: (list: Fragment[]) => Promise<void>;
  setView: (v: "output" | "form" | "global" | "llm" | "fragments") => void;
  setFormValue: (id: string, value: string) => void;
  pickDirectory: () => Promise<string>;
}

// 事件分发表：测试用 _emitForTest 触发；运行时由 Events.On 回调写入
const handlers: Record<string, (e: unknown) => void> = {};
// 测试辅助：模拟后端 emit 一个事件
export function _emitForTest(name: string, e: unknown) {
  handlers[name]?.(e);
}

export const RunnerContext = createContext<RunnerContextValue | null>(null);

export function ActionRunnerProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [exitInfo, setExitInfo] = useState<ExitInfo | null>(null);
  const [globalConfig, setGlobalConfig] = useState<Record<string, string>>({});
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [view, setView] = useState<
    "output" | "form" | "global" | "llm" | "fragments"
  >("output");
  const [llmText, setLlmText] = useState<string>("");
  const [thinkingText, setThinkingText] = useState<string>("");
  const [fragments, setFragments] = useState<Fragment[]>([]);
  const linesRef = useRef<string[]>([]);
  linesRef.current = lines;

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
    const action = actions.find((a) => a.id === id);
    if (action?.stream === "llm") {
      setLlmText("");
      setThinkingText("");
      setView("llm");
    } else {
      setView("output");
    }
    try {
      await RunAction(id, params);
    } catch (e) {
      setLines((prev) => [...prev, t("error.startFailed") + ": " + e]);
      setStatus("error");
    }
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
    setView("form");
  };

  const saveGlobalConfig = async (kv: Record<string, string>) => {
    await SetGlobalConfig(kv);
    setGlobalConfig(kv);
  };

  const saveFragments = async (list: Fragment[]) => {
    await SetFragments(list);
    setFragments(list);
  };

  const setFormValue = (id: string, value: string) =>
    setFormValues((prev) => ({ ...prev, [id]: value }));

  const pickDirectory = async () => {
    const p = await PickDirectory();
    return p || "";
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
    lines,
    status,
    exitInfo,
    globalConfig,
    formValues,
    view,
    llmText,
    thinkingText,
    fragments,
    runAction,
    cancel,
    clearOutput,
    copyOutput,
    selectPreset,
    saveGlobalConfig,
    saveFragments,
    setView,
    setFormValue,
    pickDirectory,
  };

  return (
    <RunnerContext.Provider value={value}>{children}</RunnerContext.Provider>
  );
}
