import type { ParamSpec } from "../../bindings/workflow-tool/internal/registry/models.js";
import { parseArgumentRows, parseStringList } from "./arrayParams";

export function resolveActionParams(
  params: ParamSpec[] | null | undefined,
  globalConfig: Record<string, string>,
  presetValues?: Record<string, string | undefined> | null,
): Record<string, string> {
  const defaults = Object.fromEntries(
    (params ?? []).map((spec) => [spec.id, spec.default || globalConfig[spec.id] || ""]),
  );
  const preset = Object.fromEntries(
    Object.entries(presetValues ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { ...defaults, ...preset };
}

// missingRequired 返回未填的 required 参数（供父组件禁用运行按钮）。
export function missingRequired(
  params: ParamSpec[],
  values: Record<string, string>,
): ParamSpec[] {
  return params.filter((p) => {
    if (!p.required) return false;
    const value = values[p.id]?.trim() ?? "";
    if (!value) return true;
    try {
      if (p.type === "list") return parseStringList(value).length === 0;
      if (p.type === "arguments") return parseArgumentRows(value).length === 0;
    } catch {
      return false; // 格式错误由 invalidArrayParams 单独提示
    }
    return false;
  });
}

// hasFormFields 判断「是否值得进表单」：存在「必填且无默认值」的参数 → true（有必须手填的内容）；
// 否则（全可选，或必填项都有默认值）返回 false，调用方应直接运行（默认值由后端回填），
// 避免弹一个无需填写的表单（如 adb-scrcpy 全可选带默认值、adb-debug-activity 必填带默认值）。
export function hasFormFields(params: ParamSpec[] | undefined | null): boolean {
  return missingRequired(params ?? [], Object.fromEntries((params ?? []).map((p) => [p.id, p.default ?? ""]))).length > 0;
}
