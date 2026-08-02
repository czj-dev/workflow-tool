import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { useActionRunner } from "../hooks/useActionRunner";
import { SavePresetDialog } from "./SavePresetDialog";

// ParamForm 按当前动作的 ParamSpec 渲染表单（text/bool/select/path），
// required 校验控制「运行」按钮，path 支持「选择」按钮与拖拽填值。提交调 runAction(id, formValues)。
export function ParamForm() {
  const { t } = useTranslation();
  const { actions, currentId, formValues, setFormValue, runAction, pickDirectory } =
    useActionRunner();
  const action = actions.find((a) => a.id === currentId);
  const [saveOpen, setSaveOpen] = useState(false);
  if (!action || !action.params || action.params.length === 0) return null;

  // required 校验：所有 required 参数都已填非空
  const missing = action.params.filter(
    (p) => p.required && !(formValues[p.id] && formValues[p.id].trim())
  );
  const canRun = missing.length === 0;

  const onRun = () => {
    if (!canRun) return;
    // 把 formValues（含 select/bool）作为 params 传给后端
    const params: Record<string, string> = {};
    action.params!.forEach((p) => {
      params[p.id] = formValues[p.id] ?? p.default ?? "";
    });
    runAction(action.id, params);
  };

  const onDrop = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) setFormValue(id, (f as File & { path?: string }).path || f.name);
  };

  // 标签文案 + required 红色星号（测试靠 label 文本 / LabelText 命中，保留可见文本）
  const renderLabel = (p: { label?: string; required?: boolean }) => (
    <>
      {p.label}
      {p.required && <span className="text-destructive"> *</span>}
    </>
  );

  return (
    <FieldGroup className="p-4">
      {action.params.map((p) => {
        if (p.type === "bool") {
          // Switch 渲染 button[role=switch]，htmlFor 无意义；label 仅作可见文本，横向排列
          return (
            <Field key={p.id} orientation="horizontal">
              <FieldLabel>{renderLabel(p)}</FieldLabel>
              <Switch
                checked={formValues[p.id] === "true"}
                onCheckedChange={(c) => setFormValue(p.id, c ? "true" : "false")}
              />
            </Field>
          );
        }

        if (p.type === "select") {
          const cur = formValues[p.id] ?? p.default ?? "";
          // value 与 option 文本相同，SelectValue 直接显示选中值即可
          return (
            <Field key={p.id}>
              <FieldLabel>{renderLabel(p)}</FieldLabel>
              <Select value={cur} onValueChange={(v) => setFormValue(p.id, String(v ?? ""))}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t("main.choose")} />
                </SelectTrigger>
                <SelectContent>
                  {(p.options || []).map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          );
        }

        if (p.type === "path") {
          // 目录选择按钮作为 inline-end addon；InputGroupInput 透传 id → getByLabelText 可命中
          return (
            <Field key={p.id}>
              <FieldLabel htmlFor={p.id}>{renderLabel(p)}</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id={p.id}
                  value={formValues[p.id] ?? p.default ?? ""}
                  onChange={(e) => setFormValue(p.id, e.target.value)}
                  onDrop={(e) => onDrop(e, p.id)}
                  onDragOver={(e) => e.preventDefault()}
                />
                <InputGroupAddon align="inline-end">
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
                </InputGroupAddon>
              </InputGroup>
            </Field>
          );
        }

        // text：htmlFor + id 必须对齐 → findByLabelText(/网址/).user.type 才能命中
        return (
          <Field key={p.id}>
            <FieldLabel htmlFor={p.id}>{renderLabel(p)}</FieldLabel>
            <Input
              id={p.id}
              value={formValues[p.id] ?? p.default ?? ""}
              onChange={(e) => setFormValue(p.id, e.target.value)}
              onDrop={(e) => onDrop(e, p.id)}
              onDragOver={(e) => e.preventDefault()}
            />
          </Field>
        );
      })}
      <Button disabled={!canRun} onClick={onRun}>
        {t("main.run")}
      </Button>
      <Button variant="outline" onClick={() => setSaveOpen(true)}>
        {t("main.save")}
      </Button>
      <SavePresetDialog open={saveOpen} onClose={() => setSaveOpen(false)} />
    </FieldGroup>
  );
}
