import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { fmtDuration } from "../lib/duration";
import { aiRunSummary, runDurationMs, targetList, targetTitle } from "../lib/runs";
import { useActionRunner } from "../hooks/useActionRunner";
import { RunStatusBadge, runDot } from "./GridCardParts";
import type { RunItem, RunListFilter } from "../types/events";
import { RUN_ORIGINS, RUN_STATUSES, RUN_TARGET_KINDS } from "../types/events";

// 运行记录列表（M3）：全部目标的运行，按时间倒序，可按目标 / 状态 / 来源筛选。
// 运行记录是后端的唯一真相：这里不缓存，runsRevision 变了（任何运行开始或结束）就重拉。
// 点一条进运行详情——全应用只有那一处查看运行过程。

const EYEBROW =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";

// 一次加载完成后的结果。key 是它对应的「筛选 + 版本」：与当前的不一致即说明正在加载
// （刷新期间旧列表照旧可见）——加载态由渲染时比较得出，不在 effect 里同步写 state。
type LoadState = { runs: RunItem[]; error: string; key: string | null };
const keyOf = (filter: RunListFilter, revision: number) => `${revision}|${JSON.stringify(filter ?? {})}`;

export function RunsView() {
  const { t } = useTranslation();
  const {
    runsRevision, listRuns, runsFilter, setRunsFilter, openRun,
    actions, workflows, aiTasks,
  } = useActionRunner();
  const [state, setState] = useState<LoadState>({ runs: [], error: "", key: null });
  const loading = state.key !== keyOf(runsFilter, runsRevision);

  useEffect(() => {
    let cancelled = false;
    const key = keyOf(runsFilter, runsRevision);
    // 成功：换上新的列表；失败：清空并报错。旧内容在这次加载返回前照旧可见（不清屏）。
    listRuns(runsFilter)
      .then((runs) => { if (!cancelled) setState({ runs, error: "", key }); })
      .catch((e: unknown) => {
        if (!cancelled) setState({ runs: [], error: e instanceof Error ? e.message : String(e), key });
      });
    return () => { cancelled = true; };
    // listRuns 是 context 上的函数，引用随 Provider 渲染变化；重拉只由筛选与失效信号触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runsFilter, runsRevision]);

  const patchFilter = (patch: Partial<typeof runsFilter>) => setRunsFilter({ ...runsFilter, ...patch });

  // 目标下拉只列当前种类下的目标（没限定种类时列动作）
  const targetOptions = targetList(runsFilter.targetKind ?? "action", { actions, workflows, aiTasks });

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <SidebarTrigger />
        <h1 className="flex-none text-sm font-semibold">{t("runs.title")}</h1>
        <span className="ml-auto font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground tabular-nums">
          {loading ? t("runs.loading") : t("runs.count", { count: state.runs.length })}
        </span>
      </header>

      {/* 筛选条：目标种类 + 目标 / 状态 / 来源 */}
      <div className="grid gap-2 border-b bg-muted/20 px-4 py-2.5">
        <FilterRow label={t("runs.filterTarget")}>
          <FilterChip pressed={!runsFilter.targetKind} onClick={() => patchFilter({ targetKind: "", targetId: "" })}>
            {t("runs.filterAll")}
          </FilterChip>
          {RUN_TARGET_KINDS.map((kind) => (
            <FilterChip
              key={kind}
              pressed={runsFilter.targetKind === kind}
              // 与状态 / 来源 chip 同一语义：再点一次取消该种类（「全部」chip 也是清除）
              onClick={() => patchFilter({ targetKind: runsFilter.targetKind === kind ? "" : kind, targetId: "" })}
            >
              {t(`scheduler.kind.${kind}`)}
            </FilterChip>
          ))}
          <Select
            value={runsFilter.targetId || "all"}
            onValueChange={(value) => patchFilter({ targetId: !value || value === "all" ? "" : String(value) })}
          >
            <SelectTrigger size="sm" className="h-7 min-w-40 max-w-64 text-xs" aria-label={t("runs.filterTarget")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("runs.allTargets")}</SelectItem>
              {targetOptions.map((target) => (
                <SelectItem key={target.id} value={target.id}>{target.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterRow>
        <FilterRow label={t("runs.filterStatus")}>
          <FilterChip pressed={!runsFilter.status} onClick={() => patchFilter({ status: "" })}>
            {t("runs.filterAll")}
          </FilterChip>
          {RUN_STATUSES.map((status) => (
            <FilterChip key={status} pressed={runsFilter.status === status} onClick={() => patchFilter({ status: runsFilter.status === status ? "" : status })}>
              {t(`runs.status.${status}`)}
            </FilterChip>
          ))}
        </FilterRow>
        <FilterRow label={t("runs.filterOrigin")}>
          <FilterChip pressed={!runsFilter.origin} onClick={() => patchFilter({ origin: "" })}>
            {t("runs.filterAll")}
          </FilterChip>
          {RUN_ORIGINS.map((origin) => (
            <FilterChip key={origin} pressed={runsFilter.origin === origin} onClick={() => patchFilter({ origin: runsFilter.origin === origin ? "" : origin })}>
              {t(`runs.origin.${origin}`)}
            </FilterChip>
          ))}
        </FilterRow>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {state.error && (
          <Alert variant="destructive" className="mb-3">
            <AlertDescription>{t("error.loadFailed")}: {state.error}</AlertDescription>
          </Alert>
        )}
        {!state.error && state.runs.length === 0 && !loading && (
          <Empty>
            <EmptyDescription>{t("runs.empty")}</EmptyDescription>
          </Empty>
        )}
        <ul className="flex flex-col gap-1.5">
          {state.runs.map((run) => (
            <RunRow key={run.id} run={run} onOpen={() => openRun(run.id)} />
          ))}
        </ul>
      </div>
    </main>
  );
}

function RunRow({ run, onOpen }: { run: RunItem; onOpen: () => void }) {
  const { t } = useTranslation();
  const { actions, workflows, aiTasks } = useActionRunner();
  const title = targetTitle(run.targetKind, run.targetId, { actions, workflows, aiTasks });
  const durationMs = runDurationMs(run);
  // 摘要：AI 运行是当次提示词；其余是有原因写原因（失败 / 跳过），没有就不占一行
  const summary = run.targetKind === "ai" ? aiRunSummary(run) : run.reason;
  const skipped = run.status === "skipped";
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${title} · ${t(`runs.status.${run.status}`, run.status)}`}
        className="flex w-full cursor-pointer items-start gap-3 rounded-lg border border-border bg-card/55 px-3 py-2 text-left
          transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:border-primary/60"
      >
        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${runDot(run.status)}`} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground/80">
              {t(`scheduler.kind.${run.targetKind}`)}
            </span>
            <span className="truncate text-sm font-medium">{title}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">{run.targetId}</span>
          </span>
          {summary && (
            <span className={`mt-0.5 block truncate text-xs ${skipped ? "text-muted-foreground" : "text-muted-foreground/90"}`}>
              {skipped && "⤬ "}{summary}
            </span>
          )}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
          <RunStatusBadge status={run.status} label={t(`runs.status.${run.status}`, run.status)} />
          <span>
            {run.startedAt && new Date(run.startedAt).toLocaleString()}
            {durationMs !== null && <span className="ml-1.5">· {fmtDuration(durationMs)}</span>}
          </span>
          {run.origin !== "manual" && (
            <span className="inline-flex items-center gap-1 text-[10.5px]">
              <HugeiconsIcon icon={Clock01Icon} strokeWidth={1.75} className="size-3" />
              {t(`runs.origin.${run.origin}`)}
              {run.scheduleId && <span className="text-muted-foreground/70">· {run.scheduleId}</span>}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`w-12 shrink-0 ${EYEBROW}`}>{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}

function FilterChip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`inline-flex h-7 cursor-pointer items-center rounded-full border-none px-2.5 font-mono text-[11.5px] tracking-[0.02em]
        transition-colors focus-visible:outline-none focus-visible:border-primary/60
        ${pressed
          ? "bg-primary/15 text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_35%,transparent)]"
          : "bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}
