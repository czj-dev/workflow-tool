import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Add01Icon, Edit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import { ActionIcon } from "./ActionIcon";
import {
  GhostBtn,
  NarrativeZone,
  QuickHint,
  RunPill,
  RunningFlow,
  TickRuler,
  ambFor,
  narrativeStamp,
} from "./GridCardParts";
import { ScheduleFormSheet, type ScheduleFormTarget, type ScheduleFormValue } from "./ScheduleFormSheet";
import { useActionRunner } from "../hooks/useActionRunner";
import {
  describeScheduleCron,
  formatScheduleNextRun,
  nextScheduleRuns,
  parseScheduleCron,
} from "../lib/scheduleCron";

// Schedules 视图（定稿原型 v2 卡阵）：按 targetKind 分组的双态卡网格（动作=amber、
// 工作流=green，按组序循环取色；空组省略；停用项原位降透明不沉底）。紧凑态 = 身份
// （目标+句子+下次读数），展开态 = 意图（叙事区原始 cron + 未来 3 次触发 + 最近结果
// + 编辑/二次确认删除/启停/立即运行）。表单走 ScheduleFormSheet（拨盘编辑器）。

const EYEBROW = "font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80";
const DEFAULT_CRON = "0 9 * * 1-5";
const GROUP_KINDS = ["action", "workflow"] as const;

type Schedule = {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  targetKind: string;
  targetId: string;
  params: Record<string, unknown>;
  nextRun: string;
  running: boolean;
  lastRun?: {
    status: string;
    startedAt: string;
    finishedAt: string;
    duration: string;
    error: string;
  } | null;
};

function createScheduleId(existingIds: string[]): string {
  const used = new Set(existingIds);
  let id = `schedule-${crypto.randomUUID().toLowerCase()}`;
  while (used.has(id)) id = `schedule-${crypto.randomUUID().toLowerCase()}`;
  return id;
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3.5">
      <span className="w-16 flex-none pt-0.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 flex-1 text-[13px]">{children}</div>
    </div>
  );
}

interface SchedulerViewProps {
  active?: boolean;
}

interface ScheduleCardProps {
  schedule: Schedule;
  amb: string;
  expanded: boolean;
  pendingDelete: boolean;
  target: ScheduleFormTarget;
  sentence: string;
  next: Date | null;
  next3: Date[];
  onToggleExpand: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: (checked: boolean) => void;
  onRunNow: () => void;
}

function ScheduleCard({
  schedule, amb, expanded, pendingDelete, target, sentence, next, next3,
  onToggleExpand, onEdit, onDelete, onToggleEnabled, onRunNow,
}: ScheduleCardProps) {
  const { t } = useTranslation();
  const { enabled, running, lastRun } = schedule;
  const startedAt = lastRun?.startedAt ? new Date(lastRun.startedAt).getTime() : null;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={schedule.name}
      aria-expanded={expanded}
      data-running={running || undefined}
      data-expanded={expanded || undefined}
      onClick={onToggleExpand}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Escape" && expanded) { event.preventDefault(); onToggleExpand(); return; }
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggleExpand(); }
      }}
      style={{ "--amb": amb } as CSSProperties}
      className={`dual-card group relative flex cursor-pointer select-none flex-col rounded-lg border border-border
        transition-[border-color,box-shadow] duration-150 ease-out focus-visible:outline-none motion-reduce:transition-none
        ${expanded ? "col-span-2 gap-3.5 p-5 max-md:col-span-1" : "gap-2.5 p-3.5"}
        ${!enabled && !running ? "opacity-[0.72]" : ""}`}
    >
      {running && <RunningFlow />}

      {/* 仪表带：状态点 + 下次读数（今天/明天措辞） */}
      <div className="flex h-3 items-center gap-2">
        <span
          className={`size-[7px] shrink-0 rounded-full
            ${running ? "bg-primary live-pulse" : enabled ? "bg-[color-mix(in_oklab,var(--amb)_75%,transparent)]" : "bg-foreground/20"}`}
        />
        <span className="ml-auto font-mono text-[10.5px] tracking-[0.06em] tabular-nums text-muted-foreground">
          {running
            ? t("scheduler.status.running")
            : next
              ? formatScheduleNextRun(next, t)
              : !enabled
                ? t("scheduler.disabledLabel")
                : "--"}
        </span>
      </div>

      {/* 身份区：hub + 名称 + 目标/id */}
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="dual-hub grid size-10 shrink-0 place-items-center rounded-[27.5%]">
          <ActionIcon name={target.icon ?? "hi:clock"} className="size-5" />
        </span>
        <span className="min-w-0 flex-1 pt-0.5 font-mono text-[13.5px] font-semibold leading-tight -tracking-[0.01em]">
          <span className="block break-all">{schedule.name}</span>
          <span className="mt-1 block truncate text-[11px] font-normal tracking-[0.015em] text-muted-foreground">
            {expanded
              ? schedule.id
              : `${t(`scheduler.kind.${schedule.targetKind}`, schedule.targetKind)} · ${target.title} · ${schedule.id}`}
          </span>
        </span>
      </div>

      {expanded ? (
        <>
          {/* 叙事区：原始 cron stamp + 人读句子 */}
          <NarrativeZone stamp={schedule.cron}>{sentence}</NarrativeZone>

          <div className="grid gap-1.5">
            <InfoRow label={t("scheduler.nextTriggers")}>
              {next3.length > 0 ? (
                <span className="flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-[11.5px] tabular-nums">
                  {next3.map((date, index) => (
                    <span key={date.getTime()} className={index === 0 ? "" : "text-muted-foreground"}>
                      {formatScheduleNextRun(date, t)}
                      {index === 0 ? ` · ${t(`scheduler.weekday.${date.getDay()}`)}` : ""}
                    </span>
                  ))}
                </span>
              ) : ("--")}
            </InfoRow>
            <InfoRow label={t("scheduler.lastRun")}>
              {lastRun ? (
                <>
                  <span className={`font-semibold ${lastRun.status === "failed" ? "text-destructive" : "text-success"}`}>
                    {t(`scheduler.status.${lastRun.status}`, lastRun.status)}
                  </span>
                  {lastRun.duration && (
                    <span className="ml-1.5 text-[11.5px] text-muted-foreground">· {lastRun.duration}</span>
                  )}
                  {startedAt !== null && !Number.isNaN(startedAt) && (
                    <span className="ml-1.5 text-[11.5px] text-muted-foreground">· {narrativeStamp(startedAt)}</span>
                  )}
                  {lastRun.error && (
                    <div className="truncate text-[12px] text-destructive" title={lastRun.error}>{lastRun.error}</div>
                  )}
                </>
              ) : ("--")}
            </InfoRow>
            <InfoRow label={t("scheduler.target")}>
              {t(`scheduler.kind.${schedule.targetKind}`, schedule.targetKind)} · {target.title}
            </InfoRow>
            <InfoRow label={t("scheduler.paramsLabel")}>
              <span className="break-all font-mono text-[11.5px]">{JSON.stringify(schedule.params)}</span>
            </InfoRow>
          </div>

          {/* 展开态功能行：编辑 / 二次确认删除 / 启停 / 立即运行 */}
          <div className="mt-auto flex flex-wrap items-center gap-2.5 border-t border-dashed
            border-[color-mix(in_oklab,var(--amb)_30%,var(--border))] pt-3.5">
            <GhostBtn
              label={t("scheduler.editShort")}
              onClick={onEdit}
              icon={<HugeiconsIcon icon={Edit02Icon} strokeWidth={2} className="size-3" />}
            />
            <button
              type="button"
              aria-label={pendingDelete ? t("scheduler.confirmDelete") : t("scheduler.delete", { name: schedule.name })}
              onClick={(event) => { event.stopPropagation(); onDelete(); }}
              className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-3
                font-mono text-[11.5px] tracking-[0.04em] transition-colors
                ${pendingDelete
                  ? "border-destructive/60 bg-destructive/12 text-destructive"
                  : "border-border bg-card/55 text-muted-foreground hover:border-[color-mix(in_oklab,var(--amb)_50%,transparent)] hover:text-foreground"}`}
            >
              {pendingDelete ? t("scheduler.confirmDelete") : "⌫"}
            </button>
            <span className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.06em] text-muted-foreground">
              <span onClick={(event) => event.stopPropagation()}>
                <Switch
                  checked={enabled}
                  aria-label={enabled
                    ? t("scheduler.disable", { name: schedule.name })
                    : t("scheduler.enable", { name: schedule.name })}
                  onCheckedChange={onToggleEnabled}
                />
              </span>
              {enabled ? t("scheduler.enabledLabel") : t("scheduler.disabledLabel")}
            </span>
            <RunPill
              label={t("scheduler.runNowShort")}
              running={running}
              runningLabel={t("scheduler.status.running")}
              onClick={onRunNow}
            />
          </div>
        </>
      ) : (
        <>
          <div className="break-words text-xs leading-relaxed text-foreground/85">{sentence}</div>

          {/* 紧凑态页脚：最近结果 + 快照入口 */}
          <div className="mt-auto flex items-center justify-end border-t border-dashed
            border-[color-mix(in_oklab,var(--amb)_30%,var(--border))] pt-2">
            <span className="mr-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {lastRun ? (
                <>
                  <span className={`size-[5px] rounded-full ${lastRun.status === "failed" ? "bg-destructive" : "bg-success"}`} />
                  {lastRun.duration || t(`scheduler.status.${lastRun.status}`, lastRun.status)}
                </>
              ) : ("--")}
            </span>
            {running ? (
              <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.02em] text-primary">
                <span className="size-1.5 rounded-full bg-primary live-pulse" />
                {t("scheduler.status.running")} ▸
              </span>
            ) : enabled ? (
              <QuickHint label={t("scheduler.runNowShort")} onClick={onRunNow} />
            ) : (
              <span className="text-[10px] text-muted-foreground">{t("scheduler.disabledLabel")}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function SchedulerView({ active = true }: SchedulerViewProps) {
  const { t } = useTranslation();
  const { isMobile } = useSidebar();
  const {
    schedules,
    scheduleErrors,
    actions,
    workflows,
    setFragmentsOpen,
    setFormSheetOpen,
    saveSchedule,
    deleteSchedule,
    setScheduleEnabled,
    runScheduleNow,
  } = useActionRunner();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [seed, setSeed] = useState<{ key: string; value: ScheduleFormValue; creating: boolean }>({
    key: "init",
    creating: true,
    value: {
      id: "", name: "", enabled: true, cron: DEFAULT_CRON,
      targetKind: "action", targetId: "", params: {},
    },
  });
  const seedSeq = useRef(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingDelete) return undefined;
    const timer = window.setTimeout(() => setPendingDelete(null), 3000);
    return () => window.clearTimeout(timer);
  }, [pendingDelete]);

  const targetOf = (schedule: Schedule): ScheduleFormTarget => {
    const list = schedule.targetKind === "workflow" ? workflows : actions;
    return list.find((item) => item.id === schedule.targetId) ?? { id: schedule.targetId, title: schedule.targetId };
  };

  const safeSentence = (schedule: Schedule): string => {
    try {
      return describeScheduleCron(parseScheduleCron(schedule.cron), t) ?? schedule.cron;
    } catch {
      return schedule.cron;
    }
  };

  // 下次单点：后端 nextRun 优先（权威），缺失/非法时本地从 cron 推算
  const nextOf = (schedule: Schedule): Date | null => {
    if (!schedule.enabled && !schedule.running) return null;
    if (schedule.nextRun) {
      const date = new Date(schedule.nextRun);
      if (!Number.isNaN(date.getTime())) return date;
    }
    try {
      return nextScheduleRuns(schedule.cron, 1)[0] ?? null;
    } catch {
      return null;
    }
  };

  const next3Of = (schedule: Schedule): Date[] => {
    if (!schedule.enabled && !schedule.running) return [];
    try {
      return nextScheduleRuns(schedule.cron, 3);
    } catch {
      return [];
    }
  };

  const openCreate = () => {
    const targetKind = actions.length > 0 ? "action" : "workflow";
    const targetId = targetKind === "action" ? actions[0]?.id ?? "" : workflows[0]?.id ?? "";
    setFormSheetOpen(false);
    if (isMobile) setFragmentsOpen(false);
    seedSeq.current += 1;
    setSeed({
      key: `new:${seedSeq.current}`,
      creating: true,
      value: {
        id: createScheduleId(schedules.map((item) => item.id)),
        name: "",
        enabled: true,
        cron: DEFAULT_CRON,
        targetKind,
        targetId,
        params: {},
      },
    });
    setSheetOpen(true);
  };

  const openEdit = (schedule: Schedule) => {
    setFormSheetOpen(false);
    if (isMobile) setFragmentsOpen(false);
    seedSeq.current += 1;
    setSeed({
      key: `${schedule.id}:${seedSeq.current}`,
      creating: false,
      value: {
        id: schedule.id,
        name: schedule.name,
        enabled: schedule.enabled,
        cron: schedule.cron,
        targetKind: schedule.targetKind === "workflow" ? "workflow" : "action",
        targetId: schedule.targetId,
        params: schedule.params ?? {},
      },
    });
    setSheetOpen(true);
  };

  const handleFormSave = async (value: ScheduleFormValue) => {
    await saveSchedule(value);
    setSheetOpen(false);
  };

  const confirmDelete = async (id: string) => {
    if (pendingDelete !== id) {
      setPendingDelete(id);
      return;
    }
    setPendingDelete(null);
    await deleteSchedule(id);
  };

  const runRowAction = (operation: () => Promise<void>) => {
    void operation().catch(() => undefined);
  };

  return (
    <main className={active ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <SidebarTrigger />
        <h1 className="flex-none text-sm font-semibold">{t("scheduler.title")}</h1>
        <span className="ml-auto font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground tabular-nums">
          {t("scheduler.countLine", {
            total: schedules.length,
            on: schedules.filter((item) => item.enabled).length,
          })}
        </span>
        <Button size="sm" onClick={openCreate}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={1.75} />
          {t("scheduler.add")}
        </Button>
      </header>

      <div className="flex flex-1 flex-col gap-3 overflow-auto p-4">
        {scheduleErrors.length > 0 && (
          <Alert variant="destructive">
            <AlertDescription>
              <div className="font-medium">{t("scheduler.errors")}</div>
              <ul className="mt-1 list-disc pl-4">
                {scheduleErrors.map((error, index) => <li key={`${error}-${index}`}>{error}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {schedules.length === 0 ? (
          <Empty>
            <EmptyDescription>{t("scheduler.empty")}</EmptyDescription>
          </Empty>
        ) : (
          GROUP_KINDS.map((kind, groupIndex) => {
            const items = schedules.filter((schedule) => schedule.targetKind === kind);
            if (items.length === 0) return null;
            const enabledCount = items.filter((schedule) => schedule.enabled).length;
            return (
              <section key={kind}>
                <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 pb-3">
                  <span className={EYEBROW}>{t(`scheduler.group.${kind}`)}</span>
                  <TickRuler total={items.length} lit={enabledCount} />
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground tabular-nums">
                    {t("scheduler.countLine", { total: items.length, on: enabledCount })}
                  </span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-2.5">
                  {items.map((schedule) => (
                    <ScheduleCard
                      key={schedule.id}
                      schedule={schedule}
                      amb={ambFor(groupIndex)}
                      expanded={expandedId === schedule.id}
                      pendingDelete={pendingDelete === schedule.id}
                      target={targetOf(schedule)}
                      sentence={safeSentence(schedule)}
                      next={nextOf(schedule)}
                      next3={next3Of(schedule)}
                      onToggleExpand={() =>
                        setExpandedId((current) => (current === schedule.id ? null : schedule.id))
                      }
                      onEdit={() => openEdit(schedule)}
                      onDelete={() => void confirmDelete(schedule.id)}
                      onToggleEnabled={(checked) => runRowAction(() => setScheduleEnabled(schedule.id, checked))}
                      onRunNow={() => runRowAction(() => runScheduleNow(schedule.id))}
                    />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>

      <ScheduleFormSheet
        open={sheetOpen}
        active={active}
        seed={seed}
        actions={actions}
        workflows={workflows}
        onSave={handleFormSave}
        onClose={() => setSheetOpen(false)}
      />
    </main>
  );
}
