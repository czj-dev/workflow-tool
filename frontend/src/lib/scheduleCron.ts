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
