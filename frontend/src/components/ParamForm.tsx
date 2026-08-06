import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, PlayIcon } from "@hugeicons/core-free-icons";
import { useActionRunner } from "../hooks/useActionRunner";
import { SavePresetDialog } from "./SavePresetDialog";
import { ParamFields } from "./ParamFields";
import { missingRequired } from "../lib/params";

// ParamForm 按当前动作的 ParamSpec 渲染表单，required 校验控制「运行」按钮。
// 字段渲染复用 ParamFields（与 workflow 参数表单共用）。提交调 runAction(id, formValues)。
export function ParamForm() {
  const { t } = useTranslation();
  const { actions, currentId, formValues, setFormValue, runAction, setView } =
    useActionRunner();
  const action = actions.find((a) => a.id === currentId);
  const [saveOpen, setSaveOpen] = useState(false);
  if (!action || !action.params || action.params.length === 0) return null;

  const canRun = missingRequired(action.params, formValues).length === 0;

  const onRun = () => {
    if (!canRun) return;
    const params: Record<string, string> = {};
    action.params!.forEach((p) => {
      params[p.id] = formValues[p.id] ?? p.default ?? "";
    });
    runAction(action.id, params);
  };

  return (
    <FieldGroup className="p-4">
      <ParamFields
        params={action.params}
        values={formValues}
        setValue={setFormValue}
      />
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setView("actions-grid")}
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={1.75} className="size-4" />
          {t("sidebar.allActions")}
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setSaveOpen(true)}>
            {t("main.save")}
          </Button>
          <Button disabled={!canRun} onClick={onRun}>
            <HugeiconsIcon icon={PlayIcon} strokeWidth={1.75} className="size-4" />
            {t("main.run")}
          </Button>
        </div>
      </div>
      <SavePresetDialog open={saveOpen} onClose={() => setSaveOpen(false)} />
    </FieldGroup>
  );
}
