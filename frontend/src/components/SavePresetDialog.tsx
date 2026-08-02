import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useActionRunner } from "../hooks/useActionRunner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";

// 保存为预设弹窗：名称必填 + 描述可选。确定时调 addPreset（当前 formValues），
// 成功后关闭并清空输入；失败在弹窗内显示错误。
export function SavePresetDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { addPreset } = useActionRunner();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [error, setError] = useState("");

  const canConfirm = name.trim().length > 0;

  const reset = () => {
    setName("");
    setDesc("");
    setError("");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const onConfirm = async () => {
    if (!canConfirm) return;
    try {
      await addPreset(name.trim(), desc.trim());
      reset();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleClose();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("preset.title")}</DialogTitle>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="preset-name">{t("preset.nameLabel")}</FieldLabel>
          <Input
            id="preset-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("preset.namePlaceholder")}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="preset-desc">{t("preset.descLabel")}</FieldLabel>
          <Input
            id="preset-desc"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder={t("preset.descPlaceholder")}
          />
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {t("preset.cancel")}
          </Button>
          <Button disabled={!canConfirm} onClick={onConfirm}>
            {t("preset.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
