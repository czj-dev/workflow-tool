import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useSidebar } from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ActionIcon } from "./ActionIcon";
import { IconButton } from "./IconButton";
import { useActionRunner } from "../hooks/useActionRunner";
import {
  AI_RESERVED_FIELDS,
  aiValuesFromParams,
  normalizeTargetKind,
  paramsFromAiValues,
  type ScheduleTargetKind,
} from "../lib/scheduleForm";
import { DEFAULT_SCHEDULE_CRON } from "../lib/scheduleCron";
import { RUN_TARGET_KINDS, type ScheduleEditorState, type ScheduleFormValue } from "../types/events";

export type { ScheduleFormValue } from "../types/events";
import {
  describeScheduleCron,
  formatScheduleCronField,
  parseScheduleCron,
  serializeScheduleCron,
  SCHEDULE_CRON_FIELDS,
  updateScheduleCronField,
  type ScheduleCron,
  type ScheduleCronField,
} from "../lib/scheduleCron";

// 调度表单抽屉（定稿原型 v2 的拨盘编辑器）：基本信息 / 目标（动作 / 工作流 / AI 任务
// 三选一）/ 节律（五槽读数条 + 人读句子 + 常用模式 + 5 个令牌拨盘）/ 参数。
// 开合与草稿初值由 Provider 的 scheduleEditor 持有：调度页与 AI 卡的「定时」入口共用
// 这一个抽屉；seed.key 变化即重置草稿（同一 key 期间隐藏 / 重显草稿不丢）。
// lock 把目标锁定为某个目标（从 AI 卡进来时类型与任务都不可改）。
//
// 参数区按目标种类分两种形态：
//   - 动作 / 工作流：参数 JSON 文本框（动作的值还可以是 $literal 对象）；
//   - AI 任务：结构化输入——每个已声明参数一个文本框，外加保留运行参数 prompt / system
//     两个多行框。留空 = 不传该参数，运行时由任务取默认值。

const SIDEBAR_LEFT = { expanded: "16rem", collapsed: "3rem" } as const;
const DEFAULT_CRON = DEFAULT_SCHEDULE_CRON;

// 拨盘显示序：时 → 分 → 周 → 日 → 月（先定小时再抠分钟，先粗后细）
const DIAL_ORDER: ReadonlyArray<keyof ScheduleCron> = ["hour", "minute", "weekday", "day", "month"];
// 读数条显示序：与 cron 表达式字段一致（分 时 日 月 周）
const READOUT_ORDER: ReadonlyArray<keyof ScheduleCron> = ["minute", "hour", "day", "month", "weekday"];

const PATTERNS = [
  { cron: "0 9 * * 1-5", nameKey: "scheduler.pattern.workdayMorning", descKey: "scheduler.pattern.workdayMorningDesc" },
  { cron: "0 9 * * *", nameKey: "scheduler.pattern.daily", descKey: "scheduler.pattern.dailyDesc" },
  { cron: "30 * * * *", nameKey: "scheduler.pattern.hourly", descKey: "scheduler.pattern.hourlyDesc" },
  { cron: "0 18 * * 5", nameKey: "scheduler.pattern.friday", descKey: "scheduler.pattern.fridayDesc" },
] as const;

export type ScheduleFormTarget = { id: string; title: string; icon?: string };

type CronDraft = { value: ScheduleCron; raw: string; changed: boolean; parseError: boolean };

type Draft = {
  name: string;
  enabled: boolean;
  cron: CronDraft;
  targetKind: ScheduleTargetKind;
  targetId: string;
  // 动作 / 工作流的参数 JSON 文本
  paramsText: string;
  // AI 任务的输入：已声明参数 + 保留运行参数，值为文本；只有用户填过的键
  aiValues: Record<string, string>;
  error: string;
};

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

function createDraft(value: ScheduleFormValue): Draft {
  let cron: CronDraft;
  try {
    cron = { value: parseScheduleCron(value.cron), raw: value.cron, changed: false, parseError: false };
  } catch {
    cron = { value: parseScheduleCron(DEFAULT_CRON), raw: value.cron, changed: false, parseError: true };
  }
  const targetKind = normalizeTargetKind(value.targetKind);
  return {
    name: value.name,
    enabled: value.enabled,
    cron,
    targetKind,
    targetId: value.targetId,
    paramsText: JSON.stringify(value.params ?? {}, null, 2),
    aiValues: targetKind === "ai" ? aiValuesFromParams(value.params ?? {}) : {},
    error: "",
  };
}

const CLOSED_SEED: ScheduleEditorState = {
  key: "closed",
  creating: true,
  value: { id: "", name: "", enabled: true, cron: DEFAULT_CRON, targetKind: "action", targetId: "", params: {} },
};

export function ScheduleFormSheet() {
  const { t } = useTranslation();
  const { state: sidebarState, isMobile } = useSidebar();
  const {
    scheduleEditor, closeScheduleForm, saveSchedule,
    actions, workflows, aiTasks, fragmentsOpen,
  } = useActionRunner();
  // scheduleEditor 为 null = 抽屉关闭。关闭期间组件保持挂载（挂在 App 骨架上），
  // 草稿随 key 重置，不需要额外的 open prop。
  const seed = scheduleEditor ?? CLOSED_SEED;
  const open = scheduleEditor !== null;
  const lock = scheduleEditor?.lock;
  const [seedKey, setSeedKey] = useState(seed.key);
  const [draft, setDraft] = useState<Draft>(() => createDraft(seed.value));
  // seed.key 变化时在渲染期重置草稿（React 官方推荐的 prop 派生 state 模式）
  if (seedKey !== seed.key) {
    setSeedKey(seed.key);
    setDraft(createDraft(seed.value));
  }

  const targetLists: Record<ScheduleTargetKind, ScheduleFormTarget[]> = {
    action: actions.map((a) => ({ id: a.id, title: a.title, icon: a.icon })),
    workflow: workflows.map((w) => ({ id: w.id, title: w.title, icon: w.icon })),
    ai: aiTasks.map((task) => ({ id: task.id, title: task.title, icon: task.icon })),
  };
  const targets = lock
    ? targetLists[lock.kind].filter((target) => target.id === lock.id)
    : targetLists[draft.targetKind];
  const aiTask = draft.targetKind === "ai" ? aiTasks.find((task) => task.id === draft.targetId) : undefined;
  const sidebarLeft = sidebarState === "expanded" ? SIDEBAR_LEFT.expanded : SIDEBAR_LEFT.collapsed;
  const sentence = describeScheduleCron(draft.cron.value, t);
  const paramsValid = draft.targetKind === "ai" || parseParams(draft.paramsText) !== null;

  const patch = (partial: Partial<Draft>) => setDraft((current) => ({ ...current, ...partial }));

  const patchCron = (cron: CronDraft) => patch({ cron, error: "" });

  // 切换目标种类：参数随之清空（不同目标的参数互不相干）
  const handleKind = (kind: ScheduleTargetKind) => {
    if (lock) return;
    const list = targetLists[kind];
    setDraft((current) => ({
      ...current,
      targetKind: kind,
      targetId: list[0]?.id ?? "",
      paramsText: "{}",
      aiValues: {},
      error: "",
    }));
  };
  const handleTarget = (targetId: string) =>
    setDraft((current) => ({ ...current, targetId, paramsText: "{}", aiValues: {}, error: "" }));
  const patchAiValue = (key: string, value: string) =>
    setDraft((current) => ({ ...current, aiValues: { ...current.aiValues, [key]: value }, error: "" }));

  const handleAnyChip = (key: keyof ScheduleCron, min: number) => {
    const field = draft.cron.value[key];
    patchCron({
      ...draft.cron,
      changed: true,
      value: updateScheduleCronField(draft.cron.value, key,
        field.mode === "any" ? { mode: "values", values: [min] } : { mode: "any", values: [] }),
    });
  };

  const handleToken = (key: keyof ScheduleCron, value: number) => {
    const selected = new Set(draft.cron.value[key].values);
    if (selected.has(value)) selected.delete(value);
    else selected.add(value);
    patchCron({
      ...draft.cron,
      changed: true,
      value: updateScheduleCronField(draft.cron.value, key,
        { mode: "values", values: [...selected].sort((a, b) => a - b) }),
    });
  };

  const handleSave = async () => {
    const params = draft.targetKind === "ai"
      ? paramsFromAiValues(draft.aiValues)
      : parseParams(draft.paramsText);
    if (params === null) {
      patch({ error: t("scheduler.invalidParams") });
      return;
    }
    if (!draft.name.trim() || !draft.targetId) {
      patch({ error: t("scheduler.required") });
      return;
    }
    let cron = draft.cron.raw;
    if (draft.cron.changed) {
      try {
        cron = serializeScheduleCron(draft.cron.value);
      } catch (error: unknown) {
        patch({ error: getErrorMessage(error) });
        return;
      }
    } else if (draft.cron.parseError) {
      patch({ error: t("scheduler.invalidCron") });
      return;
    }
    try {
      await saveSchedule({
        id: seed.value.id,
        name: draft.name.trim(),
        enabled: draft.enabled,
        cron,
        targetKind: draft.targetKind,
        targetId: draft.targetId,
        params,
      });
    } catch (error: unknown) {
      patch({ error: getErrorMessage(error) });
    }
  };

  return (
    <Sheet
      open={open && (!isMobile || !fragmentsOpen)}
      modal={false}
      disablePointerDismissal
      onOpenChange={(next) => { if (!next) closeScheduleForm(); }}
    >
      <SheetContent
        side="left"
        overlay={false}
        showCloseButton={false}
        data-scheduler-sheet=""
        initialFocus={() => document.querySelector<HTMLElement>("[data-scheduler-sheet] input:not(:disabled), [data-scheduler-sheet] textarea") ?? true}
        style={{
          "--amb": "var(--primary)",
          left: isMobile ? 0 : sidebarLeft,
          right: isMobile ? 0 : fragmentsOpen ? "50vw" : `calc((100vw - ${sidebarLeft}) * 0.4)`,
        } as CSSProperties}
        className="gap-0 transition-all data-[side=left]:w-auto data-[side=left]:sm:max-w-none"
      >
        <SheetHeader className="flex-row items-center justify-between gap-2 border-b px-4 py-2.5">
          <SheetTitle className="text-sm font-semibold">
            {seed.creating
              ? lock ? t("scheduler.scheduleFor", { name: targets[0]?.title ?? lock.id }) : t("scheduler.addTitle")
              : t("scheduler.editTitle")}
          </SheetTitle>
          <IconButton
            icon={Cancel01Icon}
            label={t("scheduler.close")}
            className="text-muted-foreground/60 hover:text-foreground"
            onClick={closeScheduleForm}
          />
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto grid w-full max-w-3xl gap-5 px-6 py-4">
            {/* —— 基本信息 —— */}
            <section className="grid gap-2.5">
              <label className="grid gap-1 text-sm" htmlFor="schedule-name">
                <span className="font-semibold">{t("scheduler.name")}</span>
                <Input
                  id="schedule-name"
                  value={draft.name}
                  placeholder={t("scheduler.namePlaceholder")}
                  onChange={(event) => patch({ name: event.target.value })}
                />
              </label>
              <p className="font-mono text-[10.5px] tracking-[0.06em] text-muted-foreground">
                id · {seed.value.id || t("scheduler.idAutoValue")}
              </p>
              <label className="flex items-center justify-between gap-3 text-sm" htmlFor="schedule-enabled">
                {t("scheduler.enabled")}
                <Switch
                  id="schedule-enabled"
                  checked={draft.enabled}
                  onCheckedChange={(checked) => patch({ enabled: checked })}
                />
              </label>
            </section>

            {/* —— 目标 —— */}
            <section className="grid gap-2.5" aria-labelledby="schedule-target-heading">
              <div>
                <h2 id="schedule-target-heading" className="text-sm font-semibold">{t("scheduler.target")}</h2>
                <p className="text-xs text-muted-foreground">{t("scheduler.targetHint")}</p>
              </div>
              <div role="group" aria-label={t("scheduler.target")} className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted/50 p-1">
                {RUN_TARGET_KINDS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={draft.targetKind === kind}
                    disabled={!!lock}
                    onClick={() => handleKind(kind)}
                    title={lock ? t("scheduler.targetLocked") : undefined}
                    className={`h-7 cursor-pointer rounded-md border-none font-mono text-xs tracking-[0.06em] transition-colors
                      disabled:cursor-default
                      ${draft.targetKind === kind
                        ? "bg-primary/18 text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_40%,transparent)]"
                        : "bg-transparent text-muted-foreground hover:text-foreground"}`}
                  >
                    {t(`scheduler.kind.${kind}`)}
                  </button>
                ))}
              </div>
              {lock && (
                <p className="font-mono text-[11px] tracking-[0.02em] text-muted-foreground">{t("scheduler.targetLocked")}</p>
              )}
              <div
                role="radiogroup"
                aria-label={t("scheduler.target")}
                className="max-h-52 overflow-y-auto rounded-lg border border-border"
              >
                {targets.length === 0 ? (
                  <p className="px-3.5 py-3.5 text-center text-xs text-muted-foreground">{t("scheduler.noTargets")}</p>
                ) : (
                  targets.map((target) => (
                    <button
                      key={target.id}
                      type="button"
                      role="radio"
                      aria-checked={draft.targetId === target.id}
                      onClick={() => handleTarget(target.id)}
                      className={`flex w-full cursor-pointer items-center gap-2.5 border-b border-border/60 px-3 py-2 text-left
                        text-sm transition-colors last:border-b-0
                        ${draft.targetId === target.id
                          ? "bg-primary/10 shadow-[inset_2px_0_0_var(--primary)]"
                          : "bg-transparent hover:bg-muted/50"}`}
                    >
                      <span className="dual-hub grid size-7 shrink-0 place-items-center rounded-[27.5%]">
                        <ActionIcon name={target.icon ?? "hi:clock"} className="size-3.5" />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{target.title}</span>
                      <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground">{target.id}</span>
                    </button>
                  ))
                )}
              </div>
            </section>

            {/* —— 节律：读数条 + 模式 + 拨盘 —— */}
            <section className="grid gap-3" aria-labelledby="schedule-cadence-heading">
              <div>
                <h2 id="schedule-cadence-heading" className="text-sm font-semibold">{t("scheduler.cadence")}</h2>
                <p className="text-xs text-muted-foreground">{t("scheduler.cadenceHint")}</p>
              </div>

              <div className="overflow-hidden rounded-[10px] border border-border bg-muted/30">
                <div className="grid grid-cols-5">
                  {READOUT_ORDER.map((key) => {
                    const field = draft.cron.value[key];
                    const text = formatScheduleCronField(field);
                    const bad = field.mode === "values" && field.values.length === 0;
                    return (
                      <div key={key} className="border-r border-border/70 px-1.5 py-2 text-center last:border-r-0">
                        <div className="font-mono text-[10px] font-semibold tracking-[0.18em] text-muted-foreground">
                          {t(`scheduler.slotShort.${key}`)}
                        </div>
                        <div
                          title={text}
                          className={`mt-0.5 truncate font-mono text-[13px] font-semibold tabular-nums ${bad ? "text-destructive" : ""}`}
                        >
                          {text}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-baseline gap-2 border-t border-dashed border-[color-mix(in_oklab,var(--primary)_30%,var(--border))] px-3 py-2">
                  <span aria-hidden="true" className="font-mono text-[11px] text-primary">▸</span>
                  <p aria-live="polite" className={`text-[13px] ${sentence ? "" : "text-destructive"}`}>
                    {sentence ?? t("scheduler.sentenceEmpty")}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {PATTERNS.map((pattern) => (
                  <button
                    key={pattern.cron}
                    type="button"
                    title={pattern.cron}
                    onClick={() => patchCron({
                      value: parseScheduleCron(pattern.cron),
                      raw: pattern.cron,
                      changed: true,
                      parseError: false,
                    })}
                    className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[7px] border border-dashed
                      border-[color-mix(in_oklab,var(--amb)_40%,var(--border))] bg-muted/55 px-2.5
                      font-mono text-[11px] tracking-[0.02em] text-muted-foreground transition-colors
                      hover:border-solid hover:border-[color-mix(in_oklab,var(--amb)_65%,transparent)]
                      hover:bg-[color-mix(in_oklab,var(--amb)_10%,transparent)] hover:text-foreground
                      focus-visible:outline-none focus-visible:border-solid"
                  >
                    <span aria-hidden="true" className="text-[9px] text-[var(--amb)]">▸</span>
                    {t(pattern.nameKey)} {t(pattern.descKey)}
                  </button>
                ))}
              </div>

              {DIAL_ORDER.map((key) => {
                const meta = SCHEDULE_CRON_FIELDS.find((field) => field.key === key)!;
                const label = t(`scheduler.cronField.${key}`);
                const field: ScheduleCronField = draft.cron.value[key];
                const isAny = field.mode === "any";
                const summary = isAny ? "*" : field.values.length > 0 ? field.values.join(",") : t("scheduler.dialSummaryEmpty");
                const summaryBad = !isAny && field.values.length === 0;
                return (
                  <div key={key} className="rounded-[10px] border border-border/70 px-3 pt-2.5 pb-3">
                    <div className="mb-2 flex items-center gap-2.5">
                      <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
                        {label}
                      </span>
                      <span
                        title={summary}
                        className={`ml-auto max-w-[45%] truncate font-mono text-[11px] tabular-nums ${summaryBad ? "text-destructive" : "text-muted-foreground"}`}
                      >
                        {summary}
                      </span>
                      <button
                        type="button"
                        aria-pressed={isAny}
                        onClick={() => handleAnyChip(key, meta.min)}
                        className={`inline-flex h-5.5 cursor-pointer items-center rounded-full border px-2.5
                          font-mono text-[11px] transition-colors
                          ${isAny
                            ? "border-solid border-[color-mix(in_oklab,var(--amb)_70%,transparent)] bg-[color-mix(in_oklab,var(--amb)_14%,transparent)] text-foreground"
                            : "border-dashed border-[color-mix(in_oklab,var(--amb)_40%,var(--border))] bg-transparent text-muted-foreground"}`}
                      >
                        {t("scheduler.any")}
                      </button>
                    </div>
                    <div className={`flex flex-wrap gap-1 ${isAny ? "pointer-events-none opacity-30" : ""}`}>
                      {Array.from({ length: meta.max - meta.min + 1 }, (_, index) => meta.min + index).map((value) => {
                        const display = key === "weekday" ? t(`scheduler.weekday.${value}`) : String(value);
                        const pressed = !isAny && field.values.includes(value);
                        return (
                          <button
                            key={value}
                            type="button"
                            aria-pressed={pressed}
                            aria-label={`${label} ${display}`}
                            onClick={() => handleToken(key, value)}
                            className={`inline-flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-[7px] px-1.5
                              border-none font-mono text-xs tabular-nums transition-colors
                              ${pressed
                                ? "bg-primary font-semibold text-primary-foreground"
                                : "bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                          >
                            {display}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {draft.cron.value.day.mode === "values" && draft.cron.value.weekday.mode === "values" && (
                <p className="text-xs text-muted-foreground">{t("scheduler.dateOrHint")}</p>
              )}
            </section>

            {/* —— 参数：动作 / 工作流是 JSON；AI 任务是结构化输入 —— */}
            {draft.targetKind === "ai" ? (
              <section className="grid gap-2.5" aria-labelledby="schedule-ai-inputs-heading">
                <div>
                  <h2 id="schedule-ai-inputs-heading" className="text-sm font-semibold">{t("scheduler.aiInputs")}</h2>
                  <p className="text-xs text-muted-foreground">{t("scheduler.aiInputsHint")}</p>
                </div>
                {(aiTask?.params ?? []).map((spec) => (
                  <AiInputField
                    key={spec.id}
                    id={spec.id}
                    label={spec.label || spec.id}
                    description={spec.description}
                    multiline={spec.type === "textarea"}
                    value={draft.aiValues[spec.id] ?? ""}
                    placeholder={spec.default ? t("scheduler.aiInputDefault", { value: spec.default }) : undefined}
                    onChange={(value) => patchAiValue(spec.id, value)}
                  />
                ))}
                {AI_RESERVED_FIELDS.map(({ key, labelKey }) => (
                  <AiInputField
                    key={key}
                    id={key}
                    label={t(labelKey)}
                    multiline
                    value={draft.aiValues[key] ?? ""}
                    onChange={(value) => patchAiValue(key, value)}
                  />
                ))}
              </section>
            ) : (
              <section className="grid gap-2">
                <label className="grid gap-1 text-sm" htmlFor="schedule-params">
                  <span className="font-semibold">{t("scheduler.params")}</span>
                  <Textarea
                    id="schedule-params"
                    className="min-h-32 font-mono text-xs"
                    value={draft.paramsText}
                    placeholder="{}"
                    onChange={(event) => patch({ paramsText: event.target.value })}
                  />
                </label>
                <p className={`text-xs ${paramsValid ? "text-success" : "text-destructive"}`}>
                  {paramsValid ? t("scheduler.paramsOk") : t("scheduler.paramsBad")}
                </p>
              </section>
            )}

          {draft.error && <p className="text-sm text-destructive" role="alert">{draft.error}</p>}
          </div>
        </div>

        <SheetFooter className="flex-row justify-end border-t px-6 py-3">
          <Button variant="outline" onClick={closeScheduleForm}>{t("scheduler.cancel")}</Button>
          <Button onClick={() => void handleSave()}>{t("scheduler.save")}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// AI 目标参数区的一个输入：已声明参数（label 取参数的 label）或保留运行参数。
// 值统一是文本：list / arguments 类型在这里写 JSON 字符串（与「值必须是标量或 JSON 字符串」一致）。
function AiInputField({
  id, label, description, value, placeholder, multiline, onChange,
}: {
  // id 是参数的 key：DOM id 必须稳定且合法，不能用会随语言变化的 label 拼
  id: string;
  label: string;
  description?: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  onChange: (value: string) => void;
}) {
  const domId = `schedule-ai-${id}`;
  return (
    <div className="grid gap-1">
      <label className="text-sm font-medium" htmlFor={domId}>{label}</label>
      {multiline ? (
        <Textarea
          id={domId}
          className="min-h-20 font-mono text-xs"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={domId}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}
