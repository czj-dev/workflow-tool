import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";

// 把任意 catch 到的错误转成字符串（Wails 可能抛 string 或 Error）。
function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

// Action yaml 原文编辑器：Select 切换动作 + Textarea 编辑原文 + 保存写盘热重载。
// 切换动作自动丢弃未保存改动（按需求不弹确认）。
export function ActionYamlEditor() {
  const { t } = useTranslation();
  const { actions, currentId, getActionYaml, saveActionYaml } = useActionRunner();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // actions 到达后初始化 editingId（currentId 优先，否则首个）。
  // actions 异步到达，useState 初始值只能是 null；用 render-time setState 模式
  // （参见 GlobalConfigEditor、React 官方「You Might Not Need an Effect」）挑默认值。
  if (!editingId && actions.length > 0) {
    setEditingId(currentId ?? actions[0].id);
  }

  // editingId 变化时拉取原文
  useEffect(() => {
    if (!editingId) return;
    let cancelled = false;
    // fetch 前先把状态切到 loading/清错：React 19 的 set-state-in-effect 规则对
    // 「同步置 loading 后异步取数据」允许例外（官方推荐用 reducer/库，本项目按既有约定豁免）。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    setNotice(null);
    getActionYaml(editingId)
      .then((raw) => {
        if (cancelled) return;
        setText(raw);
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
  }, [editingId, getActionYaml]);

  const onReset = async () => {
    if (!editingId) return;
    setError(null);
    setNotice(null);
    try {
      const raw = await getActionYaml(editingId);
      setText(raw);
      setDirty(false);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const onSave = async () => {
    if (!editingId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await saveActionYaml(editingId, text);
      setDirty(false);
      setNotice(t("edit.runAfterSave"));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  if (actions.length === 0) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b px-4 py-2">
          <SidebarTrigger />
          <span className="font-semibold">{t("edit.title")}</span>
        </header>
        <div className="p-4 text-muted-foreground">{t("edit.empty")}</div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <Select value={editingId ?? undefined} onValueChange={(v) => setEditingId(v)}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder={t("edit.placeholder")} />
            </SelectTrigger>
            <SelectContent>
              {actions.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!dirty || saving || loading}
            onClick={onReset}
          >
            {t("edit.reset")}
          </Button>
          <Button size="sm" disabled={!dirty || saving || loading} onClick={onSave}>
            {saving ? t("edit.saving") : t("edit.save")}
          </Button>
        </div>
      </header>
      <Textarea
        className="m-4 flex-1 resize-none font-mono text-xs"
        value={loading ? t("edit.loading") : text}
        readOnly={loading}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
      />
      {error && (
        <Alert variant="destructive" className="mx-4 mb-4">
          <AlertDescription className="whitespace-pre-wrap font-mono">
            {error}
          </AlertDescription>
        </Alert>
      )}
      {notice && !error && (
        <div className="mx-4 mb-4 text-sm text-muted-foreground">{notice}</div>
      )}
    </div>
  );
}
