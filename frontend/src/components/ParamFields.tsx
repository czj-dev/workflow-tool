import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ButtonGroup } from "@/components/ui/button-group";
import type { ParamSpec } from "../../bindings/workflow-tool/internal/registry/models.js";
import { useActionRunner } from "../hooks/useActionRunner";

interface ParamFieldsProps {
  params: ParamSpec[];
  values: Record<string, string>;
  setValue: (id: string, value: string) => void;
}
export function ParamFields({ params, values, setValue }: ParamFieldsProps) {
  const { t } = useTranslation();
  const { pickDirectory } = useActionRunner();

  const onDrop = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) setValue(id, (f as File & { path?: string }).path || f.name);
  };

  const renderLabel = (p: ParamSpec) => (
    <>
      {p.label}
      {p.required && <span className="text-destructive"> *</span>}
    </>
  );

  return (
    <>
      {params.map((p) => {
        if (p.type === "bool") {
          return (
            <Field key={p.id} orientation="horizontal">
              <FieldLabel>{renderLabel(p)}</FieldLabel>
              <Switch
                checked={values[p.id] === "true"}
                onCheckedChange={(c) => setValue(p.id, c ? "true" : "false")}
              />
            </Field>
          );
        }

        if (p.type === "select") {
          const cur = values[p.id] ?? p.default ?? "";
          return (
            <Field key={p.id}>
              <FieldLabel>{renderLabel(p)}</FieldLabel>
              <Select value={cur} onValueChange={(v) => setValue(p.id, String(v ?? ""))}>
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
          return (
            <Field key={p.id}>
              <FieldLabel htmlFor={p.id}>{renderLabel(p)}</FieldLabel>
              <ButtonGroup>
                <Input
                  id={p.id}
                  value={values[p.id] ?? p.default ?? ""}
                  onChange={(e) => setValue(p.id, e.target.value)}
                  onDrop={(e) => onDrop(e, p.id)}
                  onDragOver={(e) => e.preventDefault()}
                />
                <Button
                  variant="outline"
                  onClick={async () => {
                    const d = await pickDirectory();
                    if (d) setValue(p.id, d);
                  }}
                >
                  {t("main.choose")}
                </Button>
              </ButtonGroup>
            </Field>
          );
        }

        // text
        return (
          <Field key={p.id}>
            <FieldLabel htmlFor={p.id}>{renderLabel(p)}</FieldLabel>
            <Input
              id={p.id}
              value={values[p.id] ?? p.default ?? ""}
              onChange={(e) => setValue(p.id, e.target.value)}
              onDrop={(e) => onDrop(e, p.id)}
              onDragOver={(e) => e.preventDefault()}
            />
          </Field>
        );
      })}
    </>
  );
}
