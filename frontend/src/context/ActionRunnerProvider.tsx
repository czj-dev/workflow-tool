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
} from "../../bindings/workflow-tool/internal/api/service.js";
import type { ActionItem } from "../../bindings/workflow-tool/internal/api/models.js";
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
  runAction: (id: string) => Promise<void>;
  cancel: () => void;
  clearOutput: () => void;
  copyOutput: () => Promise<void>;
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

  // 按 currentId 订阅事件
  useEffect(() => {
    if (!currentId) return;
    const unsubs: Array<() => void> = [];

    const onOutput = (e: unknown) => {
      const d = (((e as { data?: unknown })?.data) || {}) as OutputEventData;
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

  const runAction = async (id: string) => {
    setLines([]);
    setCurrentId(id);
    setStatus("running");
    setExitInfo(null);
    try {
      await RunAction(id);
    } catch (e) {
      setLines((prev) => [...prev, t("error.startFailed") + ": " + e]);
      setStatus("error");
    }
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
    runAction,
    cancel,
    clearOutput,
    copyOutput,
  };

  return (
    <RunnerContext.Provider value={value}>{children}</RunnerContext.Provider>
  );
}
