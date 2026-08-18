import { useEffect, useState } from "react";
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

// 保存为预设弹窗：名称必填 + 描述可选。确定时调 addPreset（values 优先，否则当前
// formValues），成功后关闭并清空输入；失败在弹窗内显示错误。
// values：非表单调用方（logcat 甲板）携带的完整参数集。
export function SavePresetDialog({
  open,
  onClose,
  values,
}: {
  open: boolean;
  onClose: () => void;
  values?: Record<string, string>;
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

  // 打开时重置，避免跨动作残留状态泄漏
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleClose = () => {
    reset();
    onClose();
  };

  const onConfirm = async () => {
    if (!canConfirm) return;
    try {
      await addPreset(name.trim(), desc.trim(), values);
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
