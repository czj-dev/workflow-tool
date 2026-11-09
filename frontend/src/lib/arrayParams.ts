export interface ArgumentRow {
  flag: string;
  values: string[];
}

function parseArray(raw: string): unknown[] {
  if (!raw.trim()) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error("Expected a JSON array");
  return value;
}

export function parseStringList(raw: string): string[] {
  const items = parseArray(raw);
  if (!items.every((item) => typeof item === "string")) {
    throw new Error("Expected a JSON string array");
  }
  return items;
}

export function parseArgumentRows(raw: string): ArgumentRow[] {
  return parseArray(raw).map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Expected argument rows");
    }
    const row = item as Record<string, unknown>;
    if (typeof row.flag !== "string" || !Array.isArray(row.values) ||
      !row.values.every((value) => typeof value === "string")) {
      throw new Error("Expected argument rows with string flags and values");
    }
    return { flag: row.flag, values: row.values };
  });
}

interface ArrayParamSpec {
  id: string;
  type: string;
  default?: string;
}

export function normalizeArrayParams(
  params: ArrayParamSpec[],
  values: Record<string, string>,
): Record<string, string> {
  const emptyArrays = Object.fromEntries(params
    .filter((param) => (param.type === "list" || param.type === "arguments") &&
      !(values[param.id] ?? param.default ?? "").trim())
    .map((param) => [param.id, "[]"]));
  return { ...values, ...emptyArrays };
}

export function invalidArrayParams(
  params: ArrayParamSpec[],
  values: Record<string, string | undefined>,
  ignoredIds: string[] = [],
): string[] {
  return params.filter((param) => {
    if (ignoredIds.includes(param.id) || (param.type !== "list" && param.type !== "arguments")) return false;
    const raw = values[param.id] ?? param.default ?? "";
    try {
      if (param.type === "list") parseStringList(raw);
      else parseArgumentRows(raw);
      return false;
    } catch {
      return true;
    }
  }).map((param) => param.id);
}
