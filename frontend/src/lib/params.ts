import type { ParamSpec } from "../../bindings/workflow-tool/internal/registry/models.js";

// missingRequired 返回未填的 required 参数（供父组件禁用运行按钮）。
export function missingRequired(
  params: ParamSpec[],
  values: Record<string, string>,
): ParamSpec[] {
  return params.filter(
    (p) => p.required && !(values[p.id] && values[p.id].trim()),
  );
}

// hasFormFields 判断「是否值得进表单」：存在「必填且无默认值」的参数 → true（有必须手填的内容）；
// 否则（全可选，或必填项都有默认值）返回 false，调用方应直接运行（默认值由后端回填），
// 避免弹一个无需填写的表单（如 adb-scrcpy 全可选带默认值、adb-debug-activity 必填带默认值）。
export function hasFormFields(params: ParamSpec[] | undefined | null): boolean {
  return (params ?? []).some((p) => p.required && !p.default?.trim());
}
