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
  const next = [...items];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
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
          <IconButton icon={ArrowUp01Icon} label={t("form.arrayMoveUp", { label: itemLabel(index) })}
            disabled={index === 0} onClick={() => save(move(rows, index, index - 1))} />
          <IconButton icon={ArrowDown01Icon} label={t("form.arrayMoveDown", { label: itemLabel(index) })}
            disabled={index === rows.length - 1} onClick={() => save(move(rows, index, index + 1))} />
          <IconButton icon={Delete02Icon} label={t("form.arrayRemove", { label: itemLabel(index) })}
            onClick={() => save(rows.filter((_, i) => i !== index))} />
        </div>
      ))}
      {!invalid && !isList && (items as ArgumentRow[]).map((row, index, rows) => (
        <div key={index} className="space-y-1.5 border-l-2 border-border pl-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Input aria-label={`${itemLabel(index)} flag`} value={row.flag} className="min-w-0 flex-1 font-mono"
              onChange={(event) => save(rows.map((old, i) => i === index ? { ...old, flag: event.target.value } : old))} />
            <IconButton icon={ArrowUp01Icon} label={t("form.arrayMoveUp", { label: itemLabel(index) })}
              disabled={index === 0} onClick={() => save(move(rows, index, index - 1))} />
            <IconButton icon={ArrowDown01Icon} label={t("form.arrayMoveDown", { label: itemLabel(index) })}
              disabled={index === rows.length - 1} onClick={() => save(move(rows, index, index + 1))} />
            <IconButton icon={Delete02Icon} label={t("form.arrayRemove", { label: itemLabel(index) })}
              onClick={() => save(rows.filter((_, i) => i !== index))} />
          </div>
          {row.values.map((entry, valueIndex) => (
            <div key={valueIndex} className="flex min-w-0 items-center gap-1.5 pl-3">
              <Input aria-label={`${itemLabel(index)} ${t("form.arrayValue")} ${valueIndex + 1}`}
                value={entry} className="min-w-0 flex-1"
                onChange={(event) => save(rows.map((old, i) => i === index
                  ? { ...old, values: old.values.map((v, j) => j === valueIndex ? event.target.value : v) } : old))} />
              <IconButton icon={ArrowUp01Icon}
                label={t("form.arrayMoveUp", { label: `${itemLabel(index)} ${t("form.arrayValue")} ${valueIndex + 1}` })}
                disabled={valueIndex === 0}
                onClick={() => save(rows.map((old, i) => i === index
                  ? { ...old, values: move(old.values, valueIndex, valueIndex - 1) } : old))} />
              <IconButton icon={ArrowDown01Icon}
                label={t("form.arrayMoveDown", { label: `${itemLabel(index)} ${t("form.arrayValue")} ${valueIndex + 1}` })}
                disabled={valueIndex === row.values.length - 1}
                onClick={() => save(rows.map((old, i) => i === index
                  ? { ...old, values: move(old.values, valueIndex, valueIndex + 1) } : old))} />
              <IconButton icon={Delete02Icon}
                label={t("form.arrayRemove", { label: `${itemLabel(index)} ${t("form.arrayValue")} ${valueIndex + 1}` })}
                onClick={() => save(rows.map((old, i) => i === index
                  ? { ...old, values: old.values.filter((_, j) => j !== valueIndex) } : old))} />
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
