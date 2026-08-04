import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { HugeiconsIcon } from "@hugeicons/react";
import { Edit02Icon } from "@hugeicons/core-free-icons";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";

function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

// Workflow YAML 编辑器：加载原文 → Textarea 编辑 → 保存写盘热重载。
export function WorkflowYamlEditor() {
  const { t } = useTranslation();
  const { workflows, currentId, getWorkflowYaml, saveWorkflowYaml, setView } =
    useActionRunner();

  const workflow = workflows.find((w) => w.id === currentId);

  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!currentId) return;
    let cancelled = false;
    // 同步置 loading 后异步取数据：与 ActionYamlEditor 同一豁免约定。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    setNotice(null);
    getWorkflowYaml(currentId)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  const onReset = async () => {
    if (!currentId) return;
    setError(null);
    setNotice(null);
    try {
      const raw = await getWorkflowYaml(currentId);
      setText(raw);
      setDirty(false);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const onSave = async () => {
    if (!currentId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await saveWorkflowYaml(currentId, text);
      setDirty(false);
      setNotice(t("edit.runAfterSave"));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <span className="font-semibold">
            {workflow?.title ?? t("sidebar.workflows")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="icon-sm"
            onClick={() => setView("workflow")}
            title={t("edit.exit")}
          >
            <HugeiconsIcon icon={Edit02Icon} strokeWidth={1.75} />
          </Button>
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
          setNotice(null);
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
    </main>
  );
}
