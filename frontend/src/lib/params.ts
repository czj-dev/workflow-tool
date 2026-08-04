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
