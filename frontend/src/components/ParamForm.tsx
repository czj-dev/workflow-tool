import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useActionRunner } from "../hooks/useActionRunner";

// ParamForm 按当前动作的 ParamSpec 渲染表单（text/bool/select/path），
// required 校验控制「运行」按钮，path 支持「选择」按钮与拖拽填值。提交调 runAction(id, formValues)。
export function ParamForm() {
  const { t } = useTranslation();
  const { actions, currentId, formValues, setFormValue, runAction, pickDirectory } =
    useActionRunner();
  const action = actions.find((a) => a.id === currentId);
  if (!action || !action.params || action.params.length === 0) return null;

  // required 校验：所有 required 参数都已填非空
  const missing = action.params.filter(
    (p) => p.required && !(formValues[p.id] && formValues[p.id].trim())
  );
  const canRun = missing.length === 0;

  const onRun = () => {
    if (!canRun) return;
    // 把 formValues（含 select/bool）作为 params 传给后端
    const params: Record<string, any> = {};
    action.params!.forEach((p) => {
      params[p.id] = formValues[p.id] ?? p.default ?? "";
    });
    runAction(action.id, params);
  };

  const onDrop = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) setFormValue(id, (f as any).path || f.name);
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      {action.params.map((p) => (
        <div key={p.id} className="flex flex-col gap-1">
          <label htmlFor={p.id} className="text-sm font-medium">
            {p.label}
            {p.required && <span className="text-destructive"> *</span>}
          </label>
          {p.type === "bool" ? (
            <input
              id={p.id}
              type="checkbox"
              checked={formValues[p.id] === "true"}
              onChange={(e) => setFormValue(p.id, e.target.checked ? "true" : "false")}
            />
          ) : p.type === "select" ? (
            <select
              id={p.id}
              value={formValues[p.id] ?? p.default ?? ""}
              onChange={(e) => setFormValue(p.id, e.target.value)}
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none"
            >
              {(p.options || []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <div className="flex gap-2">
              <Input
                id={p.id}
                value={formValues[p.id] ?? p.default ?? ""}
                onChange={(e) => setFormValue(p.id, e.target.value)}
                onDrop={(e) => onDrop(e, p.id)}
                onDragOver={(e) => e.preventDefault()}
              />
              {p.type === "path" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    const d = await pickDirectory();
                    if (d) setFormValue(p.id, d);
                  }}
                >
                  {t("main.choose")}
                </Button>
              )}
            </div>
          )}
        </div>
      ))}
      <Button disabled={!canRun} onClick={onRun}>
        {t("main.run")}
      </Button>
    </div>
  );
}
