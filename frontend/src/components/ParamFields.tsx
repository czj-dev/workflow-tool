import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { cn } from "@/lib/utils";
import type { ParamSpec } from "../../bindings/workflow-tool/internal/registry/models.js";
import { useActionRunner } from "../hooks/useActionRunner";

interface ParamFieldsProps {
  params: ParamSpec[];
  values: Record<string, string>;
  setValue: (id: string, value: string) => void;
}
export function ParamFields({ params, values, setValue }: ParamFieldsProps) {
  const { t } = useTranslation();
  const { pickDirectory, pickFile } = useActionRunner();
  // 拖拽高亮的字段 id：拖文件到 text/path 输入框时给一圈琥珀 ring 反馈
  const [dragId, setDragId] = useState<string | null>(null);

  const onDrop = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    setDragId(null);
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
          // bool 渲染为「设置开关行」：独立卡片块（与输入卡片同质感），左 label 右 Switch
          return (
            <Field
              key={p.id}
              orientation="horizontal"
              className="rounded-lg border border-border bg-card px-3.5 py-2.5 shadow-[var(--card-sh)]"
            >
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

        if (p.type === "path" || p.type === "file") {
          // path 走目录选择器，file 走文件选择器；其余 UI 一致。
          const pick = p.type === "file" ? pickFile : pickDirectory;
          return (
            <Field key={p.id}>
              <FieldLabel htmlFor={p.id}>{renderLabel(p)}</FieldLabel>
              <ButtonGroup>
                <Input
                  id={p.id}
                  value={values[p.id] ?? p.default ?? ""}
                  onChange={(e) => setValue(p.id, e.target.value)}
                  onDrop={(e) => onDrop(e, p.id)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragId(p.id);
                  }}
                  onDragLeave={() => setDragId((cur) => (cur === p.id ? null : cur))}
                  className={cn(
                    dragId === p.id && "border-primary ring-2 ring-primary/40"
                  )}
                />
                <Button
                  variant="outline"
                  onClick={async () => {
                    const d = await pick();
                    if (d) setValue(p.id, d);
                  }}
                >
                  {t("main.choose")}
                </Button>
              </ButtonGroup>
            </Field>
          );
        }

        if (p.type === "textarea") {
          // 多行长文本（如 LLM prompt 模板）：field-sizing-content 自适应高度，min 6 行
          return (
            <Field key={p.id}>
              <FieldLabel htmlFor={p.id}>{renderLabel(p)}</FieldLabel>
              <Textarea
                id={p.id}
                value={values[p.id] ?? p.default ?? ""}
                onChange={(e) => setValue(p.id, e.target.value)}
                className="min-h-36"
              />
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
              onDragOver={(e) => {
                e.preventDefault();
                setDragId(p.id);
              }}
              onDragLeave={() => setDragId((cur) => (cur === p.id ? null : cur))}
              className={cn(dragId === p.id && "border-primary ring-2 ring-primary/40")}
            />
          </Field>
        );
      })}
    </>
  );
}
