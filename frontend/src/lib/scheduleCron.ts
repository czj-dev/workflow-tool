export type ScheduleCronField = {
  mode: "any" | "values";
  values: number[];
};

export type ScheduleCron = {
  minute: ScheduleCronField;
  hour: ScheduleCronField;
  day: ScheduleCronField;
  month: ScheduleCronField;
  weekday: ScheduleCronField;
};

export const SCHEDULE_CRON_FIELDS = [
  { key: "minute", min: 0, max: 59 },
  { key: "hour", min: 0, max: 23 },
  { key: "day", min: 1, max: 31 },
  { key: "month", min: 1, max: 12 },
  { key: "weekday", min: 0, max: 6 },
] as const satisfies ReadonlyArray<{
  key: keyof ScheduleCron;
  min: number;
  max: number;
}>;

function parseField(value: string, min: number, max: number): ScheduleCronField {
  if (value === "*") return { mode: "any", values: [] };
  if (!value || value.includes("/")) throw new Error(`Invalid cron field: ${value}`);

  const values = new Set<number>();
  for (const part of value.split(",")) {
    if (!part) throw new Error(`Invalid cron field: ${value}`);
    const [startText, endText] = part.split("-");
    if (part.split("-").length > 2 || !/^\d+$/.test(startText) || (endText !== undefined && !/^\d+$/.test(endText))) {
      throw new Error(`Invalid cron field: ${value}`);
    }
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`Invalid cron field: ${value}`);
    }
    for (let current = start; current <= end; current += 1) values.add(current);
  }
  if (values.size === 0) throw new Error(`Invalid cron field: ${value}`);
  return { mode: "values", values: [...values].sort((a, b) => a - b) };
}

export function parseScheduleCron(expression: string): ScheduleCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron must contain five fields");
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    day: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    weekday: parseField(fields[4], 0, 6),
  };
}

function serializeField(field: ScheduleCronField): string {
  if (field.mode === "any") return "*";
  if (field.values.length === 0) throw new Error("Cron field must select at least one value");
  return [...new Set(field.values)].sort((a, b) => a - b).join(",");
}

export function serializeScheduleCron(cron: ScheduleCron): string {
  return [cron.minute, cron.hour, cron.day, cron.month, cron.weekday].map(serializeField).join(" ");
}

export function updateScheduleCronField<K extends keyof ScheduleCron>(
  cron: ScheduleCron,
  key: K,
  field: ScheduleCron[K],
): ScheduleCron {
  return { ...cron, [key]: { mode: field.mode, values: [...field.values] } } as ScheduleCron;
}

// 读数槽文本："*"（任意）/ "1,15"（已选）/ "?"（空选，由调用方染红）。
export function formatScheduleCronField(field: ScheduleCronField): string {
  if (field.mode === "any") return "*";
  return field.values.length > 0 ? field.values.join(",") : "?";
}

// i18n 注入的最小翻译函数形状（i18next 的 t 满足此结构）。
export type ScheduleTranslate = (key: string, options?: Record<string, unknown>) => string;

const CRON_FIELD_ORDER: ReadonlyArray<keyof ScheduleCron> = ["minute", "hour", "day", "month", "weekday"];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// 人读句子（定稿规则）：分×时组合 ≤4 全部展开成句；hour 任意+minute 固定 → 每小时 :MM；
// 双任意 → 每分钟；其余回落原始表达式。周 1-5 → 工作日；day∪weekday 按「或」连接（vixie 并集）；
// 月限定作前缀；「每小时/每分钟」不前缀「每天」。有字段被清空（values 模式空选）→ 返回 null（调用方显示空选警示）。
export function describeScheduleCron(cron: ScheduleCron, t: ScheduleTranslate): string | null {
  if (CRON_FIELD_ORDER.some((key) => cron[key].mode === "values" && cron[key].values.length === 0)) return null;

  const sep = t("scheduler.sentence.sep");
  // 令牌列表：>4 项截成前 4 + 省略号
  const list = (items: string[]) => (items.length > 4 ? `${items.slice(0, 4).join(sep)}…` : items.join(sep));

  let time: string | null = null;
  if (cron.minute.mode === "any" && cron.hour.mode === "any") {
    time = t("scheduler.sentence.everyMinute");
  } else if (cron.hour.mode === "any") {
    time = t("scheduler.sentence.hourly", { list: list(cron.minute.values.map(pad2)) });
  } else if (cron.minute.mode !== "any" && cron.minute.values.length * cron.hour.values.length <= 4) {
    const points: string[] = [];
    for (const hour of cron.hour.values) {
      for (const minute of cron.minute.values) points.push(`${pad2(hour)}:${pad2(minute)}`);
    }
    points.sort();
    time = points.join(sep);
  }
  if (time === null) return serializeScheduleCron(cron); // 组合过多 / 分任意×时受限

  const dayParts: string[] = [];
  if (cron.weekday.mode !== "any") {
    const weekdays = cron.weekday.values;
    const isWorkweek = weekdays.length === 5 && [1, 2, 3, 4, 5].every((value) => weekdays.includes(value));
    if (weekdays.length === 7) {
      // 全周 = 每天，不加限定
    } else if (isWorkweek) {
      dayParts.push(t("scheduler.sentence.workweek"));
    } else {
      dayParts.push(t("scheduler.sentence.weekdayList", { list: list(weekdays.map((value) => t(`scheduler.weekday.${value}`))) }));
    }
  }
  if (cron.day.mode !== "any") {
    dayParts.push(t("scheduler.sentence.dayList", { list: list(cron.day.values.map(String)) }));
  }
  let day = dayParts.join(t("scheduler.sentence.or")); // cron 语义：日与周同时受限取并集
  if (!day) {
    const isEveryMinute = cron.minute.mode === "any" && cron.hour.mode === "any";
    const isHourly = cron.hour.mode === "any" && cron.minute.mode !== "any";
    if (isEveryMinute && cron.month.mode === "any") return t("scheduler.sentence.everyMinute");
    if (isHourly && cron.month.mode === "any") return time; // 每小时已含每天
    day = t("scheduler.sentence.everyDay");
  }
  const scope = cron.month.mode === "any"
    ? ""
    : t("scheduler.sentence.monthScope", { list: list(cron.month.values.map(String)) });
  return scope ? `${scope} ${day} ${time}` : `${day} ${time}`;
}

// 未来触发时刻（本地时区）：从 from 的下一分钟起向后扫描，最多 count 个、400 天为界。
// day 与 weekday 同时受限时取并集（vixie cron 语义，与描述句一致）。
export function nextScheduleRuns(expression: string, count = 3, from = new Date()): Date[] {
  const cron = parseScheduleCron(expression);
  const out: Date[] = [];
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = new Date(from.getTime() + 400 * 864e5);
  const matches = (field: ScheduleCronField, value: number) => field.mode === "any" || field.values.includes(value);
  while (out.length < count && cursor < limit) {
    if (!matches(cron.minute, cursor.getMinutes())) { cursor.setMinutes(cursor.getMinutes() + 1); continue; }
    if (!matches(cron.hour, cursor.getHours())) { cursor.setHours(cursor.getHours() + 1, 0, 0, 0); continue; }
    if (!matches(cron.month, cursor.getMonth() + 1)) { cursor.setMonth(cursor.getMonth() + 1, 1); cursor.setHours(0, 0, 0, 0); continue; }
    const domAny = cron.day.mode === "any";
    const dowAny = cron.weekday.mode === "any";
    let dayOk: boolean;
    if (domAny && dowAny) dayOk = true;
    else if (domAny) dayOk = cron.weekday.values.includes(cursor.getDay());
    else if (dowAny) dayOk = cron.day.values.includes(cursor.getDate());
    else dayOk = cron.day.values.includes(cursor.getDate()) || cron.weekday.values.includes(cursor.getDay());
    if (!dayOk) { cursor.setDate(cursor.getDate() + 1); cursor.setHours(0, 0, 0, 0); continue; }
    out.push(new Date(cursor));
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return out;
}

// 下次时间措辞：今天/明天 HH:mm；今年 MM-DD HH:mm；更早年份补全 YYYY-MM-DD。
export function formatScheduleNextRun(date: Date, t: ScheduleTranslate): string {
  const now = new Date();
  const hm = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return `${t("scheduler.today")} ${hm}`;
  const tomorrow = new Date(now.getTime() + 864e5);
  if (date.toDateString() === tomorrow.toDateString()) return `${t("scheduler.tomorrow")} ${hm}`;
  const md = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return date.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${date.getFullYear()}-${md}`;
}
