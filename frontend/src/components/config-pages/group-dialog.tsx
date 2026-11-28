// 新建 / 重命名分组对话框（规格 E）：名称 + 五色色卡 + 实时预览。
// 预览画的就是页面上的分区——同一个 SectionHead + 同一支 tint-card 条目卡，
// 换色时预览跟着变，用来说明「颜色只动色块、底色和行首图标，文字不变色」。
// 组件是纯展示：提交回调把 (name, color) 交还页面，由页面接线分组的写穿操作。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, Folder01Icon, Link01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { SectionHead } from "./section-head";
import { Swatches } from "./swatch";
import { HEAD_ACTION, SWATCH_BG, type AmbColor } from "@/lib/amb-colors";

/** 预览里的两行样例：排版同真实条目。 */
const PREVIEW_ROWS = [
  { key: "OUTPUT_DIR", value: "${DOCS}/out", refs: 3 },
  { key: "LOGS_DIR", value: "${DOCS}/logs", refs: 1 },
];

export function GroupDialog({
  mode,
  initialName = "",
  initialColor,
  /** 与当前名称冲突才算重名（重命名自身不算） */
  existingNames,
  onSubmit,
  onClose,
}: {
  mode: "create" | "rename";
  initialName?: string;
  initialColor: AmbColor;
  existingNames: string[];
  onSubmit: (name: string, color: AmbColor) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState<AmbColor>(initialColor);

  const trimmed = name.trim();
  const dup = trimmed !== "" && existingNames.includes(trimmed);
  const canSubmit = trimmed !== "" && !dup;
  const submit = () => {
    if (!canSubmit) return;
    onSubmit(trimmed, color);
    onClose();
  };
  const titleKey = mode === "create" ? "global.newGroup" : "global.renameGroup";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t(titleKey)}</DialogTitle>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field data-invalid={dup || undefined}>
            <FieldLabel htmlFor="group-name">{t("global.groupNameLabel")}</FieldLabel>
            <Input
              id="group-name"
              autoFocus
              value={name}
              placeholder={t("global.groupNamePlaceholder")}
              aria-invalid={dup}
              aria-describedby={dup ? "group-name-error" : undefined}
              onChange={(e) => setName(e.target.value)}
            />
            {dup && <FieldError id="group-name-error">{t("global.dupGroupName")}</FieldError>}
          </Field>
          <Field>
            <FieldTitle>{t("shared.cardColor")}</FieldTitle>
            <Swatches
              value={color}
              onChange={(c) => {
                if (c) setColor(c);
              }}
              label={t("shared.cardColor")}
            />
            <FieldDescription>{t("global.cardColorHint")}</FieldDescription>
          </Field>

          {/* 实时预览：分区头 + 两行样例卡，跟色卡同色（data-amb 驱动 .side-sec 的 --amb/--tintc） */}
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] tracking-[0.16em] text-muted-foreground/70 uppercase">
              {t("global.preview")}
            </span>
            <div className="pointer-events-none rounded-md bg-background p-2" aria-hidden="true">
              <section
                data-amb={color}
                className="side-sec rounded-lg border-t border-sidebar-border px-2 pt-2 pb-3"
              >
                <SectionHead
                  icon={Folder01Icon}
                  name={trimmed || t("global.previewGroup")}
                  sub={t("global.groupHint")}
                  count={PREVIEW_ROWS.length}
                />
                <div className="flex flex-col gap-1">
                  {PREVIEW_ROWS.map((r) => (
                    <div
                      key={r.key}
                      className="tint-card flex min-h-8 items-center gap-2 rounded-md px-2"
                    >
                      <HugeiconsIcon
                        icon={Link01Icon}
                        strokeWidth={1.75}
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-[color:var(--ink)]"
                      />
                      <span className="w-[21ch] flex-none truncate font-mono text-xs font-semibold tracking-wide text-foreground uppercase">
                        {r.key}
                      </span>
                      <span
                        className="shrink-0 font-mono text-xs text-muted-foreground/45"
                        aria-hidden="true"
                      >
                        =
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                        {r.value}
                      </span>
                      <span className="w-9 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                        {t("global.refCount", { count: r.refs })}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("fragments.cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {t(titleKey)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ——— 分组头右侧的「当前色 + ⌄」改色气泡（规格 E）———
// 点色卡即刻生效落盘（由调用方接线 onPick），气泡不关，方便连着试色。
// 静止时透明但仍在 Tab 序里（HEAD_ACTION）；气泡内容带 data-sec，焦点落进气泡时
// 所在分区照样算「正在交互」（页面的 useLit 靠它归组）。
export function GroupColorPicker({
  name,
  color,
  secId,
  onPick,
}: {
  name: string;
  color: AmbColor;
  /** 所在分区的 data-sec：气泡在 portal 里，带上它焦点才归得到分区 */
  secId: string;
  onPick: (color: AmbColor) => void;
}) {
  const { t } = useTranslation();
  const label = t("global.groupColorOf", { name });
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        title={label}
        className={cn(
          "flex size-8 cursor-pointer items-center justify-center gap-1 rounded-[min(var(--radius-md),10px)] outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted",
          HEAD_ACTION,
        )}
      >
        <span className={cn("block size-3.5 rounded-[27.5%]", SWATCH_BG[color])} aria-hidden="true" />
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          aria-hidden="true"
          className="size-3 text-muted-foreground/70"
        />
      </PopoverTrigger>
      <PopoverContent data-sec={secId} align="end" className="p-2">
        <div className="flex items-center gap-1.5 px-0.5 pb-2 text-xs text-muted-foreground">
          <span
            className={cn("block size-3 shrink-0 rounded-[27.5%]", SWATCH_BG[color])}
            aria-hidden="true"
          />
          <span className="max-w-48 truncate">{label}</span>
        </div>
        <Swatches
          value={color}
          onChange={(c) => {
            if (c) onPick(c);
          }}
          label={label}
        />
      </PopoverContent>
    </Popover>
  );
}
