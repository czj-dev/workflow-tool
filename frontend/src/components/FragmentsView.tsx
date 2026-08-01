import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useActionRunner } from "../hooks/useActionRunner";

interface FragmentRow {
  title: string;
  content: string;
  tags: string; // 逗号分隔的字符串，保存时转 []string
}

// 把 ${VAR} 按 globalConfig 替换，未命中保留原样
function expand(content: string, vars: Record<string, string>): string {
  return content.replace(/\$\{([A-Za-z0-9_]+)\}/g, (m, k) => vars[k] ?? m);
}

// ─── 使用视图：按 tag 分组，展示预览+复制 ─────────────────────────────

function UseView() {
  const { t } = useTranslation();
  const { fragments, globalConfig } = useActionRunner();
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  // 按 tag 分组，无 tag 归入「未分类」
  const groups = useMemo(() => {
    const map = new Map<string, number[]>();
    fragments.forEach((f, i) => {
      const tags = f.tags?.length ? f.tags : [t("fragments.uncategorized")];
      tags.forEach((tag) => {
        const list = map.get(tag) ?? [];
        list.push(i);
        map.set(tag, list);
      });
    });
    return map;
  }, [fragments, t]);

  const copyOne = async (i: number) => {
    const text = expand(fragments[i].content, globalConfig);
    await navigator.clipboard.writeText(text);
    setCopiedIdx(i);
    setTimeout(() => setCopiedIdx((cur) => (cur === i ? null : cur)), 1200);
  };

  if (fragments.length === 0) {
    return (
      <div className="p-4">
        <p className="text-sm text-muted-foreground">{t("fragments.empty")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 overflow-auto p-4">
      {Array.from(groups.entries()).map(([tag, idxs]) => (
        <section key={tag} className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {tag}
          </h3>
          <div className="flex flex-col gap-2">
            {idxs.map((i) => {
              const f = fragments[i];
              const preview = expand(f.content, globalConfig);
              return (
                <div
                  key={i}
                  className="flex flex-col gap-1 rounded-md border p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      {f.title || t("fragments.untitled")}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => copyOne(i)}
                    >
                      {copiedIdx === i
                        ? t("fragments.copied")
                        : t("fragments.copy")}
                    </Button>
                  </div>
                  <pre className="whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">
                    {preview}
                  </pre>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// ─── 编辑视图：CRUD + 保存 ─────────────────────────────────────────────

function EditView() {
  const { t } = useTranslation();
  const { fragments, saveFragments } = useActionRunner();
  const [rows, setRows] = useState<FragmentRow[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) {
      setRows(
        fragments.map((f) => ({
          title: f.title,
          content: f.content,
          tags: (f.tags ?? []).join(", "),
        }))
      );
    }
  }, [fragments, dirty]);

  const update = (i: number, field: keyof FragmentRow, v: string) => {
    setRows((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, [field]: v } : r))
    );
    setDirty(true);
  };

  const add = () => {
    setRows((prev) => [...prev, { title: "", content: "", tags: "" }]);
    setDirty(true);
  };

  const remove = (i: number) => {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
    setDirty(true);
  };

  const save = async () => {
    const list = rows
      .filter((r) => r.title.trim() || r.content.trim())
      .map((r) => ({
        title: r.title.trim(),
        content: r.content,
        tags: r.tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      }));
    await saveFragments(list);
    setDirty(false);
  };

  return (
    <>
      <div className="flex items-center justify-end gap-2 border-b px-4 py-2">
        <Button size="sm" onClick={add}>
          {t("fragments.add")}
        </Button>
        <Button size="sm" disabled={!dirty} onClick={save}>
          {t("fragments.save")}
        </Button>
      </div>
      <div className="flex flex-col gap-3 overflow-auto p-4">
        {rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t("fragments.empty")}
          </p>
        )}
        {rows.map((r, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex gap-2">
              <Input
                value={r.title}
                onChange={(e) => update(i, "title", e.target.value)}
                placeholder={t("fragments.titlePlaceholder")}
                className="flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => remove(i)}
              >
                {t("fragments.remove")}
              </Button>
            </div>
            <Textarea
              value={r.content}
              onChange={(e) => update(i, "content", e.target.value)}
              placeholder={t("fragments.contentPlaceholder")}
              rows={3}
            />
            <Input
              value={r.tags}
              onChange={(e) => update(i, "tags", e.target.value)}
              placeholder={t("fragments.tagsPlaceholder")}
            />
          </div>
        ))}
      </div>
    </>
  );
}

// ─── 主容器：使用/编辑 切换 ────────────────────────────────────────────

export function FragmentsView() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"use" | "edit">("use");

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <span className="font-semibold">{t("fragments.title")}</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setMode((m) => (m === "use" ? "edit" : "use"))}
        >
          {mode === "use" ? t("fragments.edit") : t("fragments.done")}
        </Button>
      </header>
      {mode === "use" ? <UseView /> : <EditView />}
    </main>
  );
}
