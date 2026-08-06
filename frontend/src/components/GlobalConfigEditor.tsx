import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { Add01Icon, Delete02Icon, FloppyDiskIcon } from "@hugeicons/core-free-icons";
import { IconButton } from "./IconButton";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { useActionRunner } from "../hooks/useActionRunner";
import { cn } from "@/lib/utils";

// 全局配置编辑：key=value 配置表（变量名 mono 等宽，= 赋值符呼应控制台）。
// 每行右侧标「引用计数」——变量被多少处引用（×N，含 actions + 片段），未使用则 —，
// 把「定义点」与 actions/片段的「引用点」在心智上连起来。重复键即时红 ring 提示。
// header 与 FragmentsView 同构。
export function GlobalConfigEditor() {
  const { t } = useTranslation();
  const { globalConfig, varRefCounts, saveGlobalConfig } = useActionRunner();
  const [rows, setRows] = useState<{ key: string; value: string }[]>(
    () => Object.entries(globalConfig).map(([key, value]) => ({ key, value }))
  );
  const [dirty, setDirty] = useState(false);

  // globalConfig（异步）加载后同步 rows：render-time 调整，未编辑时才同步，避免覆盖用户改动
  const [prevConfig, setPrevConfig] = useState(globalConfig);
  if (globalConfig !== prevConfig) {
    setPrevConfig(globalConfig);
    if (!dirty) {
      setRows(Object.entries(globalConfig).map(([key, value]) => ({ key, value })));
    }
  }

  // 重复键：trim 后同名 key 出现 >1 次
  const dupKeys = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = r.key.trim();
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return new Set(
      [...counts.entries()].filter(([, c]) => c > 1).map(([k]) => k),
    );
  }, [rows]);

  const update = (i: number, field: "key" | "value", v: string) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: v } : r)));
    setDirty(true);
  };
  const add = () => {
    setRows((prev) => [...prev, { key: "", value: "" }]);
    setDirty(true);
  };
  const remove = (i: number) => {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
    setDirty(true);
  };
  const save = async () => {
    const kv: Record<string, string> = {};
    rows.forEach((r) => {
      if (r.key.trim()) kv[r.key.trim()] = r.value;
    });
    await saveGlobalConfig(kv);
    setDirty(false);
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <span className="font-semibold">{t("global.title")}</span>
        </div>
        <div className="flex items-center gap-1">
          <IconButton icon={Add01Icon} label={t("global.add")} variant="outline" onClick={add} />
          <span className="relative">
            <IconButton
              icon={FloppyDiskIcon}
              label={t("global.save")}
              variant={dirty ? "default" : "outline"}
              disabled={!dirty}
              onClick={save}
            />
            {dirty && (
              <span className="live-pulse pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary" />
            )}
          </span>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-3 overflow-auto p-4">
        <p className="font-mono text-[11px] leading-relaxed text-muted-foreground/80">
          {t("global.desc")}
        </p>

        {rows.length === 0 ? (
          <Empty>
            <EmptyDescription>{t("global.empty")}</EmptyDescription>
            <code className="font-mono text-[11px] text-muted-foreground/50">
              # {t("global.example")}
            </code>
          </Empty>
        ) : (
          // 配置表：整体 border，行间 divide-y；Input 去边框融入行，key 列 mono 等宽
          <div className="overflow-hidden rounded-lg border">
            <div className="divide-y divide-border">
              {rows.map((r, i) => {
                const k = r.key.trim();
                const isDup = k !== "" && dupKeys.has(k);
                const ref = k ? varRefCounts[k] ?? 0 : 0;
                return (
                  <div
                    key={i}
                    className="group/row flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-muted/40"
                  >
                    {/* key：琥珀标签 chip，让变量名有容器感（重复时转红） */}
                    <Input
                      className={cn(
                        "h-8 w-44 flex-none rounded-md border-0 font-mono text-xs uppercase tracking-wide shadow-none focus-visible:ring-1 focus-visible:ring-ring/40",
                        isDup
                          ? "bg-destructive/10 text-destructive ring-1 ring-destructive/40"
                          : "bg-primary/10 text-primary",
                      )}
                      value={r.key}
                      onChange={(e) => update(i, "key", e.target.value)}
                      placeholder={t("global.keyPlaceholder")}
                    />
                    {/* value：透明融入行，焦点才显 ring */}
                    <Input
                      className="h-8 flex-1 border-0 bg-transparent px-2 font-mono text-xs shadow-none focus-visible:ring-1 focus-visible:ring-ring/40"
                      value={r.value}
                      onChange={(e) => update(i, "value", e.target.value)}
                      placeholder={t("global.valuePlaceholder")}
                    />
                    {/* 变量回路 badge：被引用次数 / 未使用 / 重复键名 */}
                    <Badge
                      variant={isDup ? "destructive" : "default"}
                      className={cn(
                        "flex-none font-mono text-[10px] tabular-nums",
                        !isDup &&
                          (ref > 0
                            ? "bg-primary/10 text-primary"
                            : "bg-muted text-muted-foreground/50"),
                      )}
                    >
                      {isDup ? t("global.dup") : ref > 0 ? t("global.refCount", { count: ref }) : t("global.unused")}
                    </Badge>
                    <IconButton
                      icon={Delete02Icon}
                      label={t("global.remove")}
                      className="text-muted-foreground/50 transition-colors hover:text-destructive"
                      onClick={() => remove(i)}
                    />
                  </div>
                );
              })}
            </div>
            {dupKeys.size > 0 && (
              <div className="border-t bg-destructive/5 px-3 py-1.5 font-mono text-[10px] text-destructive">
                {t("global.dupHint")}
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
