import { useTranslation } from "react-i18next";
import { Add01Icon, ArrowDown01Icon, ArrowUp01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import type { ParamSpec } from "../../bindings/workflow-tool/internal/registry/models.js";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { IconButton } from "./IconButton";
import { parseArgumentRows, parseStringList, type ArgumentRow } from "../lib/arrayParams";

interface ArrayParamFieldProps {
  spec: ParamSpec;
  value: string;
  setValue: (id: string, value: string) => void;
}

function move<T>(items: T[], index: number, to: number): T[] {
  return items.map((item, i) => i === index ? items[to] : i === to ? items[index] : item);
}

interface RowControlsProps<T> {
  items: T[];
  index: number;
  label: string;
  onChange: (next: T[]) => void;
}

function RowControls<T>({ items, index, label, onChange }: RowControlsProps<T>) {
  const { t } = useTranslation();
  return <>
    <IconButton icon={ArrowUp01Icon} label={t("form.arrayMoveUp", { label })}
      disabled={index === 0} onClick={() => onChange(move(items, index, index - 1))} />
    <IconButton icon={ArrowDown01Icon} label={t("form.arrayMoveDown", { label })}
      disabled={index === items.length - 1} onClick={() => onChange(move(items, index, index + 1))} />
    <IconButton icon={Delete02Icon} label={t("form.arrayRemove", { label })}
      onClick={() => onChange(items.filter((_, i) => i !== index))} />
  </>;
}

export function ArrayParamField({ spec, value, setValue }: ArrayParamFieldProps) {
  const { t } = useTranslation();
  const isList = spec.type === "list";
  let items: string[] | ArgumentRow[] = [];
  let invalid = false;
  try {
    items = isList ? parseStringList(value) : parseArgumentRows(value);
  } catch {
    invalid = true;
  }
  const save = (next: string[] | ArgumentRow[]) => setValue(spec.id, JSON.stringify(next));
  const addLabel = t("form.arrayAdd", { label: spec.label });
  const itemLabel = (index: number) => `${spec.label} ${index + 1}`;

  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel>{spec.label}{spec.required && <span className="text-destructive"> *</span>}</FieldLabel>
        {invalid ? (
          <Button type="button" variant="outline" size="sm" onClick={() => save([])}>
            {t("form.arrayReset", { label: spec.label })}
          </Button>
        ) : (
          <IconButton icon={Add01Icon} label={addLabel} variant="outline"
            onClick={() => save(isList ? [...items as string[], ""] : [...items as ArgumentRow[], { flag: "", values: [] }])} />
        )}
      </div>
      {invalid && <p role="alert" className="text-xs text-destructive">
        {t(isList ? "form.jsonListInvalid" : "form.jsonArgumentsInvalid")}
      </p>}
      {!invalid && isList && (items as string[]).map((entry, index, rows) => (
        <div key={index} className="flex min-w-0 items-center gap-1.5">
          <Input aria-label={itemLabel(index)} value={entry} className="min-w-0 flex-1"
            onChange={(event) => save(rows.map((old, i) => i === index ? event.target.value : old))} />
          <RowControls items={rows} index={index} label={itemLabel(index)} onChange={save} />
        </div>
      ))}
      {!invalid && !isList && (items as ArgumentRow[]).map((row, index, rows) => (
        <div key={index} className="space-y-1.5 border-l-2 border-border pl-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Input aria-label={`${itemLabel(index)} flag`} value={row.flag} className="min-w-0 flex-1 font-mono"
              onChange={(event) => save(rows.map((old, i) => i === index ? { ...old, flag: event.target.value } : old))} />
            <RowControls items={rows} index={index} label={itemLabel(index)} onChange={save} />
          </div>
          {row.values.map((entry, valueIndex) => (
            <div key={valueIndex} className="flex min-w-0 items-center gap-1.5 pl-3">
              <Input aria-label={`${itemLabel(index)} ${t("form.arrayValue")} ${valueIndex + 1}`}
                value={entry} className="min-w-0 flex-1"
                onChange={(event) => save(rows.map((old, i) => i === index
                  ? { ...old, values: old.values.map((v, j) => j === valueIndex ? event.target.value : v) } : old))} />
              <RowControls items={row.values} index={valueIndex}
                label={`${itemLabel(index)} ${t("form.arrayValue")} ${valueIndex + 1}`}
                onChange={(next) => save(rows.map((old, i) => i === index
                  ? { ...old, values: next } : old))} />
            </div>
          ))}
          <IconButton icon={Add01Icon} label={t("form.arrayAdd", { label: `${itemLabel(index)} ${t("form.arrayValue")}` })}
            onClick={() => save(rows.map((old, i) => i === index
              ? { ...old, values: [...old.values, ""] } : old))} />
        </div>
      ))}
      {spec.description && <FieldDescription className="text-xs">{spec.description}</FieldDescription>}
    </Field>
  );
}
