import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlayIcon, ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useActionRunner } from "../hooks/useActionRunner";
import { SavePresetDialog } from "./SavePresetDialog";
import { ParamFields } from "./ParamFields";
import { missingRequired } from "../lib/params";
import type { ParamSpec } from "../../bindings/workflow-tool/internal/registry/models.js";

// LlmForm 是 command.llm 一等形态的专用表单：
// - prompt param（`action.llm.promptParam`）为主位：动态、每次都改
// - system param（`action.llm.systemParam`）折叠为「角色设定」，默认收起（稳定模板，偶尔调）
// - 其余 param（被 prompt 模板 ${VAR} 引用的动态输入）渲染在两者之间
// 与 ParamForm 共用 ParamFields 原子，仅重排结构；运行/校验/保存预设逻辑与之等价。
export function LlmForm() {
  const { t } = useTranslation();
  const { actions, currentId, formValues, setFormValue, runAction } =
    useActionRunner();
  const action = actions.find((a) => a.id === currentId);
  const [saveOpen, setSaveOpen] = useState(false);
  const [roleOpen, setRoleOpen] = useState(false);

  if (!action?.llm || !action.params || action.params.length === 0) return null;

  const { systemParam, promptParam } = action.llm;

  // 按角色（system/prompt/其他）拆分 params，保持原顺序稳定
  const systemSpec = systemParam
    ? action.params.find((p) => p.id === systemParam) ?? null
    : null;
  const promptSpec = action.params.find((p) => p.id === promptParam) ?? null;
  const contextSpecs: ParamSpec[] = action.params.filter(
    (p) => p.id !== systemParam && p.id !== promptParam,
  );

  if (!promptSpec) return null;

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
      {systemSpec && (
        <Collapsible open={roleOpen} onOpenChange={setRoleOpen}>
          <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 rounded-lg border bg-muted/20 px-3.5 py-2.5 text-left hover:bg-muted/40">
            <HugeiconsIcon
              icon={roleOpen ? ArrowDown01Icon : ArrowRight01Icon}
              strokeWidth={1.75}
              className="size-4 text-muted-foreground"
            />
            <span className="text-sm font-medium">{t("llm.role")}</span>
            <span className="ml-auto truncate text-xs text-muted-foreground">
              {roleOpen ? "" : t("llm.roleHint")}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <ParamFields
              params={[systemSpec]}
              values={formValues}
              setValue={setFormValue}
            />
          </CollapsibleContent>
        </Collapsible>
      )}
      {contextSpecs.length > 0 && (
        <ParamFields
          params={contextSpecs}
          values={formValues}
          setValue={setFormValue}
        />
      )}
      <ParamFields
        params={[promptSpec]}
        values={formValues}
        setValue={setFormValue}
      />
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={() => setSaveOpen(true)}>
          {t("main.save")}
        </Button>
        <Button disabled={!canRun} onClick={onRun}>
          <HugeiconsIcon icon={PlayIcon} strokeWidth={1.75} className="size-4" />
          {t("main.run")}
        </Button>
      </div>
      <SavePresetDialog open={saveOpen} onClose={() => setSaveOpen(false)} />
    </FieldGroup>
  );
}
