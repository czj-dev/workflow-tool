import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Events } from "@wailsio/runtime";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { AiDiagBlock } from "@/components/ai/AiDiagBlock";
import { AiOutputPanel } from "@/components/ai/AiOutputPanel";
import { ActionIcon } from "./ActionIcon";
import { IconButton } from "./IconButton";
import { OutputLines } from "./OutputLines";
import { RunStatusBadge, RunningFlow } from "./GridCardParts";
import { WorkflowStepList } from "./WorkflowStepList";
import { stepsFromRun } from "../lib/workflowSteps";
import { fmtDuration } from "../lib/duration";
import { applyLiveEvent, replayRun, type RunPlayerOpts, type RunPlayerState } from "../lib/runReplay";
import { runDurationMs, runParam, targetIcon, targetTitle } from "../lib/runs";
import { useActionRunner } from "../hooks/useActionRunner";
import type { RunDetail, RunEvent, RunTargetKind } from "../types/events";

// 运行详情（M3）：一条运行记录的查看视图——结论、产出与可回放的渲染过程。
// 全应用只有这一处查看运行过程：调度卡、会话页的运行记录抽屉、运行记录列表都进得来。
//
// 过程来自运行日志（runs/<run-id>/events.ndjson），与前端当时收到的事件同构，经
// lib/runReplay 的同一份归约器还原：动作 = 输出行，AI 任务 = 工序段面板，工作流 = 步骤
// spine（AI 步骤同样是工序段）。加载分两步：先拉详情（结论与产出随即显示），再回放日志；
// 仍在运行的记录在回放之上订阅该目标的实时事件继续应用——订阅先于读盘建立，读盘之前
// 的输出重送一遍也无妨（按 seq 去重），运行结束触发重拉，换成完整回放。

// 正文类产出已在「过程」里完整呈现，产出表里不再重复
const BODY_OUTPUTS = new Set(["stdout", "stderr", "text", "thinking"]);
// 表格单元超过这个长度先折叠，点开再看全文
const FOLD_AT = 160;

export function RunDetailView() {
  const { t } = useTranslation();
  const {
    currentRunId, closeRun, getRun, getRunEvents, runsRevision,
    actions, workflows, aiTasks,
  } = useActionRunner();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [player, setPlayer] = useState<RunPlayerState | null>(null);
  const [error, setError] = useState("");

  const opts = useMemo<RunPlayerOpts>(() => ({
    stderrPrefix: t("output.stderrPrefix"),
    treeErrLabel: t("tree.parseError"),
    exitLine: (exitCode: number, err: string) =>
      t("output.exitLine", { exitCode, err: err ? t("output.errSuffix", { err }) : "" }),
    isTreeEnabled: (actionId) => !!actions.find((action) => action.id === actionId)?.hmi?.tree,
  }), [t, actions]);

  // 第一步：拉详情。进入详情、以及任何运行记录发生变化（含这一条跑完）时重来。
  useEffect(() => {
    if (!currentRunId) return;
    let cancelled = false;
    getRun(currentRunId)
      .then((loaded) => {
        if (cancelled) return;
        setDetail(loaded);
        setError("");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setDetail(null);
        setPlayer(null);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
    // getRun 是 context 上的函数，引用随 Provider 渲染变化；重载只由「换了一条记录 /
    // 运行记录有变化」触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRunId, runsRevision]);

  const running = detail?.status === "running";

  // 第二步：拿到详情后回放运行日志。仍在运行的记录**先订阅、后读盘**。
  // 反过来（先读盘、后订阅）会留下一个窗口：服务端读盘到订阅生效之间的输出两头落空，
  // seq 号段里出现永久的洞，之后的实时事件全部挂在门后，详情停更到运行结束。
  // 先订阅则读盘之前产生的输出也会被送来一遍——它们已在快照里，由 applyLiveEvent 据 seq 跳过。
  useEffect(() => {
    if (!detail) return;
    let cancelled = false;
    let settled = false; // 快照是否已落地
    const queued: RunEvent[] = []; // 快照落地前到达的实时事件
    const startedMs = Date.parse(detail.startedAt);
    const at = () => (Number.isNaN(startedMs) ? 0 : Math.max(0, Date.now() - startedMs));
    const receive = (e: unknown) => {
      if (cancelled) return;
      const data = ((e as { data?: unknown })?.data ?? {}) as RunEvent;
      if (settled) applyLive(data);
      else queued.push(data);
    };
    const applyLive = (data: RunEvent) =>
      setPlayer((prev) => (prev ? applyLiveEvent(prev, data, at(), opts) : prev));
    const prefix = detail.targetKind === "workflow" || detail.targetKind === "ai" ? detail.targetKind : "action";
    const unsubs = detail.status === "running"
      ? [Events.On(`${prefix}:${detail.targetId}:output`, receive), Events.On(`${prefix}:${detail.targetId}:done`, receive)]
      : [];
    getRunEvents(detail.id)
      .then((events) => {
        if (cancelled) return;
        setPlayer(replayRun(kindOf(detail), events, opts));
        settled = true;
        for (const data of queued) applyLive(data);
        queued.length = 0;
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setPlayer(null);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      unsubs.forEach((unsub) => unsub());
    };
    // getRunEvents 同 getRun；detail 每次重载都是新对象——正好重订阅、重读盘
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, opts]);

  // 工作流运行中：步骤耗时 live 递增（每秒刷新 ticker；不在 effect 里同步写 state）
  const [now, setNow] = useState(() => Date.now());
  const liveWorkflow = running && detail?.targetKind === "workflow";
  useEffect(() => {
    if (!liveWorkflow) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [liveWorkflow]);

  const title = detail ? targetTitle(detail.targetKind, detail.targetId, { actions, workflows, aiTasks }) : "";
  const icon = detail ? targetIcon(detail.targetKind, detail.targetId, { actions, workflows, aiTasks }) : undefined;
  const durationMs = detail ? runDurationMs(detail) : null;
  const workflowDef = detail?.targetKind === "workflow" ? workflows.find((item) => item.id === detail.targetId) : undefined;

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {running && <RunningFlow className="rounded-none" />}
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <SidebarTrigger />
        <IconButton icon={ArrowLeft01Icon} label={t("run.back")} onClick={closeRun} />
        <span className="flex min-w-0 items-center gap-1.5 font-semibold">
          {icon && <ActionIcon name={icon} />}
          <span className="truncate">{title}</span>
        </span>
        {detail && (
          <span className="truncate font-mono text-[11px] tracking-[0.015em] text-muted-foreground">
            {t(`scheduler.kind.${detail.targetKind}`)} · {detail.targetId}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          {detail && <RunStatusBadge status={detail.status} label={t(`runs.status.${detail.status}`, detail.status)} />}
          {detail && <span className="font-mono text-[11px] text-muted-foreground" title={detail.id}>{detail.id}</span>}
        </span>
      </header>

      {error && (
        <Alert variant="destructive" className="m-4">
          <AlertDescription>{t("error.loadFailed")}: {error}</AlertDescription>
        </Alert>
      )}

      {/* 结论与产出只依赖详情（先到）；过程要等运行日志回来（后到），期间显示加载中 */}
      {detail && (
        <>
          {/* —— 结论：这条运行的结论性事实 —— */}
          <section className="grid gap-x-6 gap-y-1.5 border-b bg-muted/20 px-4 py-2.5 sm:grid-cols-2 lg:grid-cols-4">
            <Fact label={t("runs.started")}>{localTime(detail.startedAt)}</Fact>
            <Fact label={t("runs.finished")}>
              {detail.finishedAt ? localTime(detail.finishedAt) : running ? "—" : t("runs.finishUnknown")}
            </Fact>
            <Fact label={t("runs.duration")}>
              {durationMs !== null ? fmtDuration(durationMs) : running ? "—" : t("runs.finishUnknown")}
            </Fact>
            <Fact label={t("runs.exitCode")}>{detail.exitCode}</Fact>
            <Fact label={t("runs.filterOrigin")}>
              {t(`runs.origin.${detail.origin}`, detail.origin)}
              {detail.scheduleId && <span className="text-muted-foreground"> · {detail.scheduleId}</span>}
            </Fact>
            <Fact label={t("runs.reason")} className="sm:col-span-1 lg:col-span-3">
              {detail.reason || "—"}
            </Fact>
          </section>

          <div className="grid grid-cols-1 min-h-0 flex-1 content-start gap-4 overflow-auto p-4">
            {/* —— 过程：回放运行日志 —— */}
            <section className="grid grid-cols-1 gap-2 min-w-0" aria-labelledby="run-process-heading">
              <h2 id="run-process-heading" className="text-sm font-semibold">
                {t("run.process")}
                {running && <span className="ml-2 font-mono text-[11px] font-normal text-primary">{t("run.live")}</span>}
              </h2>
              {player ? (
                <>
                  {player.truncated && (
                    <p className="font-mono text-xs text-muted-foreground">{t("run.truncated")}</p>
                  )}
                  <RunProcess
                    detail={detail}
                    player={player}
                    running={running}
                    now={now}
                    workflowSteps={workflowDef?.steps}
                  />
                </>
              ) : error ? null : (
                <p className="font-mono text-xs text-muted-foreground">{t("runs.loading")}</p>
              )}
            </section>

            {/* —— 产出与输入 —— */}
            <section className="grid gap-3" aria-labelledby="run-outputs-heading">
              <h2 id="run-outputs-heading" className="text-sm font-semibold">{t("run.outputs")}</h2>
              <div className="grid gap-3 lg:grid-cols-2">
                <KvTable
                  caption={t("run.outputs")}
                  entries={Object.entries(detail.outputs ?? {})
                    .filter(([key, value]) => !BODY_OUTPUTS.has(key) && value)
                    .map(([key, value]) => [key, String(value)])}
                />
                <KvTable
                  caption={t("run.inputs")}
                  entries={Object.keys(detail.params ?? {}).map((key) => [key, runParam(detail, key)] as [string, string])}
                />
              </div>
              {detail.rules && (
                <Collapsible>
                  <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-left font-mono text-xs text-muted-foreground hover:text-foreground">
                    <span className="text-[9px] text-primary">▸</span>
                    {t("run.rules")}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <pre className="mt-1.5 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
                      {detail.rules}
                    </pre>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </section>
          </div>
        </>
      )}
    </main>
  );
}

function kindOf(detail: RunDetail): RunTargetKind {
  return detail.targetKind === "workflow" || detail.targetKind === "ai" ? detail.targetKind : "action";
}

function localTime(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toLocaleString();
}

function Fact({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex min-w-0 items-baseline gap-2 text-[13px] ${className}`}>
      <span className="w-14 shrink-0 font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-muted-foreground">{children}</span>
    </div>
  );
}

// 过程区按目标种类分派：动作 = 输出行；AI 任务 = 工序段面板（+ 诊断）；工作流 = 步骤 spine。
function RunProcess({
  detail, player, running, now, workflowSteps,
}: {
  detail: RunDetail;
  player: RunPlayerState;
  running: boolean;
  now: number;
  workflowSteps?: ReadonlyArray<{ name: string; kind: string; label: string }>;
}) {
  const { t } = useTranslation();
  const aiFailed = detail.targetKind === "ai" && player.done?.exitCode !== 0 && player.done !== null;

  // 过程为空（启动前就失败、到点被跳过）：三种目标同一句话。运行中还没输出不算。
  const empty =
    detail.targetKind === "workflow" ? player.steps.length === 0
      : detail.targetKind === "ai" ? player.ai.panel.segments.length === 0 && player.ai.diag.length === 0
        : player.lines.length === 0;
  if (empty) return running ? null : <p className="font-mono text-xs text-muted-foreground">{t("run.noProcess")}</p>;

  if (detail.targetKind === "ai") {
    return (
      // min-w-0：AI 工具段的 pre 是 whitespace-pre 长行（JSON 命令/结果），grid item
      // 默认 min-width:auto 会被它的 min-content 撑到「最长行宽」，把整条过程区拉宽
      <div className="min-w-0 rounded-lg border border-border bg-background p-4">
        <AiOutputPanel prompt={runParam(detail, "prompt")} state={player.ai.panel} />
        {(aiFailed || player.ai.diag.length > 0) && (
          <AiDiagBlock className="mt-3" failed={aiFailed} error={aiFailed ? player.done?.err : undefined} lines={player.ai.diag} />
        )}
      </div>
    );
  }

  if (detail.targetKind === "workflow") {
    return (
      <div className="rounded-lg border border-border bg-background p-2">
        <WorkflowStepList
          steps={stepsFromRun(player, workflowSteps, t)}
          running={running && player.done === null}
          now={now}
        />
      </div>
    );
  }

  return (
    <pre className="overflow-auto rounded-lg border border-border bg-background p-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-all">
      <OutputLines lines={player.lines} exitCode={running ? undefined : player.done?.exitCode ?? detail.exitCode} />
    </pre>
  );
}

// 键值表：产出 / 输入。长值先折叠，点开看全文。
function KvTable({ caption, entries }: { caption: string; entries: Array<[string, string]> }) {
  const { t } = useTranslation();
  if (entries.length === 0) {
    return <p className="font-mono text-xs text-muted-foreground">{t("run.noOutputs", { what: caption })}</p>;
  }
  return (
    <table className="w-full border-collapse text-[13px]" aria-label={caption}>
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key} className="border-b border-border/60 last:border-b-0">
            <th scope="row" className="w-2/5 py-1 pr-3 align-top text-left font-mono text-xs font-normal text-muted-foreground break-all">
              {key}
            </th>
            <td className="py-1 align-top text-muted-foreground">
              <Foldable value={value} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Foldable({ value }: { value: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (value.length <= FOLD_AT) return <span className="whitespace-pre-wrap break-all">{value}</span>;
  return (
    <span className="whitespace-pre-wrap break-all">
      {open ? value : `${value.slice(0, FOLD_AT)}…`}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="ml-1 cursor-pointer border-none bg-transparent p-0 font-mono text-[11px] text-primary hover:underline"
      >
        {open ? t("run.fold") : t("run.unfold")}
      </button>
    </span>
  );
}
