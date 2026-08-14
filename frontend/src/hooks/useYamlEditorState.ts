import { useCallback, useEffect, useRef, useState } from "react";
import { parseAllDocuments } from "yaml";

// 把任意 catch 到的错误转成字符串（Wails 可能抛 string 或 Error）。
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export interface YamlEditorItem {
  id: string;
  title: string;
}

export interface UseYamlEditorStateArgs {
  items: YamlEditorItem[];
  currentId: string | null;
  getYaml: (id: string) => Promise<string>;
  saveYaml: (id: string, text: string) => Promise<void>;
  /** 保存成功后的提示文案（已保存，下次运行生效 等），由调用方按 i18n 传入。 */
  savedNotice?: string;
}

export interface YamlEditorState {
  editingId: string | null;
  setEditingId: (id: string) => void;
  text: string;
  setText: (next: string) => void;
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  notice: string | null;
  parseError: string | null;
  save: () => Promise<void>;
  reset: () => Promise<void>;
}

// YAML 编辑状态机（与 UI 解耦）：editingId 切换拉取原文、编辑标 dirty、保存写盘清 dirty、
// 失败置 error。effect 仅依赖 editingId，getYaml/saveYaml 由 Provider 每次渲染产生新引用，
// 故用 ref 取最新实现而不入 deps——这是「Provider 重渲染不覆盖未保存编辑」回归的关键
// （参见原 ActionYamlEditor 的同一豁免约定）。
export function useYamlEditorState({
  items,
  currentId,
  getYaml,
  saveYaml,
  savedNotice,
}: UseYamlEditorStateArgs): YamlEditorState {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [text, setTextState] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // items 到达后初始化 editingId（currentId 优先，否则首个）。useState 初始值只能是 null，
  // 用 render-time setState 模式（参见 GlobalConfigEditor、React「You Might Not Need an Effect」）。
  if (!editingId && items.length > 0) {
    setEditingId(currentId ?? items[0].id);
  }

  // getYaml/saveYaml/savedNotice 由 Provider 透传 binding，每次渲染新引用；行为稳定，故 ref 取最新。
  // 这是「最新值 ref」模式：effect 仅依赖 editingId，避免 Provider 重渲染重跑 effect 覆盖编辑。
  const getYamlRef = useRef(getYaml);
  // eslint-disable-next-line react-hooks/refs
  getYamlRef.current = getYaml;
  const saveYamlRef = useRef(saveYaml);
  // eslint-disable-next-line react-hooks/refs
  saveYamlRef.current = saveYaml;
  const savedNoticeRef = useRef(savedNotice);
  // eslint-disable-next-line react-hooks/refs
  savedNoticeRef.current = savedNotice;

  // editingId 变化时拉取原文。仅依赖 editingId，避免 Provider 重渲染覆盖未保存编辑。
  useEffect(() => {
    if (!editingId) return;
    let cancelled = false;
    // fetch 前同步置 loading/清错：React 19 set-state-in-effect 对「同步置 loading 后
    // 异步取数据」场景豁免（参见原 ActionYamlEditor 同一约定）。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    setNotice(null);
    getYamlRef
      .current(editingId)
      .then((raw) => {
        if (cancelled) return;
        setTextState(raw);
        setDirty(false);
      })
      .catch((e) => {
        if (!cancelled) setError(errMsg(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editingId]);

  const setText = useCallback((next: string) => {
    setTextState(next);
    setDirty(true);
    setNotice(null);
  }, []);

  const reset = useCallback(async () => {
    if (!editingId) return;
    setError(null);
    setNotice(null);
    try {
      const raw = await getYamlRef.current(editingId);
      setTextState(raw);
      setDirty(false);
    } catch (e) {
      setError(errMsg(e));
    }
  }, [editingId]);

  const save = useCallback(async () => {
    if (!editingId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await saveYamlRef.current(editingId, text);
      setDirty(false);
      if (savedNoticeRef.current) setNotice(savedNoticeRef.current);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  }, [editingId, text]);

  // 前端实时 YAML 校验（小文件，每次 text 变更即解析）。仅取首条错误文案供状态栏展示，
  // 行内诊断由 CodeMirror linter 扩展独立完成（定位到具体行）。
  let parseError: string | null = null;
  if (text.trim() !== "") {
    try {
      const docs = parseAllDocuments(text);
      for (const d of docs) {
        if (d.errors.length > 0) {
          parseError = d.errors[0].message;
          break;
        }
      }
    } catch {
      parseError = null;
    }
  }

  return {
    editingId,
    setEditingId,
    text,
    setText,
    dirty,
    loading,
    saving,
    error,
    notice,
    parseError,
    save,
    reset,
  };
}
