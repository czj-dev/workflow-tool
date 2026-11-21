import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Add01Icon, Cancel01Icon, Delete02Icon, Edit02Icon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { IconButton } from "./IconButton";
import { useActionRunner } from "../hooks/useActionRunner";
import {
  parseScheduleCron,
  SCHEDULE_CRON_FIELDS,
  serializeScheduleCron,
  type ScheduleCron,
  type ScheduleCronField,
} from "../lib/scheduleCron";

const SIDEBAR_LEFT = { expanded: "16rem", collapsed: "3rem" } as const;
const DEFAULT_CRON = "0 9 * * 1-5";

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

type ScheduleInput = Omit<Schedule, "nextRun" | "running" | "lastRun">;
type CronFieldKey = keyof ScheduleCron;

type CronDraft = {
  value: ScheduleCron;
  raw: string;
  changed: boolean;
  error: string;
};

const EMPTY_FORM: ScheduleInput = {
  id: "",
  name: "",
  enabled: true,
  cron: DEFAULT_CRON,
  targetKind: "action",
  targetId: "",
  params: {},
};

function formatDate(value: string, locale: string): string {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseParams(text: string): Record<string, unknown> | null {
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function createScheduleId(existingIds: string[]): string {
  const used = new Set(existingIds);
  let id = `schedule-${crypto.randomUUID().toLowerCase()}`;
  while (used.has(id)) id = `schedule-${crypto.randomUUID().toLowerCase()}`;
  return id;
}

function createCronDraft(raw: string): CronDraft {
  try {
    return { value: parseScheduleCron(raw), raw, changed: false, error: "" };
  } catch (error: unknown) {
    return { value: parseScheduleCron(DEFAULT_CRON), raw, changed: false, error: getErrorMessage(error) };
  }
}

interface CronFieldPickerProps {
  label: string;
  fieldKey: CronFieldKey;
  field: ScheduleCronField;
  min: number;
  max: number;
  onChange: (key: CronFieldKey, field: ScheduleCronField) => void;
  anyLabel: string;
  emptyLabel: string;
}

function CronFieldPicker({ label, fieldKey, field, min, max, onChange, anyLabel, emptyLabel }: CronFieldPickerProps) {
  const selected = new Set(field.values);
  const values = Array.from({ length: max - min + 1 }, (_, index) => index + min);
  const toggleValue = (value: number, checked: boolean) => {
    const next = checked ? [...selected, value] : [...selected].filter((item) => item !== value);
    onChange(fieldKey, { mode: "values", values: next.sort((a, b) => a - b) });
  };

  return (
    <fieldset className="grid gap-2 rounded-lg border border-border/70 p-3">
      <legend className="px-1 text-sm font-medium">{label}</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={field.mode === "any"}
          onChange={(event) =>
            onChange(fieldKey, event.target.checked ? { mode: "any", values: [] } : { mode: "values", values: [min] })
          }
        />
        {anyLabel}
      </label>
      <div className="grid grid-cols-6 gap-x-2 gap-y-1 sm:grid-cols-10">
        {values.map((value) => (
          <label key={value} className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
            <input
              type="checkbox"
              checked={field.mode === "values" && selected.has(value)}
              disabled={field.mode === "any"}
              aria-label={`${label} ${value}`}
              onChange={(event) => toggleValue(value, event.target.checked)}
            />
            {value}
          </label>
        ))}
      </div>
      {field.mode === "values" && field.values.length === 0 && (
        <p className="text-xs text-destructive">{emptyLabel}</p>
      )}
    </fieldset>
  );
}

interface SchedulerViewProps {
  active?: boolean;
}

export function SchedulerView({ active = true }: SchedulerViewProps) {
  const { t, i18n } = useTranslation();
  const { state: sidebarState, isMobile } = useSidebar();
  const {
    schedules,
    scheduleErrors,
    actions,
    workflows,
    fragmentsOpen,
    setFragmentsOpen,
    setFormSheetOpen,
    saveSchedule,
    deleteSchedule,
    setScheduleEnabled,
    runScheduleNow,
  } = useActionRunner();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ScheduleInput>(EMPTY_FORM);
  const [cronDraft, setCronDraft] = useState<CronDraft>(() => createCronDraft(DEFAULT_CRON));
  const [paramsText, setParamsText] = useState("");
  const [formError, setFormError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingDelete) return undefined;
    const timer = window.setTimeout(() => setPendingDelete(null), 3000);
    return () => window.clearTimeout(timer);
  }, [pendingDelete]);

  const targets = useMemo(
    () => (form.targetKind === "action" ? actions : workflows),
    [actions, form.targetKind, workflows],
  );
  const sidebarLeft = sidebarState === "expanded" ? SIDEBAR_LEFT.expanded : SIDEBAR_LEFT.collapsed;

  const openCreate = () => {
    const targetKind = actions.length > 0 ? "action" : "workflow";
    const targetId = targetKind === "action" ? actions[0]?.id ?? "" : workflows[0]?.id ?? "";
    setFormSheetOpen(false);
    if (isMobile) setFragmentsOpen(false);
    setEditingId(null);
    setForm({ ...EMPTY_FORM, id: createScheduleId(schedules.map((item) => item.id)), targetKind, targetId });
    setCronDraft(createCronDraft(DEFAULT_CRON));
    setParamsText("{}");
    setFormError("");
    setSheetOpen(true);
  };

  const openEdit = (schedule: Schedule) => {
    setFormSheetOpen(false);
    if (isMobile) setFragmentsOpen(false);
    setEditingId(schedule.id);
    setForm({
      id: schedule.id,
      name: schedule.name,
      enabled: schedule.enabled,
      cron: schedule.cron,
      targetKind: schedule.targetKind,
      targetId: schedule.targetId,
      params: schedule.params ?? {},
    });
    setCronDraft(createCronDraft(schedule.cron));
    setParamsText(JSON.stringify(schedule.params ?? {}, null, 2));
    setFormError("");
    setSheetOpen(true);
  };

  const updateForm = (field: keyof ScheduleInput, value: string | boolean) => {
    setForm((current) => ({ ...current, [field]: value } as ScheduleInput));
  };

  const handleCronFieldChange = (key: CronFieldKey, field: ScheduleCronField) => {
    setCronDraft((current) => ({ ...current, value: { ...current.value, [key]: field }, changed: true, error: "" }));
  };

  const handleTargetKind = (value: string | null) => {
    if (value !== "action" && value !== "workflow") return;
    const firstTarget = value === "action" ? actions[0]?.id ?? "" : workflows[0]?.id ?? "";
    setForm((current) => ({ ...current, targetKind: value, targetId: firstTarget }));
  };

  const handleSave = async () => {
    const params = parseParams(paramsText);
    if (params === null) {
      setFormError(t("scheduler.invalidParams"));
      return;
    }
    if (!form.name.trim() || !form.targetId) {
      setFormError(t("scheduler.required"));
      return;
    }
    let cron = cronDraft.raw;
    if (cronDraft.changed) {
      try {
        cron = serializeScheduleCron(cronDraft.value);
      } catch (error: unknown) {
        setFormError(getErrorMessage(error));
        return;
      }
    } else if (cronDraft.error) {
      setFormError(t("scheduler.invalidCron"));
      return;
    }
    try {
      await saveSchedule({ ...form, name: form.name.trim(), cron, params });
      setSheetOpen(false);
    } catch (error: unknown) {
      setFormError(getErrorMessage(error));
    }
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

  const targetLabel = (kind: string, id: string) => {
    const list = kind === "workflow" ? workflows : actions;
    return list.find((item) => item.id === id)?.title ?? id;
  };

  return (
    <main className={active ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>
      <header className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <h1 className="text-sm font-semibold">{t("scheduler.title")}</h1>
        </div>
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
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[850px] text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">{t("scheduler.name")}</th>
                  <th className="px-3 py-2">{t("scheduler.target")}</th>
                  <th className="px-3 py-2 font-mono">{t("scheduler.cron")}</th>
                  <th className="px-3 py-2">{t("scheduler.nextRun")}</th>
                  <th className="px-3 py-2">{t("scheduler.running")}</th>
                  <th className="px-3 py-2">{t("scheduler.lastRun")}</th>
                  <th className="px-3 py-2 text-right">{t("scheduler.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {schedules.map((schedule: Schedule) => (
                  <tr key={schedule.id} aria-label={schedule.name} className="hover:bg-muted/30">
                    <td className="px-3 py-3">
                      <div className="font-medium">{schedule.name}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">{schedule.id}</div>
                    </td>
                    <td className="px-3 py-3">
                      <div>{targetLabel(schedule.targetKind, schedule.targetId)}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {t(`scheduler.kind.${schedule.targetKind}`, schedule.targetKind)}
                      </div>
                    </td>
                    <td className="px-3 py-3 font-mono text-xs">{schedule.cron}</td>
                    <td className="px-3 py-3 text-xs">{formatDate(schedule.nextRun, i18n.language)}</td>
                    <td className="px-3 py-3">
                      {schedule.running ? <span className="text-primary">{t("scheduler.status.running")}</span> : t("scheduler.status.idle")}
                    </td>
                    <td className="max-w-52 px-3 py-3 text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className={schedule.lastRun?.status === "failed" ? "text-destructive" : "text-primary"}>
                          {schedule.lastRun ? t(`scheduler.status.${schedule.lastRun.status}`, schedule.lastRun.status) : "--"}
                        </span>
                        {schedule.lastRun?.duration && <span className="text-muted-foreground">· {schedule.lastRun.duration}</span>}
                      </div>
                      {schedule.lastRun?.startedAt && <div className="text-muted-foreground">{formatDate(schedule.lastRun.startedAt, i18n.language)}</div>}
                      {schedule.lastRun?.error && <div className="truncate text-destructive" title={schedule.lastRun.error}>{schedule.lastRun.error}</div>}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex justify-end gap-1">
                        <Switch
                          checked={schedule.enabled}
                          aria-label={schedule.enabled ? t("scheduler.disable", { name: schedule.name }) : t("scheduler.enable", { name: schedule.name })}
                          onCheckedChange={(checked) => runRowAction(() => setScheduleEnabled(schedule.id, checked))}
                        />
                        <IconButton icon={PlayIcon} label={t("scheduler.runNow", { name: schedule.name })} onClick={() => runRowAction(() => runScheduleNow(schedule.id))} />
                        <IconButton icon={Edit02Icon} label={t("scheduler.edit", { name: schedule.name })} onClick={() => openEdit(schedule)} />
                        <IconButton
                          icon={Delete02Icon}
                          label={pendingDelete === schedule.id ? t("scheduler.confirmDelete") : t("scheduler.delete", { name: schedule.name })}
                          variant={pendingDelete === schedule.id ? "destructive" : "ghost"}
                          onClick={() => runRowAction(() => confirmDelete(schedule.id))}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Sheet
        open={sheetOpen && active && (!isMobile || !fragmentsOpen)}
        modal={false}
        disablePointerDismissal
        onOpenChange={setSheetOpen}
      >
        <SheetContent
          side="left"
          overlay={false}
          showCloseButton={false}
          data-scheduler-sheet=""
          initialFocus={() => document.querySelector<HTMLElement>("[data-scheduler-sheet] input:not(:disabled), [data-scheduler-sheet] textarea") ?? true}
          style={{
            left: isMobile ? 0 : sidebarLeft,
            right: isMobile ? 0 : fragmentsOpen ? "50vw" : `calc((100vw - ${sidebarLeft}) * 0.4)`,
          }}
          className="gap-0 transition-all data-[side=left]:w-auto data-[side=left]:sm:max-w-none"
        >
          <SheetHeader className="flex-row items-center justify-between gap-2 border-b px-4 py-2.5">
            <SheetTitle className="text-sm font-semibold">{editingId ? t("scheduler.editTitle") : t("scheduler.addTitle")}</SheetTitle>
            <IconButton
              icon={Cancel01Icon}
              label={t("scheduler.close")}
              className="text-muted-foreground/60 hover:text-foreground"
              onClick={() => setSheetOpen(false)}
            />
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto grid w-full max-w-3xl gap-4 px-6 py-4" data-scheduler-sheet-form="">
              <label className="grid gap-1 text-sm" htmlFor="schedule-id">
                {t("scheduler.id")}
                <Input id="schedule-id" value={form.id} disabled />
              </label>
              <label className="grid gap-1 text-sm" htmlFor="schedule-name">
                {t("scheduler.name")}
                <Input id="schedule-name" value={form.name} onChange={(event) => updateForm("name", event.target.value)} />
              </label>
              <div className="grid gap-2 text-sm">
                <span>{t("scheduler.targetKind")}</span>
                <Select value={form.targetKind} onValueChange={handleTargetKind}>
                  <SelectTrigger aria-label={t("scheduler.targetKind")}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="action">{t("scheduler.kind.action")}</SelectItem>
                    <SelectItem value="workflow">{t("scheduler.kind.workflow")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2 text-sm">
                <span>{t("scheduler.targetId")}</span>
                <Select value={form.targetId} onValueChange={(value) => value && updateForm("targetId", value)}>
                  <SelectTrigger aria-label={t("scheduler.targetId")}><SelectValue placeholder={t("scheduler.selectTarget")} /></SelectTrigger>
                  <SelectContent>
                    {targets.map((target) => <SelectItem key={target.id} value={target.id}>{target.title}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <label className="flex items-center justify-between gap-3 text-sm" htmlFor="schedule-enabled">
                {t("scheduler.enabled")}
                <Switch id="schedule-enabled" checked={form.enabled} onCheckedChange={(checked) => updateForm("enabled", checked)} />
              </label>

              <section className="grid gap-3" aria-labelledby="schedule-date-heading">
                <div>
                  <h2 id="schedule-date-heading" className="text-sm font-medium">{t("scheduler.dateConditions")}</h2>
                  <p className="text-xs text-muted-foreground">{t("scheduler.dateConditionsHint")}</p>
                </div>
                {SCHEDULE_CRON_FIELDS.filter(({ key }) => key === "month" || key === "day" || key === "weekday").map(({ key, min, max }) => (
                  <CronFieldPicker
                    key={key}
                    label={t(`scheduler.cronField.${key}`)}
                    fieldKey={key}
                    field={cronDraft.value[key]}
                    min={min}
                    max={max}
                    anyLabel={t("scheduler.any")}
                    emptyLabel={t("scheduler.selectAtLeastOne")}
                    onChange={handleCronFieldChange}
                  />
                ))}
                {cronDraft.value.day.mode === "values" && cronDraft.value.weekday.mode === "values" && (
                  <p className="text-xs text-muted-foreground">{t("scheduler.dateOrHint")}</p>
                )}
              </section>

              <section className="grid gap-3" aria-labelledby="schedule-time-heading">
                <div>
                  <h2 id="schedule-time-heading" className="text-sm font-medium">{t("scheduler.timeConditions")}</h2>
                  <p className="text-xs text-muted-foreground">{t("scheduler.timeConditionsHint")}</p>
                </div>
                {SCHEDULE_CRON_FIELDS.filter(({ key }) => key === "hour" || key === "minute").map(({ key, min, max }) => (
                  <CronFieldPicker
                    key={key}
                    label={t(`scheduler.cronField.${key}`)}
                    fieldKey={key}
                    field={cronDraft.value[key]}
                    min={min}
                    max={max}
                    anyLabel={t("scheduler.any")}
                    emptyLabel={t("scheduler.selectAtLeastOne")}
                    onChange={handleCronFieldChange}
                  />
                ))}
              </section>

              {cronDraft.error && !cronDraft.changed && (
                <Alert variant="destructive"><AlertDescription>{t("scheduler.invalidCron")}: {cronDraft.raw}</AlertDescription></Alert>
              )}
              <label className="grid gap-1 text-sm" htmlFor="schedule-params">
                {t("scheduler.params")}
                <Textarea id="schedule-params" className="min-h-32" value={paramsText} onChange={(event) => setParamsText(event.target.value)} placeholder="{}" />
              </label>
              {formError && <p className="text-sm text-destructive" role="alert">{formError}</p>}
            </div>
          </div>
          <SheetFooter className="flex-row justify-end border-t px-6 py-3">
            <Button variant="outline" onClick={() => setSheetOpen(false)}>{t("scheduler.cancel")}</Button>
            <Button onClick={() => void handleSave()}>{t("scheduler.save")}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </main>
  );
}
